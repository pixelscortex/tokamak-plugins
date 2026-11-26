import type { CallerActionContext, RunningProcess } from "@tokamak/sdk";
import { agentCommand } from "@tokamak/sdk/agent-turn";

export const minimumVersion = "2.1.330";
export const speeds = { standard: "Standard", fast: "Fast" } as const;

export interface Model {
  value: string;
  displayName: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

export type Json = Record<string, unknown>;

export interface Block {
  type: string;
  id?: string;
  name?: string;
  text?: string;
  thinking?: string;
  input?: Json;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface ToolRequest {
  subtype: "can_use_tool";
  tool_name: string;
  tool_use_id?: string;
  description?: string;
  decision_reason?: string;
  blocked_path?: string;
  input: Json;
  permission_suggestions?: unknown[];
}

export interface Frame {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  isReplay?: boolean;
  event?: {
    type: string;
    index?: number;
    message?: { id: string };
    content_block?: Block;
    delta?: { type: string; text?: string; thinking?: string };
  };
  message?: { id?: string; content: Block[] | string; role?: string };
  response?: {
    subtype: string;
    request_id: string;
    response?: { models?: Model[]; fast_mode_state?: string };
    error?: string;
  };
  request_id?: string;
  request?: ToolRequest;
  tool_use_id?: string;
  status?: string;
  summary?: string;
  terminal_reason?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
}

export function parse(line: string): Frame | undefined {
  try {
    const value = JSON.parse(line) as Partial<Frame> | null;
    return typeof value?.type === "string" ? (value as Frame) : undefined;
  } catch {
    // Some CLI errors are a plain stdout line instead of JSON.
    return undefined;
  }
}

export function streamArgs(): string[] {
  // oxfmt-ignore
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
  ];
}

export function killAfter(proc: RunningProcess, ms: number) {
  const timer = setTimeout(() => proc.stop("SIGKILL"), ms);
  return () => clearTimeout(timer);
}

export function open(
  ctx: CallerActionContext,
  args: string[],
  cwd?: string,
  env?: Readonly<Record<string, string>>,
) {
  // Preserve the client environment so Claude can find its executable,
  // settings and existing Keychain or file login.
  const proc = ctx.proc(["claude", ...args], { cwd, ...(env && { env }) });
  const exited = proc.exited.catch(() => 127);
  // Both streams must drain, even on installs whose hooks write to stderr.
  void (async () => {
    for await (const _ of proc.stderr) {
      /* never log raw CLI diagnostics or credentials */
    }
  })().catch(() => {});
  const send = (message: Json) => proc.write(JSON.stringify(message) + "\n");
  const control = (subtype: string) => {
    const request_id = crypto.randomUUID();
    send({ type: "control_request", request_id, request: { subtype } });
    return request_id;
  };
  async function close() {
    proc.closeInput();
    const cancelKill = killAfter(proc, 2_000);
    try {
      await exited;
    } finally {
      cancelKill();
    }
  }
  return { proc, exited, send, control, close };
}

export async function usableVersion(
  ctx: CallerActionContext,
  timeout = 5_000,
  env?: Readonly<Record<string, string>>,
) {
  const answer = await agentCommand(ctx, ["claude", "--version"], timeout, env);
  if (answer === "missing") return answer;
  if (answer?.code !== 0) return;
  const version = answer.stdout.match(/(?:^|[^\w])v?(\d+\.\d+\.\d+)\b/i)?.[1];
  if (!version) return;
  const actual = version.split(".").map(Number);
  const minimum = minimumVersion.split(".").map(Number);
  const diff = actual.findIndex((part, index) => part !== minimum[index]);
  return diff === -1 || actual[diff] > minimum[diff] ? "ready" : "old";
}

export async function signedIn(ctx: CallerActionContext, timeout = 5_000): Promise<boolean | undefined> {
  const answer = await agentCommand(ctx, ["claude", "auth", "status"], timeout);
  if (!answer || answer === "missing") return;
  try {
    const { loggedIn, loginExpiresAt } = JSON.parse(answer.stdout);
    // Claude reports an explicit logout with exit 1.
    if (loggedIn === false && (answer.code === 0 || answer.code === 1)) return false;
    if (loggedIn !== true || answer.code !== 0) return;
    // Current Unix seconds fit in ten digits; even a millisecond deadline
    // from the year 2000 is longer than that.
    const timestamp =
      typeof loginExpiresAt === "number"
        ? loginExpiresAt < 1e10
          ? loginExpiresAt * 1_000
          : loginExpiresAt
        : typeof loginExpiresAt === "string"
          ? Date.parse(loginExpiresAt)
          : NaN;
    return !Number.isFinite(timestamp) || timestamp > Date.now();
  } catch {
    // Unrecognized or absent output says nothing about the login.
  }
}
