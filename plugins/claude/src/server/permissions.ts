import { askForTurn, type TurnAnswer } from "@tokamak/sdk/agent-turn";
import type { Run } from "plugin:ai/contracts";
import { describeTool } from "./events";
import type { Frame, Json, ToolRequest } from "./wire";

type Allowance = {
  type: "addRules";
  rules: { toolName: string; ruleContent: string }[];
  behavior: "allow";
  destination: "session";
};

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => [key, ordered(v)]),
  );
}

function grantKey(request: ToolRequest, { kind, target }: ReturnType<typeof describeTool>) {
  const name = request.tool_name;
  if (name === "WebFetch" && target) {
    try {
      target = new URL(target).hostname || undefined;
    } catch {
      target = undefined;
    }
  }
  // Search patterns can be reused against unrelated folders. For tools with
  // no command, path or domain grant, require exactly the same request.
  const scope =
    name === "WebFetch" || kind === "command" || kind === "edit" || kind === "read" ? target : undefined;
  return JSON.stringify([name, scope || ordered(request.input)]);
}

function sessionRule(request: ToolRequest): Allowance | undefined {
  const command = request.input.command;
  // Use Claude's own exact Bash suggestion, but never apply localSettings,
  // directory grants or permission mode changes. Wildcard rules would exceed
  // the command the person approved.
  if (request.tool_name !== "Bash" || typeof command !== "string" || /[*?\\]/.test(command)) return;
  const allowed = request.permission_suggestions?.some((entry) => {
    const rule = entry as Partial<Allowance> | null;
    return (
      rule?.type === "addRules" &&
      rule.behavior === "allow" &&
      rule.rules?.length === 1 &&
      rule.rules[0].toolName === "Bash" &&
      rule.rules[0].ruleContent === command
    );
  });
  if (allowed)
    return {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: command }],
      behavior: "allow",
      destination: "session",
    };
}

export class Permissions {
  readonly #pending = new Set<string>();
  readonly #run: Run;
  readonly #send: (message: Json) => void;
  readonly stoppedTools = new Set<string>();
  #closed = false;
  #cancelSent = false;

  constructor(run: Run, send: (message: Json) => void) {
    this.#run = run;
    this.#send = send;
  }

  get cancelSent() {
    return this.#cancelSent;
  }

  get waiting() {
    return this.#pending.size > 0;
  }

  close() {
    this.#closed = true;
    this.#pending.clear();
  }

  frame(message: Frame) {
    const id = message.request_id;
    if (!id || this.#closed) return;
    if (message.type === "control_cancel_request") this.#pending.delete(id);
    if (message.type !== "control_request") return;
    const request = message.request;
    if (request?.subtype !== "can_use_tool" || !request.input || typeof request.tool_name !== "string") {
      throw new Error("Claude sent an unsupported control request.");
    }
    this.#pending.add(id);
    void this.#answer(id, request);
  }

  async #answer(id: string, request: ToolRequest) {
    const response = await this.#choice(request).catch(() => "decline" as const);
    if (!this.#pending.delete(id) || this.#closed) return;
    const allow = response === "approve" || response === "approveSession";
    const cancel = response === "cancel" || response === "stopping";
    // Claude can report the rejected tool before the separate Stop callback.
    // Leave that tool running so ai closes it with the stopped turn.
    if (response === "stopping" && request.tool_use_id) this.stoppedTools.add(request.tool_use_id);
    const grant = response === "approveSession" ? sessionRule(request) : undefined;
    this.#send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: id,
        response: allow
          ? { behavior: "allow", updatedInput: request.input, ...(grant && { updatedPermissions: [grant] }) }
          : { behavior: "deny", message: "Declined by the user.", ...(cancel && { interrupt: true }) },
      },
    });
    if (cancel) this.#cancelSent = true;
  }

  async #choice(request: ToolRequest): Promise<TurnAnswer> {
    // AskUserQuestion needs real text input. The contract only offers
    // permission answers, so decline it rather than invent a user's answer.
    if (request.tool_name === "AskUserQuestion") return "decline";
    if (this.#run.access === "full") return request.tool_name === "ExitPlanMode" ? "approve" : "decline";

    const tool = describeTool(request.tool_name, request.input);
    // ai keeps session grants by kind. Scope this one to the action that was
    // shown and don't save raw tool arguments as a permission key.
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(grantKey(request, tool)));
    if (this.#closed) return "decline";
    return askForTurn(this.#run, {
      kind: `${request.tool_name}:${Buffer.from(hash).toString("hex")}`,
      action: tool.action,
      subject: request.tool_name === "ExitPlanMode" ? "the proposed plan" : tool.title,
    });
  }
}
