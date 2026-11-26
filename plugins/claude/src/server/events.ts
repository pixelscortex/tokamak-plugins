import type { Run, Helper, StepState, Task, Tool, Usage } from "plugin:ai/contracts";
import type { Block, Frame, Json } from "./wire";

type TextKind = "text" | "thinking";
type TextBlock = { index: number; kind: TextKind; sent: string };
type PendingTool = { tool: Tool; name: string; input: Json };

const asText = (value: unknown) => (typeof value === "string" ? value : undefined);
const stateOf = (status: unknown): Task["state"] =>
  status === "completed" ? "done" : status === "in_progress" ? "running" : "pending";

type ToolSpec = { kind: Tool["kind"]; key?: string; action: string };
const toolSpecs: Record<string, ToolSpec> = {
  Bash: { kind: "command", key: "command", action: "run" },
  Read: { kind: "read", key: "file_path", action: "read" },
  Edit: { kind: "edit", key: "file_path", action: "edit" },
  Write: { kind: "edit", key: "file_path", action: "edit" },
  MultiEdit: { kind: "edit", key: "file_path", action: "edit" },
  NotebookEdit: { kind: "edit", key: "notebook_path", action: "edit" },
  Grep: { kind: "search", key: "pattern", action: "search" },
  Glob: { kind: "search", key: "pattern", action: "search" },
  WebFetch: { kind: "web", key: "url", action: "fetch" },
  WebSearch: { kind: "web", key: "query", action: "search" },
  ExitPlanMode: { kind: "other", action: "apply" },
};

export function describeTool(name: string, input: Json) {
  const { kind, key, action }: ToolSpec = Object.hasOwn(toolSpecs, name)
    ? toolSpecs[name]
    : { kind: "other", action: "use" };
  const target = key === undefined ? undefined : asText(input[key]);
  return { kind, action, title: target ?? name, target };
}

function textResult(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return;
  return content.flatMap((part: Block) => (part?.type === "text" && part.text ? [part.text] : [])).join("\n");
}

export class ReplyEvents {
  readonly #run: Run;
  readonly #stoppedTools: ReadonlySet<string>;
  readonly #tools = new Map<string, PendingTool>();
  readonly #toolUses = new Set<string>();
  readonly #helpers = new Map<string, Helper>();
  readonly #tasks = new Map<string, Task>();
  #toolErrors: Block[] = [];
  #blocks: TextBlock[] = [];
  #messageId?: string;
  #streaming = false;
  #plan?: string;
  #hasText = false;
  #hasResultText = false;
  #textTail = "";
  #separateText = false;
  #hasThinking = false;
  #usage: Usage = { inputTokens: 0, outputTokens: 0 };

  constructor(run: Run, stoppedTools: ReadonlySet<string>) {
    this.#run = run;
    this.#stoppedTools = stoppedTools;
  }

  get canInterrupt() {
    return this.#streaming && this.#toolUses.size === 0;
  }

  steered() {
    this.#separateText = this.#hasText;
  }

  #text(value: string) {
    this.#hasResultText = true;
    // Hold trailing newlines until the next text so a steered reply can use
    // exactly one blank line, even when either side supplies its own newlines.
    const first = value.search(/[^\n]/);
    if (first < 0) {
      if (!this.#separateText) this.#textTail += value;
      return;
    }
    let end = value.length;
    while (value[end - 1] === "\n") end--;
    const prefix = this.#separateText ? "\n\n" : this.#textTail;
    this.#run.text(prefix + value.slice(this.#separateText ? first : 0, end));
    this.#textTail = value.slice(end);
    this.#separateText = false;
    this.#hasText = true;
  }

  #blockDelta(kind: TextKind, value: string, alreadySent = "") {
    if (!value) return;
    if (kind === "text") {
      this.#text(value);
      return;
    }
    if (!alreadySent && this.#hasThinking) {
      // Separate distinct thinking blocks without changing their deltas.
      this.#run.thinking("\n\n");
    }
    this.#hasThinking = true;
    this.#run.thinking(value);
  }

  #stream(event: NonNullable<Frame["event"]>) {
    if (event.type === "message_start") {
      this.#messageId = event.message?.id;
      this.#blocks = [];
      this.#streaming = false;
    } else if (event.type === "content_block_start" && typeof event.index === "number") {
      const part = event.content_block;
      if (!part) return;
      const kind = part.type;
      if (kind === "tool_use" && part.id) this.#toolUses.add(part.id);
      if (kind !== "text" && kind !== "thinking") return;
      const sent = part[kind] ?? "";
      this.#blocks.push({ index: event.index, kind, sent });
      this.#streaming = !!sent;
      this.#blockDelta(kind, sent);
    } else if (event.type === "content_block_delta") {
      const block = this.#blocks.find((block) => block.index === event.index);
      const delta = event.delta;
      if (!block || delta?.type !== `${block.kind}_delta`) return;
      const value = delta[block.kind] ?? "";
      if (value) this.#streaming = true;
      this.#blockDelta(block.kind, value, block.sent);
      block.sent += value;
    } else if (event.type === "content_block_stop" || event.type === "message_stop") {
      this.#streaming = false;
    }
  }

  #completeBlock(part: Block, messageId?: string) {
    const kind = part.type;
    if (kind === "tool_use") this.#tool(part);
    if (kind !== "text" && kind !== "thinking") return;
    const value = part[kind];
    if (!value) return;
    // Claude sends canonical blocks as separate assistant messages, even when
    // they share the same message id. Emit only the part not already streamed.
    const i =
      messageId === this.#messageId
        ? this.#blocks.findIndex((block) => block.kind === kind && value.startsWith(block.sent))
        : -1;
    const [streamed] = i === -1 ? [] : this.#blocks.splice(i, 1);
    this.#blockDelta(kind, value.slice(streamed?.sent.length ?? 0), streamed?.sent);
  }

  #tool(part: Block) {
    if (!part.id || !part.name || this.#tools.has(part.id) || this.#helpers.has(part.id)) return;
    this.#toolUses.add(part.id);
    const input = part.input ?? {};
    if (part.name === "Agent" || part.name === "Task") {
      const name = asText(input.subagent_type) ?? "Agent";
      const helper: Helper = {
        id: part.id,
        name,
        title: asText(input.description) ?? name,
        state: "running",
      };
      this.#helpers.set(part.id, helper);
      this.#run.helper(helper);
      return;
    }
    const { kind, title } = describeTool(part.name, input);
    const tool: Tool = { id: part.id, kind, title, state: "running" };
    this.#tools.set(part.id, { tool, name: part.name, input });
    this.#run.tool(tool);
    if (part.name === "ExitPlanMode") this.plan(input.plan);
  }

  #toolResult(part: Block) {
    if (!part.tool_use_id) return;
    const id = part.tool_use_id;
    this.#toolUses.delete(id);
    if (part.is_error && this.#stoppedTools.has(id)) return;
    const state: StepState = part.is_error ? "failed" : "done";
    const pending = this.#tools.get(id);
    if (pending) {
      this.#tools.delete(id);
      this.#run.tool({ ...pending.tool, state });
      if (!part.is_error) this.#taskList(pending, part);
    } else if (this.#helpers.has(id)) this.#helper(id, state, textResult(part.content));
  }

  #helper(id: string, state: StepState, text?: string) {
    const helper = this.#helpers.get(id);
    if (!helper) return;
    const changed = { ...helper, state, ...(text && { text }) };
    this.#helpers.set(id, changed);
    this.#run.helper(changed);
  }

  #taskList({ name, input }: PendingTool, part: Block) {
    if (name === "TodoWrite" && Array.isArray(input.todos)) {
      this.#run.tasks(
        input.todos.flatMap((todo: Json) =>
          typeof todo?.content === "string" ? [{ text: todo.content, state: stateOf(todo.status) }] : [],
        ),
      );
    } else if (name === "TaskCreate" && typeof input.subject === "string") {
      const taskId = textResult(part.content)?.match(/Task #(\S+) created/)?.[1];
      if (taskId) this.#tasks.set(taskId, { text: input.subject, state: "pending" });
      this.#run.tasks([...this.#tasks.values()]);
    } else if (name === "TaskUpdate" && typeof input.taskId === "string") {
      this.#updateTask(input.taskId, input);
    }
  }

  #updateTask(id: string, input: Json) {
    const previous = this.#tasks.get(id);
    if (input.status === "deleted") this.#tasks.delete(id);
    else if (previous)
      this.#tasks.set(id, {
        text: asText(input.subject) ?? previous.text,
        state: input.status ? stateOf(input.status) : previous.state,
      });
    this.#run.tasks([...this.#tasks.values()]);
  }

  plan(value: unknown) {
    if (typeof value !== "string" || !value || value === this.#plan) return;
    this.#plan = value;
    this.#run.plan(value);
  }

  result(frame: Frame, interruption: "stop" | "steer" | undefined, final: boolean) {
    this.#streaming = false;
    // A tool can start between our last stream frame and the CLI receiving
    // the interrupt. Settle those steps as we would for Stop.
    if (interruption === "steer" && frame.terminal_reason === "aborted_tools") {
      for (const { tool } of this.#tools.values()) this.#run.tool({ ...tool, state: "done" });
      this.#tools.clear();
      for (const id of this.#toolUses) {
        if (this.#helpers.get(id)?.state === "running") this.#helper(id, "done");
      }
    } else if (interruption !== "stop") {
      for (const part of this.#toolErrors) this.#toolResult(part);
    }
    this.#toolErrors = [];
    this.#toolUses.clear();
    if (frame.usage) this.#reportUsage(frame.usage, frame.total_cost_usd);
    if (!interruption && !frame.is_error && !this.#hasResultText && frame.result) this.#text(frame.result);
    this.#hasResultText = false;
    if (final && this.#textTail) this.#run.text(this.#textTail);
  }

  #reportUsage(usage: NonNullable<Frame["usage"]>, cost?: number) {
    const count = (value: number | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? value : 0;
    const cacheRead = count(usage.cache_read_input_tokens);
    const input = count(usage.input_tokens) + cacheRead + count(usage.cache_creation_input_tokens);
    // A steer can produce another result in this process. Claude resets token
    // counts per result, but total_cost_usd already includes earlier results.
    const costUsd = cost ?? this.#usage.costUsd;
    this.#usage = {
      inputTokens: this.#usage.inputTokens + input,
      outputTokens: this.#usage.outputTokens + count(usage.output_tokens),
      ...(cacheRead > 0 || this.#usage.cachedInputTokens !== undefined
        ? { cachedInputTokens: (this.#usage.cachedInputTokens ?? 0) + cacheRead }
        : {}),
      ...(costUsd === undefined ? {} : { costUsd }),
    };
    this.#run.usage(this.#usage);
  }

  frame(frame: Frame, steerInterrupt: boolean) {
    // Helper dialogue and tool output stay out of the main reply.
    if (frame.parent_tool_use_id) return;
    if (frame.type === "stream_event" && frame.event) this.#stream(frame.event);
    if (frame.type === "assistant" || frame.type === "user") this.#message(frame, steerInterrupt);
    if (frame.type === "system") this.#system(frame);
  }

  #system(frame: Frame) {
    if (frame.subtype === "task_notification" && frame.tool_use_id) {
      const text = this.#helpers.get(frame.tool_use_id)?.text ?? frame.summary;
      this.#helper(frame.tool_use_id, frame.status === "completed" ? "done" : "failed", text);
    }
  }

  #message(frame: Frame, steerInterrupt: boolean) {
    const { message, type } = frame;
    if (!Array.isArray(message?.content)) return;
    for (const part of message.content) {
      if (type === "assistant") this.#completeBlock(part, message.id);
      else if (part.type === "tool_result") {
        if (steerInterrupt && part.is_error) this.#toolErrors.push(part);
        else this.#toolResult(part);
      }
    }
  }
}
