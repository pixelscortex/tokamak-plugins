import { createSignal } from "solid-js";
import type { ComposerProps } from "../ui/composer";

/** Decides, live, whether a composer's Send is held; reads any signals it likes. */
export type Hold = (composer: ComposerProps) => boolean;

// A signal over the list, so a composer on screen re-reads it when a hold is
// added or removed; each hold's own reads keep it live after that.
const [holds, setHolds] = createSignal<readonly Hold[]>([], { ownedWrite: true });

/**
 * Turns Send off in every composer for which `when` returns true, until the
 * returned function is called (from `onCleanup` when registered inside a
 * component). Chat does not know why: another plugin decides, e.g. `ai` while
 * the thread's agent is missing or signed out. Enter is held too.
 *
 * ```ts
 * onCleanup(holdSend((composer) => composer.threadId === props.threadId && !ready()));
 * ```
 */
export function holdSend(when: Hold): () => void {
  setHolds((all) => [...all, when]);
  return () => setHolds((all) => all.filter((hold) => hold !== when));
}

/** True while any hold keeps this composer from sending. */
export function isHeld(composer: ComposerProps): boolean {
  return holds().some((hold) => hold(composer));
}
