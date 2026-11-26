import type { CallerActionContext } from "@tokamak/sdk";
import type { Run, TurnResult } from "plugin:ai/contracts";
import { ReplyEvents } from "./events";
import { Permissions } from "./permissions";
import { killAfter, open, parse, speeds, streamArgs, type Frame } from "./wire";

class MissingSession extends Error {}

function launchArgs(run: Run, resume?: string) {
  const fastMode = run.speed === speeds.fast ? true : run.speed === speeds.standard ? false : undefined;
  const settings = { env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" }, fastMode };
  // oxfmt-ignore
  return [
    ...(run.launchSettings?.args ?? []),
    ...streamArgs(),
    "--include-partial-messages",
    "--replay-user-messages",
    "--permission-prompt-tool", "stdio",
    "--permission-mode", run.access === "full" ? "bypassPermissions" : "manual",
    "--thinking-display", "summarized",
    "--settings", JSON.stringify(settings),
    ...(run.model && run.model !== "default" ? ["--model", run.model] : []),
    ...(run.effort ? ["--effort", run.effort] : []),
    ...(resume ? ["--resume", resume] : []),
    ...(run.launchSettings ? ["--setting-sources", "project,local"] : []),
  ];
}

function prompt(run: Run, resume?: string) {
  if (resume || !run.history.length) return run.prompt;
  return [
    { type: "text", text: `Earlier messages in this thread (for context):\n${JSON.stringify(run.history)}` },
    { type: "text", text: run.prompt },
  ];
}

function resultError(message: Frame) {
  return (
    message.errors?.find((error) => !error.startsWith("[ede_diagnostic]")) ??
    (message.result || "Claude did not finish its reply.")
  );
}

function isInterrupted(message: Frame) {
  return message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools";
}

export async function turn(
  ctx: CallerActionContext,
  run: Run,
  env?: Readonly<Record<string, string>>,
): Promise<TurnResult> {
  const lifecycle = new Turn(ctx, run, env);
  try {
    try {
      return await lifecycle.play(run.sessionId);
    } catch (error) {
      if (!(error instanceof MissingSession) || lifecycle.stopping) throw error;
      run.sessionChanged(undefined);
      return await lifecycle.play();
    }
  } finally {
    lifecycle.finish();
  }
}

class Turn {
  readonly #ctx: CallerActionContext;
  readonly #run: Run;
  readonly #env?: Readonly<Record<string, string>>;
  #wire?: ReturnType<typeof open>;
  #permissions?: Permissions;
  #reports?: ReplyEvents;
  #pending = new Set<string>();
  #steerInterrupt = false;
  #steers: string[] = [];
  #ready = false;
  #done = false;
  #sessionId?: string;
  stopping = false;

  constructor(ctx: CallerActionContext, run: Run, env?: Readonly<Record<string, string>>) {
    this.#ctx = ctx;
    this.#run = run;
    this.#env = env;
    run.onSteer((text) => {
      if (this.#done || this.stopping) return;
      if (!this.#ready) {
        this.#steers.push(text);
        return;
      }
      // A second steer queues while the interrupt settles. Interrupt again
      // only once Claude is streaming another reply, so it gets to start.
      if (
        !this.#steerInterrupt &&
        this.#reports?.canInterrupt &&
        !this.#permissions?.waiting &&
        !this.#permissions?.cancelSent
      ) {
        this.#steerInterrupt = true;
        this.#wire?.control("interrupt");
      }
      this.#user(text, this.#sessionId ?? "", true);
    });
    run.onStop(() => {
      if (this.#done || this.stopping) return;
      this.stopping = true;
      this.#permissions?.close();
      if (this.#ready) this.#wire?.control("interrupt");
    });
  }

  #user(content: ReturnType<typeof prompt>, session_id: string, steer = false) {
    const uuid = crypto.randomUUID();
    if (steer) this.#pending.add(uuid);
    this.#wire?.send({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id,
      uuid,
    });
  }

  async play(resume?: string): Promise<TurnResult> {
    this.#ready = false;
    this.#sessionId = resume;
    this.#pending.clear();
    this.#steerInterrupt = false;
    const run = this.#run;
    const wire = open(this.#ctx, launchArgs(run, resume), run.folder, this.#env);
    this.#wire = wire;
    const permissions = new Permissions(run, wire.send);
    this.#permissions = permissions;
    const reports = new ReplyEvents(run, permissions.stoppedTools);
    this.#reports = reports;
    const init = wire.control("initialize");
    // A CLI that cannot initialize should fail promptly.
    const cancelKill = killAfter(wire.proc, 15_000);
    try {
      for await (const line of wire.proc.stdout) {
        const frame = parse(line);
        if (!frame) continue;
        if (frame.session_id && frame.session_id !== this.#sessionId) {
          this.#sessionId = frame.session_id;
          run.sessionChanged(frame.session_id);
        }
        if (frame.type === "control_response" && frame.response?.request_id === init) {
          if (frame.response.subtype !== "success") throw new Error("Claude could not initialize.");
          cancelKill();
          this.#start(resume);
        } else if (frame.type === "result") {
          const done = this.#result(frame, reports, permissions.cancelSent, resume);
          if (done) return done;
        } else this.#report(frame, reports, permissions);
      }
      throw new Error(`Claude quit before finishing its reply (exit ${await wire.exited}).`);
    } finally {
      cancelKill();
      this.#ready = false;
      permissions.close();
      await wire.close();
    }
  }

  #report(frame: Frame, reports: ReplyEvents, permissions: Permissions) {
    // A steer can join the current turn (echo before its result) or queue a
    // follow-up (echo after the result). Don't close while an echo is pending.
    if (this.stopping) return;
    if (frame.type === "user" && frame.isReplay && frame.uuid && this.#pending.delete(frame.uuid))
      reports.steered();
    if (frame.type === "control_request" && frame.request?.tool_name === "ExitPlanMode") {
      reports.plan(frame.request.input?.plan);
    }
    permissions.frame(frame);
    reports.frame(frame, this.#steerInterrupt);
  }

  #start(resume?: string) {
    if (this.#ready) return;
    this.#ready = true;
    this.#user(prompt(this.#run, resume), "");
    if (this.stopping) this.#wire?.control("interrupt");
    else for (const text of this.#steers.splice(0)) this.#user(text, this.#sessionId ?? "", true);
  }

  #result(
    frame: Frame,
    reports: ReplyEvents,
    cancelRequested: boolean,
    resume?: string,
  ): TurnResult | undefined {
    if (
      resume &&
      !this.#ready &&
      frame.is_error &&
      frame.errors?.includes(`No conversation found with session ID: ${resume}`)
    ) {
      throw new MissingSession();
    }
    // A Cancel answer requests an interruption; Claude can still continue to reply.
    const interrupted = isInterrupted(frame);
    const stopped = this.stopping || (cancelRequested && interrupted);
    // The old reply may have finished before the interrupt arrived. In that
    // case its success still counts, and the pending echo holds the turn open.
    const steered = this.#steerInterrupt && interrupted && !stopped;
    this.#steerInterrupt = false;
    const final = stopped || (!steered && (!!frame.is_error || this.#pending.size === 0));
    reports.result(frame, stopped ? "stop" : steered ? "steer" : undefined, final);
    if (!final) return;
    if (frame.is_error && !stopped) throw new Error(resultError(frame));
    if (!this.#sessionId) throw new Error("Claude finished without a session ID.");
    return { sessionId: this.#sessionId, ...(stopped && { stopped: true }) };
  }

  finish() {
    this.#done = true;
    this.#wire = undefined;
    this.#permissions = undefined;
    this.#reports = undefined;
  }
}
