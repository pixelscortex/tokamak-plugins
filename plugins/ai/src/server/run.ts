/// <reference types="node" />
import { createHash, randomBytes } from "node:crypto";
import {
  fail,
  isFailure,
  action,
  point,
  v,
  type ArgsOf,
  type Id,
  type Infer,
  type CallerActionContext,
} from "@tokamak/sdk";
import { hasLocalChannel } from "@tokamak/sdk/agent-turn";
import { agent, type LaunchSettings, type Run, type Usage } from "../contracts";
import { errorText, hookRunnerUpdate, setupReason } from "../shared/turn-shared";
import { controlFor, noRunningTurn, turnControl } from "./controls";
import { api } from "./_generated/api";
import { offered } from "../shared/offered";
import { infoAfterStartFailure, infoOf } from "./agents";
import { ownedAgentLaunchArg } from "./launch-args";
import { startAgent } from "./agent-turn";
import {
  append,
  check,
  checkedHelper,
  checkedTasks,
  checkedText,
  checkedTool,
  checkedUsage,
  fit,
  jsonBytes,
  PLAN_BYTES,
  TEXT_BYTES,
  WRITE_BYTES,
} from "./limits";
import { asking, pendingQuestion, sessionKey, settle } from "./questions";
import { access, answer as answerValue, type stepReport } from "./schema";
import { keepAlive } from "./keep-alive";
import { hooksFor } from "./turn-hooks";
import { windowKey, workingOn } from "./working";

import { RELOADED } from "../shared/turn-timing";

const turnArgs = {
  windowId: v.string(),
  threadId: v.id("threads"),
  messageId: v.string(),
  replyToken: v.optional(v.string()),
  /** The thread's folder on this computer, from chat's `onSent`. */
  folder: v.string(),
  agentId: v.string(),
  /** The model picked in the agent row; the agent's first model when absent or gone. */
  model: v.optional(v.string()),
  /** The level; the model's first when absent or not offered. */
  effort: v.optional(v.string()),
  /** The speed; the agent's first when absent or not offered. */
  speed: v.optional(v.string()),
  /** The mode; the agent's first when absent or not offered. */
  mode: v.optional(v.string()),
  /** Every thread starts on Full access. */
  access: v.optional(access),
};
const turnInput = v.object(turnArgs);

/**
 * One turn, run on the sender's own computer: begin it (one writer per
 * thread), hand the message to the chosen agent's `start` (with the session to
 * carry on, or the thread's earlier messages for a fresh one), stream what it
 * reports into the reply, and settle it before releasing the thread. The
 * window calls this after each Send with the thread's choices; it returns
 * when the turn has ended.
 */
export const turn = action({
  on: "caller",
  args: turnArgs,
  handler: async (ctx, args) => {
    const launchId = randomBytes(32).toString("hex");
    let endedNotice: string | undefined;
    const result = await runTurn(ctx, args, launchId).finally(async () => {
      // A launch contribution can acquire resources even if another contribution fails.
      await point(ctx, "ended", { launchId }).catch((cause: unknown) => {
        endedNotice = hookRunnerUpdate(cause);
      });
    });
    return endedNotice && !isFailure(result) ? { ...result, ended: endedNotice } : result;
  },
});

async function runTurn(ctx: CallerActionContext, args: Infer<typeof turnInput>, launchId: string) {
  const { windowId, threadId, messageId, replyToken, folder, agentId, access, ...picked } = args;
  const owner = windowKey(ctx.auth, windowId);
  // The labels `turns:begin` records are checked here, against what the provider offers.
  const queued = await ctx.runQuery(api.turns.queuedForMessage, { messageId });
  const selectedAgent = queued?.agent.id ?? agentId;
  const wanted = queued ?? { ...picked, access };
  const provider = await agent.get(selectedAgent, ctx);
  if (!provider) return fail("NoAgent", { agentId: selectedAgent });
  const { settings: launchSettings, error: launchError } = await resolveLaunch(ctx, threadId, {
    agentId: provider.id,
    launchId,
    ...(wanted.model !== undefined && { model: wanted.model }),
  });
  let setupError: string | undefined;
  // The normal catalog checks the person's own login. An isolated turn
  // instead uses the choices from the window and lets its CLI validate them.
  // A queued turn keeps the settings it was queued with.
  let modelName: string | undefined;
  let choices = {
    model: wanted.model ?? "default",
    effort: wanted.effort,
    speed: wanted.speed,
    mode: wanted.mode,
  };
  if (!launchError) {
    try {
      const info = await infoOf(provider, true, launchSettings);
      if (!info.installed)
        return fail("NotInstalled", {
          agent: provider.name,
          ...(info.updateRequired && {
            updateRequired: redactLaunchError(info.updateRequired, launchSettings),
          }),
        });
      if (!info.signedIn) return fail("SignedOut", { agent: provider.name });
      if (!launchSettings) {
        const { model, effort, speed, mode } = offered(info, wanted);
        modelName = model?.name;
        choices = { model: model?.id ?? "default", effort, speed, mode };
      }
    } catch (cause) {
      setupError = errorText(cause);
    }
  }
  const { model, effort, speed, mode } = choices;
  const settings = {
    model,
    ...(effort !== undefined && { effort }),
    ...(speed !== undefined && { speed }),
    ...(mode !== undefined && { mode }),
    access: wanted.access ?? ("full" as const),
  };
  const begun = await ctx.runMutation(api.turns.begin, {
    threadId,
    messageId,
    ...(hasLocalChannel(provider) && { folder }),
    agent: { id: provider.id, name: provider.name },
    ...settings,
    ...(modelName !== undefined && { modelName }),
    replyToken: replyToken ?? randomBytes(32).toString("hex"),
  });
  if (isFailure(begun)) return begun;
  if ("state" in begun) {
    const failed: { turnId: typeof begun.turnId; state: "failed"; hookNotice?: string; ended?: string } =
      begun;
    return failed;
  }
  const { turnId, prompt, history } = begun;
  const sessionHome = launchSettings?.identity;
  const sessionId = begun.sessionHome === sessionHome ? begun.sessionId : undefined;
  const hooks = hooksFor(ctx, { threadId, turnId, folder });
  const writer = turnWriter(ctx, turnId);
  // The session this turn carries on (`turns:begin`: the thread's last turn was this agent's, on this
  // device), so "Always allow this session" answers hold across turns exactly while the session does.
  const questions = asking(ctx, {
    turnId,
    access: settings.access,
    owner,
    session: sessionKey(owner, threadId, provider.id),
    carried: sessionId,
  });
  // Stop answers a waiting question "cancel" first: an agent may wait for the answer before it stops.
  const control = turnControl(turnId, owner, questions.cancel, hooks.stopBefore);
  // From here until the turn is settled, the server hears from this computer (liveness.ts), and
  // quitting the app asks first (working.ts). Both are released however the turn ends.
  let lost: string | undefined;
  const loseTurn = (reason: string) => {
    if (!control.active) {
      hooks.skipAfter();
      return;
    }
    if (lost !== undefined) return;
    lost = reason;
    hooks.cancel(reason);
    void control.forceStop().catch(() => {});
  };
  const alive = keepAlive(ctx, turnId, loseTurn);
  const reloaded = () => loseTurn(RELOADED);
  ctx.retiring?.addEventListener("abort", reloaded, { once: true });
  if (ctx.retiring?.aborted) reloaded();
  const unregister = workingOn(turnId, {
    owner,
    threadId,
    agent: provider.name,
    control,
    skipAfter: hooks.skipAfter,
  });
  try {
    let ending: Pick<ArgsOf<typeof api.turns.finish>, "state" | "error" | "sessionId">;
    const beforeError = lost ?? launchError ?? setupError ?? (await hooks.before());
    const lostBefore = lost;
    if (lostBefore !== undefined) {
      ending = { state: "interrupted", error: lostBefore };
    } else if (hooks.stoppedBefore) {
      ending = { state: "stopped" };
    } else if (beforeError !== undefined) {
      ending = { state: "failed", error: beforeError };
    } else {
      try {
        // A write the server refused twice: stop the agent's programs now, as Force stop does.
        void writer.broke.then(() => control.forceStop()).catch(() => {});
        const input = {
          folder,
          prompt,
          ...settings,
          history,
          ...(launchSettings && { launchSettings }),
          ...(sessionId === undefined ? {} : { sessionId }),
        };
        const reports = { ...writer.reports, sessionChanged: questions.sessionChanged };
        const result = await startAgent(
          provider,
          { threadId, turnId, ...input },
          reports,
          questions,
          control,
        );
        ending = result
          ? {
              state: result.stopped ? "stopped" : "done",
              sessionId: result.sessionId,
            }
          : { state: "stopped" };
      } catch (cause) {
        const current =
          lost === undefined && !launchSettings ? await infoAfterStartFailure(provider) : undefined;
        ending = {
          state: "failed",
          error: (current && setupReason(provider.name, current)) ?? errorText(cause),
        };
      }
    }
    if (lost !== undefined) ending = { ...ending, state: "interrupted", error: lost };
    // A graceful interruption can still return the session and its existing grants.
    questions.end(ending.sessionId);
    control.finish();
    finishing.set(turnId, owner);
    await writer.settled();
    const broken = writer.close();
    // The turn did not reach the thread whole; the agent's session id is kept when it gave one.
    if (broken !== undefined && lost === undefined)
      ending = { ...ending, state: "failed", error: `Could not save the reply: ${errorText(broken)}` };
    if (ending.error !== undefined && !launchError)
      ending.error = redactLaunchError(ending.error, launchSettings);
    // Force stop only closes the agent's program scope. Run after hooks before releasing the queue.
    const notice =
      launchError || setupError !== undefined || (hooks.stoppedBefore && lostBefore === undefined)
        ? undefined
        : (lostBefore ?? beforeError ?? (lost === undefined ? await hooks.after() : hooks.notice()));
    const hookNotice = notice === undefined ? undefined : redactLaunchError(notice, launchSettings);
    let state;
    try {
      const acknowledgedSteer = control.acknowledgedSteer();
      state = await ctx.runMutation(api.turns.finish, {
        turnId,
        ...ending,
        ...(ending.sessionId !== undefined && sessionHome && { sessionHome }),
        finishedAt: Date.now(),
        ...(acknowledgedSteer === undefined ? {} : { acknowledgedSteer }),
      });
    } catch {
      // The server cannot be reached or already ended the turn; the interrupt rule frees the thread.
      // `ended` says why in the person's words when this computer had to stop the agent.
      return {
        turnId,
        state: "failed" as const,
        ...(hookNotice !== undefined && { hookNotice }),
        ...(lost !== undefined && { ended: lost }),
      };
    }
    return {
      turnId,
      state,
      ...(hookNotice !== undefined && { hookNotice }),
      ...(lost !== undefined && { ended: lost }),
    };
  } finally {
    ctx.retiring?.removeEventListener("abort", reloaded);
    control.close();
    finishing.delete(turnId);
    alive.stop();
    unregister();
  }
}

/** Collect a fresh snapshot before even probing the agent's CLI. */
async function resolveLaunch(
  ctx: CallerActionContext,
  threadId: string,
  request: { agentId: string; launchId: string; model?: string },
): Promise<{ settings?: LaunchSettings; error?: string }> {
  const { agentId } = request;
  try {
    const contributions = await point(
      ctx,
      "launch",
      { env: {}, args: [], request } as {
        env: Record<string, string>;
        args: string[];
        request?: { agentId: string; launchId: string; model?: string };
        blocked?: string;
        identity?: string;
        provider?: { baseUrl: string; keyEnv: string; key: string };
      },
      { collect: true },
    );
    const env = new Map<string, { plugin: string; name: string; value: string }>();
    const args: string[] = [];
    const contributors = new Map<string, string>();
    let provider: { plugin: string; value: NonNullable<LaunchSettings["provider"]> } | undefined;
    for (const { plugin, value } of contributions) {
      // The point validator checks the shape, but leaves index signatures open.
      if (!value.env || typeof value.env !== "object" || Array.isArray(value.env))
        throw new TypeError("Invalid launch environment");
      const entries = Object.entries(value.env);
      if (value.blocked) return { error: value.blocked };
      if (entries.length || value.args.length || value.provider)
        contributors.set(plugin, value.identity ?? "");
      const owned = ownedAgentLaunchArg(agentId, value.args);
      if (owned)
        return {
          error: `Could not start the turn: plugin "${plugin}" supplied ${owned}, which Tokamak sets.`,
        };
      if (value.provider) {
        if (provider)
          return {
            error: `Could not start the turn: plugins "${provider.plugin}" and "${plugin}" both set provider.`,
          };
        const { baseUrl, keyEnv, key } = value.provider;
        const url = new URL(baseUrl);
        if (
          (url.protocol !== "http:" && url.protocol !== "https:") ||
          /[\u0000-\u001f\u007f]/.test(baseUrl) ||
          !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(keyEnv) ||
          (agentId === "codex" && keyEnv.toUpperCase() === "CODEX_HOME") ||
          !key ||
          /[\0\r\n]/.test(key)
        )
          throw new TypeError("Invalid launch provider");
        provider = { plugin, value: { baseUrl, keyEnv, key } };
      }
      for (const [name, setting] of entries) {
        if (!name || /[=\0\r\n]/.test(name) || typeof setting !== "string" || setting.includes("\0"))
          throw new TypeError("Invalid launch environment entry");
        const previous = env.get(name);
        if (previous && previous.plugin !== plugin) {
          return {
            error: `Could not start the turn: plugins "${previous.plugin}" and "${plugin}" both set ${name}.`,
          };
        }
        env.set(name, { plugin, name, value: setting });
      }
      for (const arg of value.args) args.push(arg);
    }
    if (provider) {
      const name = provider.value.keyEnv;
      const previous = env.get(name);
      if (previous)
        return {
          error: `Could not start the turn: plugin "${provider.plugin}" set provider with ${name}, which plugin "${previous.plugin}" also set in the environment.`,
        };
    }
    if (!env.size && !args.length && !provider) return {};
    return {
      settings: {
        threadId,
        // The home follows the contributors, even if their per-turn keys rotate.
        identity: createHash("sha256")
          .update(
            JSON.stringify([
              agentId,
              [...contributors.keys()].sort().map((plugin) => {
                const identity = contributors.get(plugin);
                return identity ? [plugin, identity] : plugin;
              }),
            ]),
          )
          .digest("hex"),
        env: Object.fromEntries([...env.values()].map(({ name, value }) => [name, value])),
        args,
        ...(provider && { provider: provider.value }),
      },
    };
  } catch (cause) {
    // Hook errors can contain the settings the hook was assembling.
    return { error: hookRunnerUpdate(cause) ?? "Could not prepare the agent's launch settings." };
  }
}

/** Match literal values longest first; do not scan the replacement text. */
function redactLaunchError(message: string, settings?: LaunchSettings): string {
  if (!settings) return message;
  const argValues = settings.args.flatMap((arg) => {
    const equals = arg.indexOf("=");
    return equals < 0 ? [arg] : [arg, arg.slice(equals + 1)];
  });
  const providerValues = settings.provider ? [settings.provider.key, settings.provider.baseUrl] : [];
  const values = [...new Set([...Object.values(settings.env), ...argValues, ...providerValues])]
    .filter((value) => value && message.includes(value))
    .sort((a, b) => b.length - a.length);
  if (!values.length) return message;
  const literals = values.map((value) => value.replace(/[.*+?${}()|[\]\\]/g, "\\$&"));
  return message.replace(new RegExp(literals.join("|"), "g"), "[redacted]");
}

/** Steers on the sender's window, and records the text only once the agent can receive it. */
export const steer = action({
  on: "caller",
  args: { windowId: v.string(), turnId: v.id("turns"), text: v.string() },
  handler: async (ctx, { windowId, turnId, text }) => {
    const control = controlFor(turnId, windowKey(ctx.auth, windowId));
    if (!control) return noRunningTurn(turnId);
    const steerText = text.trim();
    if (!steerText) return fail("EmptySteer", { turnId });
    return control.steer(steerText, (text, delivery) =>
      ctx.runMutation(api.turns.steer, { turnId, text, ...(delivery && { delivery }) }),
    );
  },
});

/** Turns whose agent has settled and whose after hooks are still running. */
const finishing = new Map<string, string>();

/** Marks Stop on the server before asking the provider to end, so its final reply is stopped. */
export const stop = action({
  on: "caller",
  args: { windowId: v.string(), turnId: v.id("turns") },
  handler: async (ctx, { windowId, turnId }) => {
    const control = controlFor(turnId, windowKey(ctx.auth, windowId));
    // The agent has settled and only after hooks remain: nothing is left to stop.
    if (!control || !control.active)
      return finishing.get(turnId) === windowKey(ctx.auth, windowId)
        ? fail("NotRunning", { turnId, finishing: true })
        : noRunningTurn(turnId);
    return (await control.requestStop(() => ctx.runMutation(api.turns.requestStop, { turnId })))
      ? null
      : noRunningTurn(turnId);
  },
});

/** Kills the run's program groups after the deadline recorded on its server row. */
export const forceStop = action({
  on: "caller",
  args: { windowId: v.string(), turnId: v.id("turns") },
  handler: async (ctx, { windowId, turnId }) => {
    const control = controlFor(turnId, windowKey(ctx.auth, windowId));
    if (!control) return noRunningTurn(turnId);
    if ((await ctx.runQuery(api.turns.forceStopDelay, { turnId })) !== 0) return fail("TooEarly", { turnId });
    return control.forceStop();
  },
});

/**
 * The sender's answer to a question waiting in this window. The card on
 * the composer calls this; it fails with `Expired` when no turn here waits on
 * that question, as after the app that asked it quit. `turns:answer` clears
 * the question on the row (checking inside that the caller is the turn's
 * sender on its device, with the token only its Runner holds); only
 * then does the answer reach the agent.
 */
export const answer = action({
  on: "caller",
  args: { windowId: v.string(), turnId: v.id("turns"), questionId: v.string(), answer: answerValue },
  handler: async (ctx, { windowId, turnId, questionId, answer }) => {
    const pending = pendingQuestion(windowKey(ctx.auth, windowId), turnId, questionId);
    if (!pending) return fail("Expired", { turnId });
    await ctx.runMutation(api.turns.answer, { turnId, questionId, token: pending.token });
    // A second click while the first answer was on its way finds nothing left to answer.
    settle(turnId, pending, answer);
    return null;
  },
});

/**
 * Whether this window still owns the question, so the card can say at
 * once that a question from before the app quit has expired.
 */
export const pending = action({
  on: "caller",
  args: { windowId: v.string(), turnId: v.id("turns"), questionId: v.string() },
  handler: async (ctx, { windowId, turnId, questionId }) =>
    pendingQuestion(windowKey(ctx.auth, windowId), turnId, questionId) !== undefined,
});

/** A step as the Runner keeps it: the agent's latest report and when this computer saw it begin and end. */
type StepReport = Infer<typeof stepReport>;
type WriteArgs = ArgsOf<typeof api.turns.write>;
/** The report methods of a `Run`: what the agent calls while it works. */
type Reports = Pick<Run, "text" | "thinking" | "tool" | "tasks" | "plan" | "helper" | "usage">;

/** The reports that replace what is stored: the to-do list, the plan, usage. */
type Latest = { tasks?: WriteArgs["tasks"]; plan?: string; usage?: Usage };

/**
 * What the server has not been sent yet, and how it goes out: each write
 * takes what fits under `WRITE_BYTES`, text and thinking first (cut to fit
 * when they must), and leaves the rest for the next one.
 */
class Unsent {
  /** Text and thinking appended since they were last sent. */
  text = "";
  thinking = "";
  readonly latest: Latest = {};
  readonly dirty = new Set<keyof Latest>();
  /** Every step as last reported, and the keys that changed since they were last sent. */
  readonly steps = new Map<string, StepReport>();
  readonly dirtySteps = new Set<string>();

  /** The whole text and thinking so far, cut at their limits as the server cuts them. */
  readonly whole = { text: "", thinking: "" };

  append(field: "text" | "thinking", delta: string): void {
    const next = append(this.whole[field], delta, TEXT_BYTES);
    this[field] += next.slice(this.whole[field].length);
    this.whole[field] = next;
  }

  /** Keeps a step's latest report, timed on this computer: when its id was first seen and when it ended. */
  step(report: Omit<StepReport, "startedAt" | "finishedAt">): void {
    const now = Date.now();
    const known = this.steps.get(report.key);
    const startedAt = known?.startedAt ?? now;
    const finishedAt = report.state === "running" ? undefined : (known?.finishedAt ?? now);
    this.steps.set(report.key, { ...report, startedAt, ...(finishedAt !== undefined && { finishedAt }) });
    this.dirtySteps.add(report.key);
  }

  any(): boolean {
    return this.text !== "" || this.thinking !== "" || this.dirty.size > 0 || this.dirtySteps.size > 0;
  }

  next(turnId: Id<"turns">): WriteArgs {
    const out: WriteArgs = { turnId };
    let room = WRITE_BYTES - jsonBytes(out);
    const empty = () => Object.keys(out).length === 1;
    if (this.text) {
      out.text = fit(this.text, room - 16);
      this.text = this.text.slice(out.text.length);
      room -= jsonBytes(out.text) + 16;
    }
    if (this.thinking && room > 64) {
      out.thinking = fit(this.thinking, room - 16);
      this.thinking = this.thinking.slice(out.thinking.length);
      room -= jsonBytes(out.thinking) + 16;
    }
    for (const field of this.dirty) {
      const size = jsonBytes(this.latest[field]) + 16;
      if (size > room && !empty()) continue;
      Object.assign(out, { [field]: this.latest[field] });
      this.dirty.delete(field);
      room -= size;
    }
    const changed: StepReport[] = [];
    for (const key of this.dirtySteps) {
      const step = this.steps.get(key)!;
      const size = jsonBytes(step) + 1;
      if (size > room - 16 && (changed.length > 0 || !empty())) break;
      changed.push(step);
      this.dirtySteps.delete(key);
      room -= size;
    }
    if (changed.length > 0) out.steps = changed;
    return out;
  }
}

/**
 * Collects what the agent reports and stores it on the server. At most one
 * write is in flight; each carries what changed since the last (text and
 * thinking as appended deltas, the latest tasks, plan and usage, the changed
 * steps; see `Unsent`). Texts
 * are cut at their limits here as on the server. Steps are timed here, on
 * the computer that runs the turn. A write refused twice breaks the writer:
 * `broke` resolves, and every later report throws back to the agent.
 */
function turnWriter(ctx: CallerActionContext, turnId: Id<"turns">) {
  const unsent = new Unsent();
  let flight: Promise<void> | undefined;
  let broken: unknown;
  let closed = false;
  let onBroken: () => void = () => {};
  const broke = new Promise<undefined>((resolve) => (onBroken = () => resolve(undefined)));

  function pump(): void {
    flight ??= (async () => {
      while (unsent.any() && broken === undefined) {
        const args = unsent.next(turnId);
        // One retry covers a dropped connection; a second refusal means the server will not take it.
        await ctx
          .runMutation(api.turns.write, args)
          .catch(() => ctx.runMutation(api.turns.write, args))
          .catch((cause: unknown) => {
            broken = cause;
            onBroken();
          });
        // Let buffered agent reports arrive before taking the next write, without delaying the first.
        if (broken === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      flight = undefined;
    })();
  }
  function open() {
    check(broken === undefined, `the turn could not be saved: ${errorText(broken)}`);
    check(!closed, "this turn has ended");
  }
  function set<K extends keyof Latest>(field: K, value: Latest[K]) {
    unsent.latest[field] = value;
    unsent.dirty.add(field);
    pump();
  }

  // Each method checks the agent's report (throwing back to the agent) and
  // keeps only the fields the contract names, so extra fields never reach a row.
  const reports: Reports = {
    text(delta) {
      open();
      unsent.append("text", checkedText(delta, "text(delta)"));
      pump();
    },
    thinking(delta) {
      open();
      unsent.append("thinking", checkedText(delta, "thinking(delta)"));
      pump();
    },
    tool(tool) {
      open();
      const { id: key, ...step } = checkedTool(tool);
      unsent.step({ key, type: "tool", ...step });
      pump();
    },
    helper(helper) {
      open();
      const { id: key, ...step } = checkedHelper(helper);
      unsent.step({ key, type: "helper", ...step });
      pump();
    },
    tasks(list) {
      open();
      set("tasks", checkedTasks(list));
    },
    plan(markdown) {
      open();
      set("plan", append("", checkedText(markdown, "plan(text)"), PLAN_BYTES));
    },
    usage(usage) {
      open();
      set("usage", checkedUsage(usage));
    },
  };

  return {
    reports,
    /** Resolves (to undefined) when a write was refused twice. */
    broke,
    async settled() {
      while (flight) await flight;
    },
    /** Ends the writer: later reports throw. Returns why writing broke, if it did. */
    close() {
      closed = true;
      return broken;
    },
  };
}
