import type { Id } from "@tokamak/sdk";

/** What a Send stored, as other plugins (e.g. `ai` beginning a turn) see it. */
export interface Sent {
  readonly threadId: Id<"threads">;
  readonly messageId: Id<"messages">;
  readonly text: string;
  /**
   * The thread's folder on this computer, made if it was "No folder". Undefined
   * in a window without a Runner, where nothing can work in it.
   */
  readonly folder: string | undefined;
  /** True for the Send that created the thread. */
  readonly first: boolean;
}

const listeners = new Set<(sent: Sent) => void>();

/**
 * Runs `listener` after every Send in this window, once the message is stored
 * and the thread's folder exists. Returns the function that stops listening;
 * call it from `onCleanup` when registering inside a component.
 */
export function onSent(listener: (sent: Sent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Chat calls this. A listener that throws does not stop the others; its error
 * is rethrown on its own so the window reports it against that plugin.
 */
export function announceSent(sent: Sent): void {
  for (const listener of [...listeners]) {
    try {
      listener(sent);
    } catch (cause) {
      queueMicrotask(() => {
        throw cause;
      });
    }
  }
}

export type DraftIntent = "steer" | "queue";

export interface DraftSubmission {
  readonly threadId: Id<"threads">;
  readonly text: string;
  readonly intent: DraftIntent;
}

type Submit = (draft: DraftSubmission) => Promise<boolean>;
const submitters = new Set<Submit>();

/** A listener may store an open thread's draft itself and return true to consume the Send. */
export function onDraftSubmit(listener: Submit): () => void {
  submitters.add(listener);
  return () => submitters.delete(listener);
}

export async function submitDraft(draft: DraftSubmission): Promise<boolean> {
  for (const submit of submitters) if (await submit(draft)) return true;
  return false;
}
