import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { render } from "@solidjs/web";
import { afterEach, expect, test, vi } from "vitest";
import { TokamakClient, fail, type ClientTransport, type JsonValue } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import type { SignIn, Subscription } from "../src/client/lib/api";
import { Profiles, RENEW_EVERY_MS } from "../src/client/pages/profiles";

// The Profiles screen with a stand-in server: `list` answers with what
// `listed` holds, and every call the window makes is recorded in `calls`. The
// server side of the same flow runs for real in agent-proxy's sign-in tests.

const LINK = "https://claude.example/oauth/authorize?code=true&state=abc";
const waiting: SignIn = {
  id: "agent-proxy/signIns:s1",
  company: "anthropic",
  method: "subscription",
  link: LINK,
  startedAt: 1,
  expired: false,
};
const pro: Subscription = {
  id: "agent-proxy/subscriptions:sub1",
  company: "anthropic",
  method: "subscription",
  label: "Personal",
  plan: "Pro",
  enabled: true,
  status: "ok",
  accounts: [
    { id: "agent-proxy/accounts:a1", email: "you@example.test", organization: "Fake Org", status: "ok" },
  ],
  models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
  createdAt: 1,
};
const failure = (kind: string, message: string) => ({ failed: true, kind, data: { message } });

let listed: { subscriptions: Subscription[]; signIns: SignIn[] } = { subscriptions: [], signIns: [] };
/** Each call's answer: a value, or a function of the arguments (which may hold a promise open). */
let answers: Record<string, JsonValue | ((args: JsonValue) => Promise<JsonValue>)> = {};
const calls: [string, JsonValue][] = [];
const listeners = new Set<() => void>();
const copied: string[] = [];

/** A caller action can list agent marks only when a Runner can answer. */
function client(hasRunner: boolean): TokamakClient {
  const call = async (name: string, args: JsonValue) => {
    calls.push([name, args]);
    const answer = answers[name];
    return typeof answer === "function" ? answer(args) : (answer ?? null);
  };
  const transport: ClientTransport = {
    query: call,
    mutation: call,
    action: (name, args) => {
      if (name !== "ai/agents:list") return call(name, args);
      return Promise.resolve(hasRunner ? (agents as JsonValue) : fail("noMachine", null));
    },
    subscribe(name, _args, onEvent) {
      // The Profiles section's own list; its tests are in profiles-section.test.tsx.
      if (name === "ai-profiles/profiles:list") {
        queueMicrotask(() => onEvent({ value: [] }));
        return () => {};
      }
      if (name !== "ai-profiles/subscriptions:list") throw new Error(`Unexpected query ${name}`);
      const send = () => onEvent({ value: structuredClone(listed) as unknown as JsonValue });
      listeners.add(send);
      queueMicrotask(send);
      return () => listeners.delete(send);
    },
  };
  const agents = [
    {
      id: "claude",
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></svg>',
    },
  ];
  return new TokamakClient(transport);
}

function update(next: typeof listed) {
  listed = next;
  for (const send of listeners) send();
}

const cleanups: (() => void)[] = [];
function mount({ hasRunner = false } = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(
    () => (
      <ClientContext value={client(hasRunner)}>
        <Profiles />
      </ClientContext>
    ),
    root,
  );
  const unmount = () => {
    dispose();
    root.remove();
  };
  cleanups.push(unmount);
  return unmount;
}
afterEach(async () => {
  // A dialog left open would carry into the next test's page: close it and let it go first.
  for (const close of document.querySelectorAll<HTMLElement>('[role="dialog"] [aria-label="Close"]'))
    close.click();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
  listed = { subscriptions: [], signIns: [] };
  answers = {};
  calls.length = 0;
  copied.length = 0;
});

// Order matters in one way: in jsdom, a dialog opened after an earlier test left
// its own dialog on a failed sign-in showed that earlier step again, so the test
// that ends on "Start again" runs last. Not seen in the browser run.
const named = (name: string) => calls.filter(([called]) => called === `ai-profiles/subscriptions:${name}`);
const pasteField = (dialog: HTMLElement) =>
  within(dialog).getByRole("textbox", { name: /Address the sign-in/ });

test("the dialog runs company, method, sign-in and connected, and the card shows what was found", async () => {
  const user = userEvent.setup({ document });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
  answers["ai-profiles/subscriptions:startSignIn"] = waiting as unknown as JsonValue;
  answers["ai-profiles/subscriptions:finishSignIn"] = pro as unknown as JsonValue;
  mount();
  await user.click(await screen.findByRole("button", { name: "Add subscription" }));

  // Company: Anthropic and OpenAI are offered; "More later" is listed, not offered.
  const dialog = await screen.findByRole("dialog", { name: "Add subscription" });
  expect(within(dialog).getByRole("button", { name: /OpenAI/ })).toBeTruthy();
  expect(within(dialog).getByText("More later")).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: /Anthropic/ }));

  // Method: the API key is shown as coming later and cannot be picked.
  const method = await screen.findByRole("dialog", { name: "Anthropic" });
  expect(within(method).queryByRole("button", { name: /API key/ })).toBeNull();
  expect(within(method).getByText("Later")).toBeTruthy();
  await user.click(within(method).getByRole("button", { name: /Claude subscription/ }));
  expect(named("startSignIn")).toEqual([
    ["ai-profiles/subscriptions:startSignIn", { company: "anthropic", method: "subscription" }],
  ]);

  // Sign-in: the page opens in a new tab, "Copy link" copies the same link, it says it waits,
  // and the field for the address the browser ends on is there without opening anything.
  const signIn = await screen.findByRole("dialog", { name: "Sign in to Claude" });
  const open = within(signIn).getByRole("link", { name: "Open sign-in page" });
  expect(open.getAttribute("href")).toBe(LINK);
  expect(open.getAttribute("target")).toBe("_blank");
  await user.click(within(signIn).getByRole("button", { name: "Copy link" }));
  expect(copied).toEqual([LINK]);
  // A plain browser has no listener: one line says what to do, and the field is right under it.
  expect(
    within(signIn).getByText(
      "Sign in in your browser. It ends on a page that may not load. Copy its whole address and paste it here.",
    ),
  ).toBeTruthy();
  expect(within(signIn).queryByText(/finishes by itself/)).toBeNull();
  await user.type(pasteField(signIn), "http://localhost:54545/callback?code=the-code&state=abc");
  await user.click(within(signIn).getByRole("button", { name: "Continue" }));
  expect(named("finishSignIn")).toEqual([
    [
      "ai-profiles/subscriptions:finishSignIn",
      { id: waiting.id, pasted: "http://localhost:54545/callback?code=the-code&state=abc" },
    ],
  ]);

  // Connected: plan, email and models found, then a label.
  const connected = await screen.findByRole("dialog", { name: "Connected" });
  expect(within(connected).getByText("Claude Pro")).toBeTruthy();
  expect(within(connected).getByText("you@example.test")).toBeTruthy();
  expect(within(connected).getByText("1 model found")).toBeTruthy();
  expect(
    within(within(connected).getByRole("list", { name: "Models" })).getByText("Sonnet 4.6"),
  ).toBeTruthy();
  const label = within(connected).getByRole("textbox", { name: "Label" });
  await user.clear(label);
  await user.type(label, "Home");
  await user.click(within(connected).getByRole("button", { name: "Done" }));
  expect(named("setLabel")).toEqual([["ai-profiles/subscriptions:setLabel", { id: pro.id, label: "Home" }]]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  update({ subscriptions: [{ ...pro, label: "Home" }], signIns: [] });
  const card = await screen.findByRole("article", { name: "Claude Pro, Home" });
  for (const text of ["you@example.test", "Fake Org", "OK", "1 model · not used yet"])
    expect(within(card).getByText(text)).toBeTruthy();
  // The Enabled switch tells the server.
  await user.click(within(card).getByRole("switch", { name: "Claude Pro, Home enabled" }));
  expect(named("setEnabled")).toEqual([
    ["ai-profiles/subscriptions:setEnabled", { id: pro.id, enabled: false }],
  ]);
});

test("a closed dialog leaves an Awaiting sign-in card that reopens it or cancels the sign-in", async () => {
  const user = userEvent.setup({ document });
  listed = { subscriptions: [], signIns: [waiting] };
  mount();
  const card = await screen.findByRole("article", { name: "Claude, awaiting sign-in" });
  await user.click(within(card).getByRole("button", { name: "Continue" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude" });
  expect(within(dialog).getByRole("link", { name: "Open sign-in page" }).getAttribute("href")).toBe(LINK);
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // Closing stopped nothing.
  expect(named("cancelSignIn")).toEqual([]);

  await user.click(within(card).getByRole("button", { name: "Cancel" }));
  expect(named("cancelSignIn")).toEqual([["ai-profiles/subscriptions:cancelSignIn", { id: waiting.id }]]);
});

test("an open dialog follows its sign-in ending in another window", async () => {
  const user = userEvent.setup({ document });
  listed = { subscriptions: [], signIns: [{ ...waiting, startedAt: 10 }] };
  mount();
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await screen.findByRole("dialog", { name: "Sign in to Claude" });
  // Finished elsewhere: a subscription made after it started appears, and the dialog moves on.
  update({ subscriptions: [{ ...pro, createdAt: 20 }], signIns: [] });
  expect(await screen.findByRole("dialog", { name: "Connected" })).toBeTruthy();
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));

  // Cancelled elsewhere: the dialog closes and the screen says why.
  const other = { ...waiting, id: "agent-proxy/signIns:s2", startedAt: 30 };
  update({ subscriptions: [{ ...pro, createdAt: 20 }], signIns: [other] });
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await screen.findByRole("dialog", { name: "Sign in to Claude" });
  update({ subscriptions: [{ ...pro, createdAt: 20 }], signIns: [] });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("alert").textContent).toMatch(/cancelled in another window/);
});

test("a signed-out card signs in again in place, and a failure to start is said, not thrown", async () => {
  const user = userEvent.setup({ document });
  answers["ai-profiles/subscriptions:startSignIn"] = failure("NotFound", "That subscription is gone.");
  listed = {
    subscriptions: [
      { ...pro, status: "signed-out", reason: "Claude would not renew the login. Sign in again." },
    ],
    signIns: [],
  };
  mount();
  const card = await screen.findByRole("article", { name: "Claude Pro, Personal" });
  expect(within(card).getByText("Signed out")).toBeTruthy();
  await user.click(within(card).getByRole("button", { name: "Sign in" }));
  expect((await screen.findByRole("alert")).textContent).toBe("That subscription is gone.");
  expect(screen.queryByRole("dialog")).toBeNull();

  answers["ai-profiles/subscriptions:startSignIn"] = { ...waiting, repair: pro.id };
  await user.click(within(card).getByRole("button", { name: "Sign in" }));
  expect(named("startSignIn").at(-1)).toEqual([
    "ai-profiles/subscriptions:startSignIn",
    { company: "anthropic", method: "subscription", repair: pro.id },
  ]);
  expect(await screen.findByRole("dialog", { name: "Sign in to Claude" })).toBeTruthy();
});

test("with nothing added the screen says so, and renewal is asked on open, every minute, and not after leaving", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const unmount = mount();
  expect(await screen.findByText(/No subscriptions yet/)).toBeTruthy();
  expect(named("renew")).toHaveLength(1);
  vi.advanceTimersByTime(RENEW_EVERY_MS);
  expect(named("renew")).toHaveLength(2);
  unmount();
  vi.advanceTimersByTime(RENEW_EVERY_MS * 3);
  expect(named("renew")).toHaveLength(2);
});

test("company logos come from the agents' marks in the desktop app, and a plain browser shows the neutral mark", async () => {
  listed = { subscriptions: [pro], signIns: [] };
  mount({ hasRunner: false });
  const plain = await screen.findByRole("article", { name: "Claude Pro, Personal" });
  expect(plain.querySelector("[data-mark]")?.getAttribute("data-mark")).toBe("neutral");
  for (const cleanup of cleanups.splice(0)) cleanup();

  mount({ hasRunner: true });
  const desktop = await screen.findByRole("article", { name: "Claude Pro, Personal" });
  await waitFor(() => expect(desktop.querySelector("[data-mark]")?.getAttribute("data-mark")).toBe("agent"));
});

test("an expired sign-in says so on the card and in the dialog, and starts again", async () => {
  const user = userEvent.setup({ document });
  listed = { subscriptions: [], signIns: [{ ...waiting, expired: true }] };
  answers["ai-profiles/subscriptions:startSignIn"] = { ...waiting, id: "agent-proxy/signIns:s3" };
  mount();
  const card = await screen.findByRole("article", { name: "Claude, sign-in expired" });
  expect(within(card).getByText(/expired after 15 minutes/)).toBeTruthy();
  await user.click(within(card).getByRole("button", { name: "Start again" }));
  expect(named("startSignIn")).toEqual([
    ["ai-profiles/subscriptions:startSignIn", { company: "anthropic", method: "subscription" }],
  ]);
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude" });
  expect(pasteField(dialog)).toBeTruthy();
});

test("a wrong paste keeps the sign-in waiting; a double press finishes once; an ended one offers Start again", async () => {
  const user = userEvent.setup({ document });
  listed = { subscriptions: [], signIns: [waiting] };
  answers["ai-profiles/subscriptions:finishSignIn"] = failure(
    "Refused",
    "Claude did not accept that code. Paste the whole address again, or open the sign-in page again for a new code.",
  );
  mount();
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude" });
  await user.type(pasteField(dialog), "half-a-cod");
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect((await within(dialog).findByRole("alert")).textContent).toMatch(/did not accept that code/);
  // Still waiting: the same field, the page link, no "Start again".
  expect(pasteField(dialog)).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "Start again" })).toBeNull();

  // A slow finish: pressing again while it runs sends nothing more.
  let release: (value: JsonValue) => void = () => {};
  answers["ai-profiles/subscriptions:finishSignIn"] = () => new Promise((done) => (release = done));
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect(within(dialog).getByRole("button", { name: "Continue" }).getAttribute("aria-busy")).toBe("true");
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect(named("finishSignIn")).toHaveLength(2);
  release(failure("AlreadyAdded", 'you@example.test is already added as "Personal".'));
  expect((await within(dialog).findByRole("alert")).textContent).toMatch(/already added/);
  expect(within(dialog).getByRole("button", { name: "Start again" })).toBeTruthy();
});
