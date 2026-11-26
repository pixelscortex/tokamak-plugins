import { contract, type Failure, type Id, type JsonValue, type CallerActionContext } from "@tokamak/sdk";

import type { LaunchSettings, Run, TurnResult } from "@tokamak/sdk/agent-turn";
export type {
  Access,
  Answer,
  Helper,
  HistoryMessage,
  LaunchSettings,
  Question,
  Run,
  StepState,
  Task,
  Tool,
  TurnResult,
  Usage,
} from "@tokamak/sdk/agent-turn";

/**
 * What an agent plugin (`claude`, `codex`, a test fake) tells the agent row,
 * in one answer because the pickers need it together. Asked again every time
 * the row looks, so a fresh install or sign-in shows without a restart.
 */
export interface Info {
  readonly installed: boolean;
  readonly signedIn: boolean;
  /** A successful probe may be reused for turns until this wall clock time. */
  readonly cacheUntil?: number;
  /** A user-facing reason when the installed program needs an update. */
  readonly updateRequired?: string;
  /** The command that installs the agent's program; kept for a later one-click install. */
  readonly install: string;
  /** The command that signs the program in. */
  readonly signIn: string;
  /**
   * The first model is the default. A model's `efforts` are the agent row's
   * Level picker (e.g. "low", "high").
   */
  readonly models: readonly {
    readonly id: string;
    /**
     * As people see it, without the agent's name: "Fable 5.2", not "Claude
     * Fable 5.2". The window drops a leading agent name anyway.
     */
    readonly name: string;
    readonly efforts: readonly string[];
    /** This model's own mark, when it differs from the agent's `icon`; same format. */
    readonly icon?: string;
  }[];
  /** The agent row's Speed picker (e.g. "standard", "fast"). */
  readonly speeds: readonly string[];
  /**
   * The agent row's Mode picker, a way of working other than speed (e.g.
   * Codex's "default" and "plan"). Most agents offer none.
   */
  readonly modes: readonly string[];
  // For efforts, speeds and modes alike: the first is the default, and an
  // empty list hides that picker.
}

export interface Agent {
  /** Stable id, recorded on each turn ("claude", "codex"). */
  readonly id: string;
  /** What a person sees: "Claude", "Codex". No persona names. */
  readonly name: string;
  /**
   * The agent's mark, shown in the agent row, above its replies and in the
   * thread list: an SVG document with a 24 × 24 viewBox whose paths are
   * painted in `currentColor` (the LobeHub mono icons are this shape). Only
   * the paths' outlines are drawn. Without one, a neutral mark stands in.
   */
  readonly icon?: string;
  /** With a setup deadline (Unix milliseconds), check install and login only. Throw if unknown. */
  info(options: { setupDeadline?: number; launchSettings?: LaunchSettings }): Promise<Info>;
  /** Runs one turn to its end and reports its outcome. */
  start(run: Run): Promise<TurnResult>;
}

/**
 * The agent contract. QuickJS adapts the provider's Run to plain data across
 * processes. Agent plugins provide it as caller actions:
 *
 * ```ts
 * import * as ai from "plugin:ai/contracts";
 * const info = action({
 *   on: "caller", handler: async (ctx): Promise<ai.Info> => ({ ... }) });
 * const start = action({
 *   on: "caller", handler: async (ctx, run: ai.Run) => { run.text("Hi"); return { sessionId } } });
 * export default provide(ai.agent, { id: "codex", name: "Codex", info, start });
 * ```
 */
export const agent = contract<Agent>("agent", { on: "caller", dataMethods: true });

/** The turn and the signal for the hook currently handling it. */
export interface TurnInfo {
  readonly threadId: Id<"threads">;
  readonly turnId: string;
  readonly folder: string;
  /** Aborted when this hook is cancelled; use it to stop work. */
  readonly signal: CallerActionContext["signal"];
}

export interface TurnHooks {
  /** Optional notice when this provider runs past the shared after deadline. */
  readonly afterTimeoutNotice?: string;
  /** Runs before the agent starts. A failure, exception or timeout prevents the agent from starting. */
  before?(turn: TurnInfo): Promise<void | Failure<string, JsonValue>>;
  /** Runs after the agent settles. Errors and timeouts are notices; they never change its outcome. */
  after?(turn: TurnInfo): Promise<void>;
}

/** Local hooks around a turn, called with a 60-second limit before the thread is freed. */
export const turnHooks = contract<TurnHooks>("turnHooks", { on: "caller", dataMethods: true });
