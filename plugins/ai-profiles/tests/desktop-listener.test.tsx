import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TokamakClient, type ClientTransport, type JsonValue } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import type { SignIn } from "../src/client/lib/api";
import * as desktop from "../src/client/lib/desktop";
import { RETRY_BUSY_MS, RETRY_CANCELLED_MS } from "../src/client/lib/sign-in-return";
import { Profiles, RENEW_EVERY_MS } from "../src/client/pages/profiles";

// The desktop app's listener stays up for as long as a sign-in waits. A slow
// sign-in (an email code, a consent page) takes minutes, and meanwhile the list
// answers again (every change on the server; the page asks for renewals every
// minute). Each new answer used to cancel the listener and start another; once
// the shell said "busy" (a connection it closed itself holds the port for 30 s on
// macOS) or the listen failed, the page never listened again, and the browser's
// return found nothing on the port. Only finishing, cancelling, expiry or leaving
// the page stop it now.

vi.mock("../src/client/lib/desktop", () => ({
  hasDesktopSignIn: vi.fn(),
  listenForSignInReturn: vi.fn(),
  cancelSignInReturn: vi.fn(),
  openSignInBrowser: vi.fn(),
}));

type Return = Awaited<ReturnType<typeof desktop.listenForSignInReturn>>;
const never = () => new Promise<Return>(() => {});

let unmount: (() => void) | undefined;
/** The page with one Claude sign-in waiting; `renew` answers the list again, as a renewed login does. */
function mount(startedAt = Date.now()) {
  const signIn: SignIn = {
    id: "agent-proxy/signIns:slow",
    company: "anthropic",
    method: "subscription",
    link: "https://claude.example/oauth/authorize?state=slow-state",
    startedAt,
    expired: false,
  };
  let listed = { signIns: [signIn], subscriptions: [] };
  let publish = () => {};
  const renewals = vi.fn();
  const transport: ClientTransport = {
    query: async () => null,
    mutation: async () => null,
    action: async (name) => {
      if (name.endsWith(":renew")) {
        renewals();
        queueMicrotask(publish);
      }
      return null;
    },
    subscribe(name, _args, onEvent) {
      if (name === "ai-profiles/profiles:list") {
        queueMicrotask(() => onEvent({ value: [] }));
        return () => {};
      }
      publish = () => onEvent({ value: structuredClone(listed) as unknown as JsonValue });
      queueMicrotask(publish);
      return () => {};
    },
  };
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(
    () => (
      <ClientContext value={new TokamakClient(transport)}>
        <Profiles />
      </ClientContext>
    ),
    root,
  );
  unmount = () => {
    dispose();
    root.remove();
    unmount = undefined;
  };
  return {
    signIn,
    renewals,
    /** The list answers again, the same or with `next`. */
    answer(next?: Partial<typeof listed>) {
      listed = { ...listed, ...next };
      publish();
    },
  };
}

const listens = () => vi.mocked(desktop.listenForSignInReturn).mock.calls.length;
const cancels = () => vi.mocked(desktop.cancelSignInReturn).mock.calls;
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.resetAllMocks();
  vi.mocked(desktop.hasDesktopSignIn).mockReturnValue(true);
  vi.mocked(desktop.cancelSignInReturn).mockResolvedValue(undefined);
});
afterEach(() => {
  unmount?.();
  document.body.replaceChildren();
  vi.useRealTimers();
});

test("a sign-in that waits for minutes keeps one listener across list answers and renewal ticks", async () => {
  vi.mocked(desktop.listenForSignInReturn).mockImplementation(never);
  const { renewals, answer } = mount();
  await settle();
  expect(listens()).toBe(1);
  for (let minute = 1; minute <= 3; minute++) {
    answer();
    answer();
    await vi.advanceTimersByTimeAsync(RENEW_EVERY_MS);
    expect(renewals).toHaveBeenCalledTimes(minute + 1);
  }
  expect(listens()).toBe(1);
  expect(cancels()).toEqual([]);
});

test("a port in use is tried again on a slow interval while the sign-in waits", async () => {
  vi.mocked(desktop.listenForSignInReturn)
    .mockResolvedValueOnce({ status: "busy" })
    .mockResolvedValueOnce({ status: "busy" })
    .mockImplementation(never);
  mount();
  await settle();
  expect(listens()).toBe(1);
  await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS - 1);
  expect(listens()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(listens()).toBe(2);
  await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS);
  expect(listens()).toBe(3);
  await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS * 4);
  expect(listens()).toBe(3);
});

test("a listen the desktop app could not start is tried again too", async () => {
  vi.mocked(desktop.listenForSignInReturn)
    .mockRejectedValueOnce(new Error("Could not listen for sign-in"))
    .mockImplementation(never);
  mount();
  await settle();
  await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS);
  expect(listens()).toBe(2);
});

test("a cancel the page did not ask for leads to listening again", async () => {
  vi.mocked(desktop.listenForSignInReturn)
    .mockResolvedValueOnce({ status: "cancelled" })
    .mockImplementation(never);
  mount();
  await settle();
  await vi.advanceTimersByTimeAsync(RETRY_CANCELLED_MS);
  expect(listens()).toBe(2);
  expect(cancels()).toEqual([]);
});

test("leaving the page stops the listener and any retry", async () => {
  vi.mocked(desktop.listenForSignInReturn)
    .mockResolvedValueOnce({ status: "busy" })
    .mockImplementation(never);
  mount();
  await settle();
  await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS);
  expect(listens()).toBe(2);
  const [{ requestId }] = vi.mocked(desktop.listenForSignInReturn).mock.calls[1]!;
  unmount!();
  expect(cancels()).toEqual([[54545, requestId]]);
  await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS * 3);
  expect(listens()).toBe(2);
});

test("a sign-in that leaves the list, or expires, stops the listener and its retries", async () => {
  vi.mocked(desktop.listenForSignInReturn).mockImplementation(never);
  const { signIn, answer } = mount();
  await settle();
  const [{ requestId }] = vi.mocked(desktop.listenForSignInReturn).mock.calls[0]!;
  answer({ signIns: [{ ...signIn, expired: true }] });
  await settle();
  expect(cancels()).toEqual([[54545, requestId]]);
  await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS * 3);
  expect(listens()).toBe(1);
});

test("the listener stops at the sign-in's 15 minutes even while the list still shows it waiting", async () => {
  vi.mocked(desktop.listenForSignInReturn).mockResolvedValue({ status: "busy" });
  mount(Date.now() - 15 * 60_000 + RETRY_BUSY_MS + 1);
  await settle();
  await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS);
  expect(listens()).toBe(2);
  await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS * 3);
  expect(listens()).toBe(2);
});
