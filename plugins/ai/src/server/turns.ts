import {
  fail,
  v,
  type AuthContext,
  type DatabaseReader,
  type DatabaseWriter,
  type ArgsOf,
  type Id,
  type MutationContext,
  type QueryContext,
} from "@tokamak/sdk";
import { api as chat } from "plugin:chat/server";
import { agentTurnHistory } from "@tokamak/sdk/agent-turn";
import { isSendersDevice } from "../shared/turn-shared";
import { FORCE_STOP_MS } from "../shared/turn-timing";
import { ACTIVE, mutation, query, view, type Model, type Turn, activeTurnOf } from "./_functions";
import { putStep, summary } from "./_steps";
import { save, startedBy } from "./choices";
import { append, jsonBytes, line, LINE_CHARS, PLAN_BYTES, TASKS_MAX, TEXT_BYTES } from "./limits";
import { access, question, stepReport, task, usage, who } from "./schema";

/**
 * A turn's rows. The sender’s Runner (`run:turn`) calls these mutations on
 * the window's session, so any member's window can reach them too: each one
 * checks inside that the caller is the turn's sender, on the sender's device.
 */

/** What one live answer may weigh, well under the 1 MiB frame; older turns drop off first. */
const ANSWER_BYTES = 512 * 1024;
/** As many turns as chat shows messages (it reads the latest 200). */
const REPLIES_MAX = 200;
const LONG_MESSAGE = "This message is too long to send to the agent. Shorten the message and try again.";

/** The thread's turns, oldest first, as windows see them. */
export const list = query({
  args: { threadId: v.string() },
  handler: async ({ db }, { threadId }) =>
    (
      await db
        .query("turns")
        .withIndex("by_threadId_startedAt", (q) => q.eq("threadId", threadId))
        .collect()
    ).map(view),
});

const agentSettings = {
  agent: who,
  model: v.string(),
  /** The model as the agent names it for people ("Opus 5.5"); the reply's header shows it. */
  modelName: v.optional(v.string()),
  effort: v.optional(v.string()),
  speed: v.optional(v.string()),
  mode: v.optional(v.string()),
  access,
};

/** The turn holding the thread, including when it waits for an answer or is stopping. */
export const active = query({
  args: { threadId: v.string() },
  handler: async ({ db }, { threadId }) => {
    const turn = await activeTurn(db, threadId);
    return turn && view(turn);
  },
});

/** Only the sender's device can take the queue head. */
export const next = query({
  args: { threadId: v.string() },
  handler: async ({ db, auth }, { threadId }) => {
    if (await activeTurn(db, threadId)) return null;
    const queued = await firstQueued(db, threadId);
    return queued && isSendersDevice(queued, auth) ? view(queued) : null;
  },
});

/** A draft must go through turn controls if either a running turn or a queue holds the thread. */
export const pending = query({
  args: { threadId: v.string() },
  handler: async ({ db }, { threadId }) => {
    const holder = (await activeTurn(db, threadId)) ?? (await firstQueued(db, threadId));
    return holder && view(holder);
  },
});

/** The heads this device can start, across threads, for the window's live queue subscription. */
export const ready = query({
  handler: async ({ db, auth }) => {
    const queued = await db
      .query("turns")
      .withIndex("by_state", (q) => q.eq("state", "queued"))
      .collect();
    const heads: ReturnType<typeof view>[] = [];
    const seen = new Set<string>();
    for (const turn of queued) {
      if (!isSendersDevice(turn, auth) || seen.has(turn.threadId)) continue;
      seen.add(turn.threadId);
      if (await activeTurn(db, turn.threadId)) continue;
      const head = await firstQueued(db, turn.threadId);
      if (head && isSendersDevice(head, auth)) heads.push(view(head));
    }
    return heads;
  },
});

/** Stages the dashed message and its settings together, so reloading can't lose the queue. */
export const enqueue = mutation({
  args: { threadId: v.string(), text: v.string(), ...agentSettings },
  handler: async (ctx, { threadId, text, ...settings }) => {
    const { user, device } = ctx.auth;
    // The creator check comes first, so another member always gets the same error.
    await requireCreator(ctx, threadId);
    const running = await activeTurn(ctx.db, threadId);
    if (running) checkSender(running, ctx.auth);
    const head = await firstQueued(ctx.db, threadId);
    if (head && !isSendersDevice(head, ctx.auth)) return busy(head);
    const { messageId, createdAt } = await ctx
      .use(chat)
      .stageMessage({ threadId: threadId as ArgsOf<typeof chat.getThread>["threadId"], text });
    const turnId = await ctx.db.insert("turns", {
      threadId,
      messageId,
      sender: { id: user.id, name: user.name, device: device.id },
      ...settings,
      state: "queued",
      startedAt: createdAt,
    });
    return { turnId, messageId };
  },
});

/**
 * Everything the replies of a thread draw without being opened, in one live
 * query that every reply in the window shares: each turn (agent, model,
 * state, times, the actions count and the step in progress, tasks, plan,
 * usage) with its helper rows. Thinking, the steps and a helper's answer are
 * read when opened (`thinking`, `steps`, `helper`). The latest turns first
 * fill the answer; returned oldest first.
 */
export const replies = query({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    if (!(await canSee(ctx, threadId))) return [];
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_threadId_startedAt", (q) => q.eq("threadId", threadId))
      .order("desc")
      .take(REPLIES_MAX);
    const out = [];
    let remaining = ANSWER_BYTES;
    // A queued turn has no reply yet; the dashed message is chat's.
    for (const turn of turns) {
      if (!turn.replyId) continue;
      const helpers = (
        await ctx.db
          .query("steps")
          .withIndex("by_turnId_type_n", (q) => q.eq("turnId", turn._id).eq("type", "helper"))
          .collect()
      ).map(({ text, ...helper }) => ({ ...helper, hasText: text !== undefined }));
      const row = { ...view(turn), helpers };
      remaining -= jsonBytes(row);
      if (remaining < 0) break;
      out.push(row);
    }
    return out.reverse();
  },
});

/** A turn's tool steps in order, for its opened actions line; the earliest drop off past the answer's size. */
export const steps = query({
  args: { turnId: v.id("turns") },
  handler: async (ctx, { turnId }) => {
    if (!(await visibleTurn(ctx, turnId))) return null;
    const rows = await ctx.db
      .query("steps")
      .withIndex("by_turnId_type_n", (q) => q.eq("turnId", turnId).eq("type", "tool"))
      .order("desc")
      .collect();
    const out = [];
    let remaining = ANSWER_BYTES;
    for (const row of rows) {
      remaining -= jsonBytes(row);
      if (remaining < 0) break;
      out.push(row);
    }
    return { steps: out.reverse(), omitted: rows.length - out.length };
  },
});

/** A turn's thinking, for its opened Thinking line. */
export const thinking = query({
  args: { turnId: v.id("turns") },
  handler: async (ctx, { turnId }) => (await visibleTurn(ctx, turnId))?.thinking ?? null,
});

/** A helper's answer, for its opened row. */
export const helper = query({
  args: { stepId: v.id("steps") },
  handler: async (ctx, { stepId }) => {
    const step = await ctx.db.get(stepId);
    if (!step || step.type !== "helper" || !(await visibleTurn(ctx, step.turnId))) return null;
    return step.text ?? null;
  },
});

/** Whether the caller can see the thread: it is a thread chat shows them. */
async function canSee(ctx: QueryContext<Model>, threadId: string): Promise<boolean> {
  return (
    (await ctx.use(chat).getThread({ threadId: threadId as ArgsOf<typeof chat.getThread>["threadId"] })) !==
    null
  );
}

/** The turn, if it exists in a thread the caller can see. */
async function visibleTurn(ctx: QueryContext<Model>, turnId: Id<"turns">): Promise<Turn | null> {
  const turn = await ctx.db.get(turnId);
  return turn && (await canSee(ctx, turn.threadId)) ? turn : null;
}

/**
 * Begins a turn on the caller's own message, from the caller's device. Fails
 * with `Busy` while another turn holds the thread or a queued message is first,
 * and with `Answered` when the message already has a reply. Returns what the
 * agent gets: the prompt exactly as stored, the thread's earlier messages for
 * a fresh session, and the session to carry on when the thread's last turn
 * was the same agent's on this device. When the sender started the thread,
 * what the turn uses becomes the thread's choices.
 *
 * For a new Send, settings are the sender's labels: `run:turn` checks them
 * against installed providers. A queued turn keeps its own settings.
 */
export const begin = mutation({
  args: {
    threadId: v.string(),
    messageId: v.string(),
    folder: v.optional(v.string()),
    ...agentSettings,
    /** Chat's reply capability, chosen by the Runner (mutations have no secret randomness). */
    replyToken: v.string(),
  },
  handler: async (ctx, { threadId, messageId, folder, replyToken, ...settings }) => {
    const { user, device } = ctx.auth;
    const message = await ctx
      .use(chat)
      .readPrompt({ messageId: messageId as ArgsOf<typeof chat.writeReply>["messageId"] });
    if (!message || message.threadId !== threadId) throw new Error("That message is not in this thread");
    if (message.authorId !== user.id)
      throw new Error("Only the person who sent a message can begin its turn");
    await requireCreator(ctx, threadId);
    const existing = await ctx.db
      .query("turns")
      .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
      .first();
    if (existing && existing.state !== "queued") return fail("Answered", { turnId: existing._id });
    if (existing) checkSender(existing, ctx.auth);
    const running = await activeTurn(ctx.db, threadId);
    if (running) return busy(running);
    const queued = await firstQueued(ctx.db, threadId);
    if (queued && queued._id !== existing?._id) return busy(queued);
    const earlier = await lastTurn(ctx.db, threadId);
    if (existing) {
      const input = await handOver(ctx, existing, message, earlier, folder, settings);
      if (!input) {
        await settleQueuedFailure(ctx, existing, LONG_MESSAGE);
        return { turnId: existing._id, state: "failed" as const };
      }
      await promoteQueued(ctx, existing, replyToken);
      return input;
    }
    const turnId = await ctx.db.insert("turns", {
      threadId,
      messageId,
      sender: { id: user.id, name: user.name, device: device.id },
      ...settings,
      ...(await openReply(ctx, threadId, settings.agent, replyToken)),
    });
    const turn = (await ctx.db.get(turnId))!;
    const input = await handOver(ctx, turn, message, earlier, folder, settings);
    if (!input) throw new Error(LONG_MESSAGE);
    return input;
  },
});

/**
 * What `begin` hands the Runner for the agent: the prompt, the earlier
 * messages and the session to carry on when the thread's last turn was this
 * agent's on this device. Keeps the turn's settings as the thread's choices
 * when its sender started the thread.
 */
async function handOver(
  ctx: MutationContext<Model>,
  turn: Turn,
  message: { text: string; createdAt: number },
  earlier: Turn | undefined,
  folder: string | undefined,
  startSettings: Pick<Turn, "model" | "effort" | "speed" | "mode" | "access">,
) {
  const { agent, model, effort, speed, mode, access, sender } = turn;
  const history = await ctx.use(chat).historyBefore({
    threadId: turn.threadId as ArgsOf<typeof chat.getThread>["threadId"],
    before: message.createdAt,
  });
  const sessionId =
    earlier?.agent.id === agent.id && earlier.sender.device === sender.device ? earlier.sessionId : undefined;
  const input = {
    turnId: turn._id,
    prompt: message.text,
    history,
    ...(sessionId === undefined
      ? {}
      : { sessionId, ...(earlier?.sessionHome && { sessionHome: earlier.sessionHome }) }),
  };
  const {
    model: pickedModel,
    effort: pickedEffort,
    speed: pickedSpeed,
    mode: pickedMode,
    access: pickedAccess,
  } = startSettings;
  const fitting =
    folder === undefined
      ? history
      : agentTurnHistory({
          ...input,
          threadId: turn.threadId,
          folder,
          model: pickedModel,
          effort: pickedEffort,
          speed: pickedSpeed,
          mode: pickedMode,
          access: pickedAccess,
        });
  if (!fitting) return undefined;
  await save(ctx, turn.threadId, {
    agent,
    model,
    ...(effort === undefined ? {} : { effort }),
    ...(speed === undefined ? {} : { speed }),
    ...(mode === undefined ? {} : { mode }),
    access,
  });
  return { ...input, history: fitting };
}

/** The thread's last turn that began, before this one: queued ones have not. */
async function lastTurn(db: DatabaseReader<Model>, threadId: string): Promise<Turn | undefined> {
  const recent = await db
    .query("turns")
    .withIndex("by_threadId_startedAt", (q) => q.eq("threadId", threadId))
    .order("desc")
    .take(50);
  return recent.find((turn) => turn.state !== "queued");
}

function busy(turn: Turn) {
  return fail("Busy", { turnId: turn._id, agent: turn.agent.name });
}

async function openReply(
  ctx: MutationContext<Model>,
  threadId: string,
  agent: Turn["agent"],
  replyToken: string,
) {
  const replyId = await ctx.use(chat).startReply({
    threadId: threadId as ArgsOf<typeof chat.getThread>["threadId"],
    token: replyToken,
    author: { id: `agent:${agent.id}`, name: agent.name },
  });
  return { replyId, replyToken, state: "running" as const, startedAt: Date.now() };
}

async function promoteQueued(ctx: MutationContext<Model>, turn: Turn, replyToken: string) {
  await ctx
    .use(chat)
    .deliverMessage({ messageId: turn.messageId as ArgsOf<typeof chat.writeReply>["messageId"] });
  await ctx.db.patch(turn._id, await openReply(ctx, turn.threadId, turn.agent, replyToken));
}

/** The Runner reads the queued snapshot before choosing which provider to start. */
export const queuedForMessage = query({
  args: { messageId: v.string() },
  handler: async ({ db, auth }, { messageId }) => {
    const turn = await db
      .query("turns")
      .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
      .first();
    return turn?.state === "queued" && isSendersDevice(turn, auth) ? view(turn) : null;
  },
});

/** Queued messages that would otherwise be left behind by this device. */
export const queuedForDevice = query({
  handler: async ({ db, auth }) =>
    (await queuedOn(db, auth)).map(({ threadId, agent }) => ({ threadId, agent: agent.name })),
});

/** Stop all pending messages for this device before stopping its active agents. */
export const stopQueued = mutation({
  handler: async (ctx) => {
    const queued = await queuedOn(ctx.db, ctx.auth);
    for (const turn of queued) {
      await ctx.use(chat).deliverMessage({
        messageId: turn.messageId as ArgsOf<typeof chat.writeReply>["messageId"],
        stopped: true,
      });
      await ctx.db.patch(turn._id, { state: "stopped", finishedAt: Date.now() });
    }
    return queued.length;
  },
});

// Reads every queued turn and keeps this device's: there is no index on state and
// sender device. Queued turns are few (they run as soon as their thread is free),
// so this stays until a device-wide queue needs one.
async function queuedOn(db: DatabaseReader<Model>, auth: AuthContext) {
  return (
    await db
      .query("turns")
      .withIndex("by_state", (q) => q.eq("state", "queued"))
      .collect()
  ).filter((turn) => isSendersDevice(turn, auth));
}

/** A queued turn that can't launch should not block the rest of the queue. */
export const failQueued = mutation({
  args: { turnId: v.id("turns"), error: v.string() },
  handler: async (ctx, { turnId, error }) => {
    const turn = await ctx.db.get(turnId);
    if (!turn) return null;
    checkSender(turn, ctx.auth);
    if (
      turn.state !== "queued" ||
      (await activeTurn(ctx.db, turn.threadId)) ||
      (await firstQueued(ctx.db, turn.threadId))?._id !== turnId
    )
      return null;
    await settleQueuedFailure(ctx, turn, error);
    return null;
  },
});

async function settleQueuedFailure(ctx: MutationContext<Model>, turn: Turn, error: string) {
  await ctx
    .use(chat)
    .deliverMessage({ messageId: turn.messageId as ArgsOf<typeof chat.writeReply>["messageId"], error });
  const now = Date.now();
  await ctx.db.patch(turn._id, { state: "failed", error, startedAt: now, finishedAt: now });
}

async function requireCreator(ctx: MutationContext<Model>, threadId: string): Promise<void> {
  if (!(await startedBy(ctx, threadId, ctx.auth.user.id)))
    throw new Error("Only the person who started this thread can run an agent");
}

const activeTurn = activeTurnOf;

function firstQueued(db: DatabaseReader<Model>, threadId: string) {
  return db
    .query("turns")
    .withIndex("by_threadId_state_startedAt", (q) => q.eq("threadId", threadId).eq("state", "queued"))
    .first();
}

/** Reads only the steer text belonging to this reply, independently of streamed output. */
export const replySteers = query({
  args: { replyId: v.string() },
  handler: async ({ db }, { replyId }) => {
    const turn = await db
      .query("turns")
      .withIndex("by_replyId", (q) => q.eq("replyId", replyId))
      .first();
    if (!turn) return [];
    const steers = turn.steers ?? [];
    return turn.pendingSteer === undefined ? steers : [...steers, turn.pendingSteer];
  },
});

/** Records a follow-up inside the turn before handing it to the registered agent handler. */
export const steer = mutation({
  args: {
    turnId: v.id("turns"),
    text: v.string(),
    delivery: v.optional(v.union(v.literal("pending"), v.literal("delivered"), v.literal("failed"))),
  },
  handler: async (ctx, { turnId, text, delivery }) => {
    const turn = await sendersRunningTurn(ctx, turnId);
    if (delivery === "delivered" || delivery === "failed") {
      if (turn.pendingSteer === text)
        await update(ctx.db, turn, {
          pendingSteer: undefined,
          pendingSteerOffset: undefined,
          ...(delivery === "delivered" && withSteer(turn, text, turn.pendingSteerOffset)),
        });
      return null;
    }
    if (turn.stoppingAt !== undefined) throw new Error("This turn is stopping");
    if (turn.pendingSteer !== undefined) throw new Error("The turn is already receiving a steer");
    await ctx.db.patch(
      turnId,
      delivery === "pending"
        ? { pendingSteer: text, pendingSteerOffset: replyLength(turn) }
        : withSteer(turn, text, undefined),
    );
    return null;
  },
});

/**
 * How much of the reply's text is stored now. A steer is recorded as pending
 * before the agent receives it, so the text stored at that moment is all
 * written before the steer; the reply draws the steer at this point.
 */
function replyLength(turn: Turn): number {
  return turn.text?.length ?? 0;
}

/**
 * The turn's steers with `text` added, and where it landed in the reply's
 * text: the offset taken when it was pending, else the text stored now.
 * `steerOffsets` runs parallel to `steers`; a turn whose steers predate it
 * has none, and its reply draws them after the text.
 */
function withSteer(turn: Turn, text: string, offset: number | undefined) {
  const steers = [...(turn.steers ?? []), text];
  const known = (turn.steerOffsets?.length ?? 0) === (turn.steers?.length ?? 0);
  return {
    steers,
    ...(known && { steerOffsets: [...(turn.steerOffsets ?? []), offset ?? replyLength(turn)] }),
  };
}

/**
 * The questions waiting for the caller: turns they sent from this device that
 * wait on Ask first. The composer's card shows the one for its thread. Nobody
 * else sees them, because only the sender's device can answer.
 */
export const questions = query({
  args: {},
  handler: async ({ db, auth }) =>
    (
      await db
        .query("turns")
        .withIndex("by_state", (q) => q.eq("state", "waiting"))
        .collect()
    ).flatMap((turn) =>
      turn.question && turn.sender.id === auth.user.id && turn.sender.device === auth.device.id
        ? [{ ...turn.question, turnId: turn._id, threadId: turn.threadId, agent: turn.agent.name }]
        : [],
    ),
});

/**
 * The agent asks: the turn waits for the sender's answer, with no time limit.
 * Called by the sender’s Runner (`run.ask`), never on Full access, with a
 * token that Runner keeps to itself for `turns:answer`.
 */
export const ask = mutation({
  args: { turnId: v.id("turns"), question, token: v.string() },
  handler: async (ctx, { turnId, question, token }) => {
    const turn = await sendersRunningTurn(ctx, turnId);
    if (turn.access === "full") throw new Error("A turn on Full access never asks");
    if (turn.state !== "running") throw new Error("This turn already waits for an answer");
    await ctx.db.patch(turnId, { state: "waiting", question, questionToken: token });
    return null;
  },
});

/**
 * Clears the waiting question and lets the turn run on; the answer itself goes
 * from the Runner to the agent and is not stored. Only the Runner that
 * asked can call it: it checks the caller is the sender on the device that
 * runs the turn and holds the question's token, so neither another member nor
 * another window of the same device can let a turn run on while its agent
 * still waits.
 */
export const answer = mutation({
  args: { turnId: v.id("turns"), questionId: v.string(), token: v.string() },
  handler: async (ctx, { turnId, questionId, token }) => {
    const turn = await sendersRunningTurn(ctx, turnId);
    if (turn.state !== "waiting" || turn.question?.id !== questionId)
      throw new Error("That question has already been answered");
    if (turn.questionToken !== token) throw new Error("Only the app that asked can answer this question");
    await ctx.db.replace(turnId, { ...fields(turn), state: "running" });
    return null;
  },
});

/**
 * Stores what the agent reported since the last write, while the turn runs:
 * `text` and `thinking` are appended deltas; tasks, plan and usage replace
 * what is stored; steps that changed are added in order or updated in place
 * by key. Fields left out stay as they are. Everything is kept under the
 * limits in `limits.ts`, whatever the caller sends.
 */
export const write = mutation({
  args: {
    turnId: v.id("turns"),
    text: v.optional(v.string()),
    thinking: v.optional(v.string()),
    tasks: v.optional(v.array(task)),
    plan: v.optional(v.string()),
    usage: v.optional(usage),
    steps: v.optional(v.array(stepReport)),
  },
  handler: async (ctx, { turnId, text, thinking, tasks, plan, usage, steps }) => {
    const turn = await sendersRunningTurn(ctx, turnId);
    const patch: Partial<Turn> = {};
    if (text !== undefined) {
      patch.text = append(turn.text ?? "", text, TEXT_BYTES);
      await ctx.use(chat).writeReply({
        messageId: turn.replyId as string as ArgsOf<typeof chat.writeReply>["messageId"],
        token: turn.replyToken,
        text: patch.text,
      });
    }
    if (thinking !== undefined) patch.thinking = append(turn.thinking ?? "", thinking, TEXT_BYTES);
    if (tasks !== undefined)
      patch.tasks = tasks.slice(0, TASKS_MAX).map((item) => ({ text: line(item.text), state: item.state }));
    if (plan !== undefined) patch.plan = append("", plan, PLAN_BYTES);
    if (usage !== undefined) patch.usage = usage;
    if (steps !== undefined && steps.length > 0) {
      for (const step of steps) await putStep(ctx.db, turnId, step);
      Object.assign(patch, await summary(ctx.db, turnId));
    }
    if (Object.keys(patch).length > 0) await update(ctx.db, turn, patch);
    return null;
  },
});

/** Records the first Stop request. Repeat requests must not push back Force stop. */
export const requestStop = mutation({
  args: { turnId: v.id("turns") },
  handler: async (ctx, { turnId }) => {
    const turn = await sendersRunningTurn(ctx, turnId);
    if (turn.stoppingAt === undefined) await ctx.db.patch(turnId, { stoppingAt: Date.now() });
    return null;
  },
});

/** Both the window and the local stop control use the server's clock for this deadline. */
export const forceStopDelay = query({
  args: { turnId: v.id("turns") },
  handler: async (ctx, { turnId }) => {
    const turn = await sendersRunningTurn(ctx, turnId);
    return turn.stoppingAt === undefined ? null : Math.max(0, turn.stoppingAt + FORCE_STOP_MS - Date.now());
  },
});

/**
 * Ends the turn: chat's reply is frozen with the text stored so far (marked
 * when stopped or failed), steps still running end with the turn (at
 * `finishedAt`, the sender's clock, like every step time), and the thread is
 * free again. It carries no report, so its size never refuses it. A turn
 * asked to stop ends as stopped.
 */
export const finish = mutation({
  args: {
    turnId: v.id("turns"),
    state: v.union(v.literal("done"), v.literal("failed"), v.literal("stopped"), v.literal("interrupted")),
    error: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    sessionHome: v.optional(v.string()),
    acknowledgedSteer: v.optional(v.string()),
    finishedAt: v.number(),
  },
  handler: async (ctx, { turnId, state, error, sessionId, sessionHome, acknowledgedSteer, finishedAt }) => {
    const turn = await sendersRunningTurn(ctx, turnId);
    if (turn.stoppingAt !== undefined && state !== "interrupted") state = "stopped";
    const reason = error === undefined ? undefined : line(error, LINE_CHARS * 4);
    await ctx.use(chat).writeReply({
      messageId: turn.replyId as string as ArgsOf<typeof chat.writeReply>["messageId"],
      token: turn.replyToken,
      text: turn.text ?? "",
      done: true,
      ...(state === "stopped" ? { outcome: "cancelled" as const } : {}),
      ...(state === "interrupted"
        ? { outcome: "interrupted" as const, error: reason ?? "The turn was interrupted." }
        : {}),
      ...(state === "failed"
        ? { outcome: "error" as const, ...(reason === undefined ? {} : { error: reason }) }
        : {}),
    });
    const steps = await ctx.db
      .query("steps")
      .withIndex("by_turnId_n", (q) => q.eq("turnId", turnId))
      .collect();
    // A step the agent never closed ends with its turn; a stopped one did not fail.
    for (const step of steps)
      if (step.state === "running")
        await ctx.db.patch(step._id, {
          state: state === "failed" || state === "interrupted" ? "failed" : "done",
          finishedAt,
        });
    await update(ctx.db, turn, {
      question: undefined,
      questionToken: undefined,
      pendingSteer: undefined,
      pendingSteerOffset: undefined,
      ...deliveredSteers(turn, acknowledgedSteer),
      state,
      current: undefined,
      finishedAt: Date.now(),
      ...((state === "failed" || state === "interrupted") && reason !== undefined ? { error: reason } : {}),
      ...(sessionId === undefined
        ? {}
        : { sessionId: line(sessionId), ...(sessionHome && { sessionHome: line(sessionHome) }) }),
    });
    return state;
  },
});

/** The steers with the pending one added when the agent acknowledged it; nothing changes otherwise. */
function deliveredSteers(turn: Turn, acknowledgedSteer: string | undefined) {
  return acknowledgedSteer !== undefined && turn.pendingSteer === acknowledgedSteer
    ? withSteer(turn, acknowledgedSteer, turn.pendingSteerOffset)
    : {};
}

/** Writes `changes` over the turn; a field set to undefined is removed (patch cannot remove one). */
async function update(db: DatabaseWriter<Model>, turn: Turn, changes: Partial<Turn>) {
  const { _id, _creationTime: _created, ...fields } = { ...turn, ...changes };
  for (const [key, value] of Object.entries(changes))
    if (value === undefined) delete (fields as Record<string, unknown>)[key];
  await db.replace(_id, fields);
}

/** The running or waiting turn, if the caller is its sender on the device that runs it. */
async function sendersRunningTurn(
  { db, auth }: { db: DatabaseReader<Model>; auth: AuthContext },
  turnId: Id<"turns">,
) {
  const turn = await db.get(turnId);
  if (!turn) throw new Error("Turn no longer exists");
  checkSender(turn, auth);
  if (!turn.replyId || !turn.replyToken || !ACTIVE.some((state) => state === turn.state))
    throw new Error("This turn has ended");
  return {
    ...turn,
    replyId: turn.replyId as ArgsOf<typeof chat.writeReply>["messageId"],
    replyToken: turn.replyToken,
  };
}

function checkSender(turn: Turn, auth: AuthContext) {
  if (isSendersDevice(turn, auth)) return;
  if (turn.sender.id !== auth.user.id) throw new Error("Only the sender of a turn can write to it");
  throw new Error("This turn runs on another of your devices; only that device can write to it");
}

/** A turn's own fields without its system fields and its question: what `replace` writes back. */
function fields({ _id, _creationTime, question: _answered, questionToken: _token, ...rest }: Turn) {
  return rest;
}
