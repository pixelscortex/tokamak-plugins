import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import type { SignIn } from "./api";
import { COMPANIES, returnPath, returnPort } from "./companies";
import { cancelSignInReturn, hasDesktopSignIn, listenForSignInReturn } from "./desktop";
const lifetime = 15 * 60_000;
/**
 * How long to wait before listening again when the port is in use, or the
 * desktop app could not listen: whatever holds the port may let it go (a
 * closed connection holds it for 30 s on macOS), and the sign-in still waits.
 */
export const RETRY_BUSY_MS = 5_000;
/** How long to wait before listening again after a cancel this page did not ask for. */
export const RETRY_CANCELLED_MS = 1_000;

/**
 * The desktop app's listener for each company's newest waiting sign-in. While
 * that sign-in waits and has not expired, a listener stays up: only its
 * return being finished, its cancel or expiry (it leaves the list, or its
 * 15 minutes pass), or the page closing stop it. A port in use or a failed
 * listen is tried again every `RETRY_BUSY_MS`, a cancel from elsewhere after
 * `RETRY_CANCELLED_MS`. Finish returns true when the sign-in can still accept
 * a retry.
 */
export function watchSignInReturns(
  waiting: () => readonly SignIn[],
  finish: (signIn: SignIn, address: string) => Promise<boolean>,
): (id: string) => boolean {
  // Each company's return address is written once, in `companies.ts`; its port and path come from there.
  const watching = COMPANIES.map((company) => {
    const [listening, setListening] = createSignal<string>();
    // Each company has one port. If several sign-ins are waiting, listen for the newest.
    const newest = () =>
      waiting().reduce<SignIn | undefined>((latest, signIn) => {
        if (signIn.company !== company || signIn.expired) return latest;
        return !latest || signIn.startedAt >= latest.startedAt ? signIn : latest;
      }, undefined);
    // The list answers again on every change on the server (and the page asks for renewals every
    // minute). An effect re-runs whenever its source is computed again, even to the same id, and
    // every re-run cancelled the listener and started another; the memo lets only a different
    // sign-in through.
    const newestId = createMemo(() => newest()?.id);
    createEffect(newestId, (id) => {
      setListening(undefined);
      const signIn = untrack(newest);
      if (!id || !signIn || !hasDesktopSignIn()) return;
      const expectedState = URL.canParse(signIn.link) ? new URL(signIn.link).searchParams.get("state") : null;
      if (!expectedState) return;
      const port = returnPort(company);
      const path = returnPath(company);
      const deadline = signIn.startedAt + lifetime;
      let pending: string | undefined;
      let stopped = false;
      let wake: (() => void) | undefined;
      /** Waits `ms`, or less when the listener is stopped meanwhile. */
      const pause = (ms: number) =>
        new Promise<void>((done) => {
          const timer = setTimeout(() => {
            wake = undefined;
            done();
          }, ms);
          wake = () => {
            clearTimeout(timer);
            done();
          };
        });
      async function listen(signIn: SignIn, state: string) {
        while (!stopped) {
          const timeoutMs = Math.ceil(deadline - Date.now());
          if (timeoutMs <= 0) return;
          const requestId = crypto.getRandomValues(new Uint32Array(4)).join("-");
          pending = requestId;
          setListening(id);
          let result: Awaited<ReturnType<typeof listenForSignInReturn>> | undefined;
          try {
            result = await listenForSignInReturn({ port, path, expectedState: state, requestId, timeoutMs });
          } catch {
            // The desktop app could not listen; the person can paste meanwhile.
            result = undefined;
          }
          pending = undefined;
          if (stopped) return;
          setListening(undefined);
          if (result?.status === "returned") {
            if (!(await finish(signIn, result.address))) return;
          } else if (result?.status === "unavailable") return;
          else if (result === undefined || result.status === "busy") await pause(RETRY_BUSY_MS);
          // Cancelled by another listen for the port, or the shell's wait ended (normally with the
          // sign-in's 15 minutes, which the loop checks): listen again while the sign-in waits.
          else await pause(RETRY_CANCELLED_MS);
        }
      }
      void listen(signIn, expectedState);
      return () => {
        stopped = true;
        wake?.();
        if (pending !== undefined) void cancelSignInReturn(port, pending).catch(() => {});
      };
    });
    return listening;
  });
  return (id) => watching.some((listening) => listening() === id);
}
