import { isFailure, type Id, type TokamakClient } from "@tokamak/sdk";
import { state } from "@tokamak/sdk/client";
import type { Answer } from "../../contracts";
import { api } from "./agents";
import { windowAction } from "./window-actions";

/** A question waiting for this person's answer on this device, as `turns:questions` lists it. */
export interface Waiting {
  readonly id: string;
  readonly turnId: Id<"turns">;
  readonly threadId: string;
  /** The agent's name as people see it: "Claude". */
  readonly agent: string;
  readonly action: string;
  readonly subject: string;
}

/** Every question waiting for this person on this device; empty until the row has connected. */
const waiting = state<readonly Waiting[]>([]);

let watching: TokamakClient | undefined;
let stop: (() => void) | undefined;

/**
 * Follows the questions waiting for this person on this device, once per
 * window connection. Started by the agent row with the window's client, so
 * the card's `when` can read `questionFor` without a subscription per composer.
 */
export function watchQuestions(client: TokamakClient): void {
  if (watching === client) return;
  stop?.();
  watching = client;
  stop = client.subscribe(api.turns.questions, {}, (event) => {
    if ("value" in event) waiting.set(event.value);
  });
}

/** The question waiting in `threadId`, if any; reactive. */
export function questionFor(threadId: string | undefined): Waiting | undefined {
  return threadId === undefined ? undefined : waiting().find((question) => question.threadId === threadId);
}

/** The four answers in key order: keys 1 to 4 on the card. */
export const answers: readonly { readonly answer: Answer; readonly label: string }[] = [
  { answer: "approve", label: "Approve" },
  { answer: "approveSession", label: "Always allow this session" },
  { answer: "decline", label: "Decline" },
  { answer: "cancel", label: "Cancel" },
];

/**
 * Whether the calling window’s Runner still holds the question. False for a
 * question from before the app quit: the card says it expired straight away.
 */
export async function stillAsked(client: TokamakClient, question: Waiting): Promise<boolean> {
  return (
    (await windowAction(client, api.run.pending, { turnId: question.turnId, questionId: question.id })) ===
    true
  );
}

/**
 * Sends the answer to the calling window’s Runner, which runs the turn. Resolves
 * false when the question has expired (the app that asked it has quit).
 */
export async function sendAnswer(client: TokamakClient, question: Waiting, answer: Answer): Promise<boolean> {
  const result = await windowAction(client, api.run.answer, {
    turnId: question.turnId,
    questionId: question.id,
    answer,
  });
  return !isFailure(result);
}
