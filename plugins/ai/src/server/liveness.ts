import { v, type DatabaseReader, type ArgsOf, type Id, type MutationContext } from "@tokamak/sdk";
import { api as chat } from "plugin:chat/server";
import { isSendersDevice, sameSender } from "../shared/turn-shared";
import { BEAT_MS, CLOSED, RELOADED, SILENCE_MS } from "../shared/turn-timing";
import {
  ACTIVE,
  activeTurnOf,
  internalMutation,
  isActive,
  lastEndedTurnOf,
  mutation,
  type Model,
  type Turn,
} from "./_functions";

/**
 * A turn whose app went away. While a turn runs or waits, the sender's local
 * part calls `beat` every few seconds (keep-alive.ts). The server's sweep ends
 * a turn that has been silent for SILENCE_MS as `interrupted` with the reason
 * "Tokamak was closed": the reply so far is kept and the thread is free again.
 * A slow agent in an open app keeps beating, so it is never interrupted.
 *
 * Queued messages of a crashed app have nobody left to start them, and the
 * first one blocks its thread. Once a thread has been free for the same limit
 * and its first queued message has still not begun, the sweep settles that
 * device's queue in the thread the same way. On the local server, an app that
 * comes back within the limit starts its queued messages as usual.
 */

/**
 * A sweep that comes this long after the one before means the server was not
 * running (or stalled) in between: it restarts the count, so apps that could
 * not reach it are not blamed for the gap. Sweeps come every 5 seconds.
 */
const AWAY_MS = 20_000;

/**
 * A turn of this device that its relaunched app does not run, and that has
 * not beaten for this long, is ended at once by `release` (more than one beat,
 * so a turn another window of this device runs is never taken for dead).
 */
const RELEASE_MS = BEAT_MS + 5_000;

/** The sign of life. False once the turn has ended, so the Runner stops its agent. */
export const beat = mutation({
  args: { turnId: v.id("turns") },
  handler: async (ctx, { turnId }) => {
    const turn = await ctx.db.get(turnId);
    if (!turn || !isActive(turn)) return false;
    // Local code calls on the window's session: only the sender's own device keeps its turn alive.
    if (!isSendersDevice(turn, ctx.auth))
      throw new Error("Only the sender's device can keep this turn alive");
    const sign = await signOf(ctx.db, turnId);
    if (sign) await ctx.db.patch(sign._id, { at: Date.now() });
    else await ctx.db.insert("signs", { turnId, at: Date.now() });
    return true;
  },
});

/**
 * Called by a window once it can reach its Runner. Turns on this device
 * that the window does not own (`running`) are interrupted only once their
 * last beat goes stale, so a turn in another open window keeps running.
 * Resolves how many such turns beat too recently to end yet; the window asks
 * again after a beat.
 */
export const release = mutation({
  args: { running: v.array(v.id("turns")) },
  handler: async (ctx, { running }) => {
    const now = Date.now();
    let pending = 0;
    for (const state of ACTIVE) {
      const turns = await ctx.db
        .query("turns")
        .withIndex("by_state", (q) => q.eq("state", state))
        .collect();
      for (const turn of turns) {
        if (!isSendersDevice(turn, ctx.auth) || running.includes(turn._id)) continue;
        if (now - (await lastHeard(ctx.db, turn)) < RELEASE_MS) pending++;
        else await interrupt(ctx, turn, now);
      }
    }
    return pending;
  },
});

/** A window closed an admitted call on reload. Its token identifies that exact invocation. */
export const releaseReloaded = mutation({
  args: { messageId: v.string(), replyToken: v.string() },
  handler: async (ctx, { messageId, replyToken }) => {
    const turn = await ctx.db
      .query("turns")
      .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
      .first();
    if (!turn || turn.replyToken !== replyToken || !isSendersDevice(turn, ctx.auth)) return false;
    if (!isActive(turn)) return "ended" as const;
    await interrupt(ctx, turn, Date.now(), RELOADED);
    return true;
  },
});

/** The plugin's maintenance entry: the server runs it every few seconds. */
export const sweep = internalMutation({
  handler: async (ctx) => {
    const active = (
      await Promise.all(
        ACTIVE.map((state) =>
          ctx.db
            .query("turns")
            .withIndex("by_state", (q) => q.eq("state", state))
            .collect(),
        ),
      )
    ).flat();
    const queued = await ctx.db
      .query("turns")
      .withIndex("by_state", (q) => q.eq("state", "queued"))
      .collect();
    // Nothing to watch: leave the clock alone. A turn that begins later only gets a longer grace.
    if (active.length === 0 && queued.length === 0) return null;

    const now = Date.now();
    const clock = await ctx.db.query("sweeps").first();
    const since = !clock || now - clock.at > AWAY_MS ? now : clock.since;
    if (clock) await ctx.db.patch(clock._id, { at: now, since });
    else await ctx.db.insert("sweeps", { at: now, since });
    const cutoff = now - SILENCE_MS;
    if (since > cutoff) return null;

    for (const turn of active) if ((await lastHeard(ctx.db, turn)) <= cutoff) await interrupt(ctx, turn, now);

    const threads = new Set(queued.map((turn) => turn.threadId));
    for (const threadId of threads) await settleStrandedQueue(ctx, threadId, cutoff, now);
    return null;
  },
});

function signOf(db: DatabaseReader<Model>, turnId: Id<"turns">) {
  return db
    .query("signs")
    .withIndex("by_turnId", (q) => q.eq("turnId", turnId))
    .first();
}

/** When the turn’s Runner last spoke: its last sign, or when the turn began. */
async function lastHeard(db: DatabaseReader<Model>, turn: Turn) {
  return Math.max((await signOf(db, turn._id))?.at ?? 0, turn.startedAt);
}

/**
 * Ends a silent turn: the reply keeps its text and says why it ended, a step
 * the agent never closed ends with it, and the question, if any, is gone.
 */
async function interrupt(ctx: MutationContext<Model>, turn: Turn, now: number, reason = CLOSED) {
  if (turn.replyId && turn.replyToken)
    await ctx.use(chat).writeReply({
      messageId: turn.replyId as ArgsOf<typeof chat.writeReply>["messageId"],
      token: turn.replyToken,
      done: true,
      outcome: "interrupted",
      error: reason,
    });
  const steps = await ctx.db
    .query("steps")
    .withIndex("by_turnId_n", (q) => q.eq("turnId", turn._id))
    .collect();
  for (const step of steps)
    if (step.state === "running") await ctx.db.patch(step._id, { state: "failed", finishedAt: now });
  const {
    _id,
    _creationTime,
    question: _question,
    questionToken: _token,
    current: _current,
    pendingSteer: _steer,
    pendingSteerOffset: _steerOffset,
    ...rest
  } = turn;
  await ctx.db.replace(_id, { ...rest, state: "interrupted", error: reason, finishedAt: now });
  const sign = await signOf(ctx.db, _id);
  if (sign) await ctx.db.delete(sign._id);
}

/**
 * The first queued message of a free thread begins within moments while its
 * app is open. If the thread has been free for the whole limit and it still
 * waits, its app is gone: settle every message that device queued in the thread.
 */
async function settleStrandedQueue(
  ctx: MutationContext<Model>,
  threadId: string,
  cutoff: number,
  now: number,
) {
  if (await activeTurnOf(ctx.db, threadId)) return;
  const queue = await ctx.db
    .query("turns")
    .withIndex("by_threadId_state_startedAt", (q) => q.eq("threadId", threadId).eq("state", "queued"))
    .collect();
  const head = queue[0];
  if (!head) return;
  const lastEnded = (await lastEndedTurnOf(ctx.db, threadId))?.finishedAt ?? 0;
  if (Math.max(head.startedAt, lastEnded) > cutoff) return;
  for (const turn of queue) {
    if (!sameSender(turn, head)) continue;
    await ctx.use(chat).deliverMessage({
      messageId: turn.messageId as ArgsOf<typeof chat.writeReply>["messageId"],
      error: CLOSED,
    });
    await ctx.db.patch(turn._id, { state: "interrupted", error: CLOSED, finishedAt: now });
  }
}
