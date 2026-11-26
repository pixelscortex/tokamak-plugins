/// <reference types="node" />
// The Runner holds questions and their tokens in memory. Only a call scoped
// to the originating window ID can retrieve the token and answer a question.
import { randomBytes, randomUUID } from "node:crypto";
import type { Id, CallerActionContext } from "@tokamak/sdk";
import type { TurnAnswer } from "@tokamak/sdk/agent-turn";
import type { Access, Question } from "../contracts";
import { api } from "./_generated/api";

interface Pending {
  readonly questionId: string;
  /** The originating window’s ID, scoped to its user and device. */
  readonly owner: string;
  readonly token: string;
  resolve(answer: TurnAnswer): void;
}

/** The question each turn waits on, by turn id. */
const waiting = new Map<string, Pending>();

/**
 * Kinds of question answered "Always allow this session", for the agent
 * session and window ID they were given in. A turn that does not carry on that session
 * (a fresh one, or another agent's in between) starts with none.
 */
const allowed = new Map<string, { sessionId?: string; kinds: Set<string> }>();

/** Where a thread's allows are kept: one agent's session in one thread and window. */
export function sessionKey(owner: string, threadId: string, agentId: string): string {
  return JSON.stringify([owner, threadId, agentId]);
}

/** The question `questionId` if this window's turn `turnId` still waits on it. */
export function pendingQuestion(owner: string, turnId: string, questionId: string): Pending | undefined {
  const pending = waiting.get(turnId);
  return pending?.owner === owner && pending.questionId === questionId ? pending : undefined;
}

/** Hands `answer` to the agent, once: false when the question was answered or cancelled meanwhile. */
export function settle(turnId: string, pending: Pending, answer: TurnAnswer): boolean {
  if (waiting.get(turnId) !== pending) return false;
  waiting.delete(turnId);
  pending.resolve(answer);
  return true;
}

/**
 * `run.ask` for one turn, and `end` for when it is over. Full access approves
 * at once and shows nothing; so does a kind allowed in the session this turn
 * carries on (`carried`). Otherwise the turn waits (`turns:ask`) until the
 * card's answer reaches `settle`, with no time limit. Questions asked at once
 * wait in a queue: the turn shows one at a time.
 */
export function asking(
  ctx: CallerActionContext,
  turn: { owner: string; turnId: Id<"turns">; access: Access; session: string; carried: string | undefined },
) {
  const { owner, turnId, access, session, carried } = turn;
  const kept = allowed.get(session);
  const allows = carried !== undefined && kept?.sessionId === carried ? kept : { kinds: new Set<string>() };
  allowed.set(session, allows);
  let current = carried;
  let expired = false;
  let stopping = false;
  function sessionChanged(sessionId: string | undefined) {
    if (current !== undefined && current !== sessionId) allows.kinds.clear();
    current = sessionId;
  }
  function expire() {
    expired = true;
    const pending = waiting.get(turnId);
    if (pending) settle(turnId, pending, "cancel");
  }
  ctx.signal.addEventListener("abort", expire, { once: true });

  async function askNow(question: Question): Promise<TurnAnswer> {
    if (expired || ctx.signal.aborted) return "cancel";
    if (stopping) return "stopping";
    if (access === "full" || allows.kinds.has(question.kind)) return "approve";
    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    const answered = new Promise<TurnAnswer>((resolve) =>
      waiting.set(turnId, { owner, questionId: id, token, resolve }),
    );
    try {
      await ctx.runMutation(api.turns.ask, {
        turnId,
        token,
        question: { id, kind: question.kind, action: question.action, subject: question.subject },
      });
    } catch (cause) {
      waiting.delete(turnId);
      throw cause;
    }
    const answer = await answered;
    if (answer === "approveSession") allows.kinds.add(question.kind);
    return answer;
  }

  let queue: Promise<unknown> = Promise.resolve();
  return {
    /**
     * Stop's hook (`turnControl` calls it before the agent's `onStop`): the
     * waiting question is cleared on the row the way an answer clears it and
     * resolves "stopping"; every later ask resolves "stopping" at once.
     */
    async cancel(): Promise<void> {
      stopping = true;
      const pending = waiting.get(turnId);
      if (!pending) return;
      // If someone answered in the meantime, settle leaves their answer in place.
      await ctx
        .runMutation(api.turns.answer, { turnId, questionId: pending.questionId, token: pending.token })
        .catch(() => {});
      settle(turnId, pending, "stopping");
      // Let the agent act on the answer (its `ask` resumes in microtasks) before Stop calls its
      // `onStop`: a program reading its input in order must get the answer before the interrupt.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    ask(question: Question): Promise<TurnAnswer> {
      const next = queue.then(() => askNow(question));
      queue = next.catch(() => {});
      return next;
    },
    sessionChanged,
    /** The linked provider ended; no question can outlive its channel. */
    expire,
    /** The turn ended: its allows belong to the session the agent returned, or to none. */
    end(sessionId: string | undefined): void {
      ctx.signal.removeEventListener("abort", expire);
      waiting.delete(turnId);
      sessionChanged(sessionId);
      if (sessionId === undefined) allowed.delete(session);
      else allows.sessionId = sessionId;
    },
  };
}
