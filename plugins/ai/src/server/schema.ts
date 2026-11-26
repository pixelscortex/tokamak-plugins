import { defineSchema, defineTable, v, type Infer } from "@tokamak/sdk";

/** A person or an agent as rows show them. */
export const who = v.object({ id: v.string(), name: v.string() });

/** How much the agent may do without asking: Full access (never asks) or Ask first. */
export const access = v.union(v.literal("full"), v.literal("ask"));

/** A permission question as the agent asked it (`Question` in the contract), with the id its answer names. */
export const question = v.object({
  id: v.string(),
  kind: v.string(),
  action: v.string(),
  subject: v.string(),
});

/** The four answers to a question (`Answer` in the contract). */
export const answer = v.union(
  v.literal("approve"),
  v.literal("approveSession"),
  v.literal("decline"),
  v.literal("cancel"),
);

/** Every state a turn can be in. */
export const turnState = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("done"),
  v.literal("stopped"),
  v.literal("failed"),
  v.literal("interrupted"),
);

/** A step or a helper agent: running, or how it ended. */
export const stepState = v.union(v.literal("running"), v.literal("done"), v.literal("failed"));

/** One item of the agent's to-do list (`run.tasks`). */
export const task = v.object({
  text: v.string(),
  state: v.union(v.literal("pending"), v.literal("running"), v.literal("done")),
});

/** What a turn cost (`run.usage`). */
export const usage = v.object({
  inputTokens: v.number(),
  outputTokens: v.number(),
  cachedInputTokens: v.optional(v.number()),
  costUsd: v.optional(v.number()),
});

/** What kind of tool a step used; picks its icon and its running verb. */
export const toolKind = v.union(
  v.literal("command"),
  v.literal("read"),
  v.literal("edit"),
  v.literal("search"),
  v.literal("web"),
  v.literal("other"),
);

/**
 * A step or a helper as the sender’s Runner reports it: the agent's
 * report plus the times the Runner saw it begin and end.
 */
export const stepReport = v.object({
  key: v.string(),
  type: v.union(v.literal("tool"), v.literal("helper")),
  kind: v.optional(toolKind),
  name: v.optional(v.string()),
  title: v.string(),
  detail: v.optional(v.string()),
  text: v.optional(v.string()),
  state: stepState,
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
});

/** The step in progress, kept on the turn so the closed actions line needs no step rows. */
const currentStep = v.object({
  type: v.union(v.literal("tool"), v.literal("helper")),
  kind: v.optional(toolKind),
  name: v.optional(v.string()),
  title: v.string(),
  startedAt: v.number(),
});
/**
 * What a thread's next turn uses, as the agent row shows it: the agent (with
 * its name, so a removed agent can still be named), model, level (`effort`),
 * speed, mode and permission level. A level, speed or mode is absent when the
 * agent offers none.
 */
export const choiceFields = {
  agent: who,
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  speed: v.optional(v.string()),
  mode: v.optional(v.string()),
  access,
};
const choices = v.object(choiceFields);
export type Choices = Infer<typeof choices>;

export default defineSchema({
  /**
   * The thread's agent, model, level, speed, mode and permission level. They belong
   * to the thread, can change at any time and apply to its next turn; each turn
   * records what it used. Written when a picker changes and when a turn begins
   * (that is how a new thread's first Send stores them).
   */
  choices: defineTable({
    threadId: v.string(),
    ...choiceFields,
    updatedAt: v.number(),
  }).index("by_threadId", ["threadId"]),

  /**
   * One agent turn in a chat thread: the person's message, the reply `ai`
   * writes into chat, who sent it and what answered. Ids of chat's rows are
   * stored as strings because they belong to another plugin.
   */
  turns: defineTable({
    threadId: v.string(),
    /** The message that began the turn. */
    messageId: v.string(),
    /** Chat's reply message the agent's text streams into. */
    replyId: v.optional(v.string()),
    /**
     * Who sent the message and from which device. Only a Runner on that device
     * runs the turn, and only it may write to the turn: the same person on a
     * second computer may not.
     */
    sender: v.object({ id: v.string(), name: v.string(), device: v.string() }),
    agent: who,
    model: v.string(),
    /** The model as the agent names it for people ("Opus 5.5"); the reply's header shows it. */
    modelName: v.optional(v.string()),
    effort: v.optional(v.string()),
    speed: v.optional(v.string()),
    mode: v.optional(v.string()),
    access,
    state: turnState,
    /** The question the turn waits on while its state is `waiting`; gone once answered. */
    question: v.optional(question),
    /**
     * The secret the Runner holds for that question: `turns:answer`
     * needs it, so only that Runner can let the turn run on. Never sent to windows.
     */
    questionToken: v.optional(v.string()),
    /** The server time of the first Stop request, which sets the Force stop deadline. */
    stoppingAt: v.optional(v.number()),
    /** Follow-up text in send order, displayed inside this turn's reply. */
    steers: v.optional(v.array(v.string())),
    /**
     * Where each steer landed in the reply's text (its length in UTF-16 units
     * when the steer was recorded), parallel to `steers`. Missing on turns whose
     * steers predate it; their reply draws the steers after the text.
     */
    steerOffsets: v.optional(v.array(v.number())),
    /** A linked steer being handed off. Only an acknowledged steer joins the history. */
    pendingSteer: v.optional(v.string()),
    /** The reply's text length when `pendingSteer` was recorded; it becomes the steer's offset. */
    pendingSteerOffset: v.optional(v.number()),
    error: v.optional(v.string()),
    /** What the turn cost, as the agent last reported it. */
    usage: v.optional(usage),
    /** The reply's text as `ai` wrote it into chat (cut at 256 KB); chat's reply is the one windows read. */
    text: v.optional(v.string()),
    /** The agent's thinking so far (cut at 256 KB), shown folded and read only when opened. */
    thinking: v.optional(v.string()),
    /** How many tool steps the turn took: the actions line's count. */
    actions: v.optional(v.number()),
    /** The latest step still running, while there is one. */
    current: v.optional(currentStep),
    /** The agent's to-do list as last reported, shown as "Tasks". */
    tasks: v.optional(v.array(task)),
    /** The agent's proposed plan (Markdown, cut at 64 KB) as last reported, shown as a card. */
    plan: v.optional(v.string()),
    /** The agent's own session, a shortcut on the computer that has it. */
    sessionId: v.optional(v.string()),
    sessionHome: v.optional(v.string()),
    /** Chat's capability for the reply, chosen by the sender’s Runner. Never sent to windows. */
    replyToken: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_threadId_startedAt", ["threadId", "startedAt"])
    .index("by_threadId_state", ["threadId", "state"])
    .index("by_threadId_state_startedAt", ["threadId", "state", "startedAt"])
    .index("by_state", ["state"])
    .index("by_messageId", ["messageId"])
    .index("by_replyId", ["replyId"]),

  /**
   * One step of a turn (a tool call) or one helper agent, in the order the
   * agent began them. The agent's later reports for the same `key` update the
   * row in place. Drawn under the reply's actions line and as helper rows.
   */
  steps: defineTable({
    turnId: v.id("turns"),
    /** Position in the turn, from 0. */
    n: v.number(),
    /** The agent's own id for the call. */
    key: v.string(),
    type: v.union(v.literal("tool"), v.literal("helper")),
    /** For a tool: what kind of tool. */
    kind: v.optional(toolKind),
    /** For a helper: its kind as its program names it ("Explore"). */
    name: v.optional(v.string()),
    title: v.string(),
    detail: v.optional(v.string()),
    /** For a helper: its answer (cut at 256 KB), read only when its row is opened. */
    text: v.optional(v.string()),
    state: stepState,
    /** As the sender's computer saw them; a step's time is the difference. */
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_turnId_n", ["turnId", "n"])
    .index("by_turnId_type_n", ["turnId", "type", "n"])
    .index("by_turnId_key", ["turnId", "key"]),
  /**
   * The last sign of life for a running or waiting turn, sent by the sender's
   * Runner every few seconds (liveness.ts). Kept apart from the turn so a
   * sign does not rewrite the turn's row or wake the windows that read it.
   */
  signs: defineTable({ turnId: v.id("turns"), at: v.number() }).index("by_turnId", ["turnId"]),
  /**
   * One row: when the server last looked for silent turns, and since when it
   * has been looking without a break. Silence counts only from `since`, so a
   * server that was down or stalled gives every app the full limit again.
   */
  sweeps: defineTable({ at: v.number(), since: v.number() }),
});
