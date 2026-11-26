import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { render } from "@solidjs/web";
import { afterEach, expect, test } from "vitest";
import { TokamakClient, type ClientTransport, type JsonValue } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import type { SignIn, Subscription } from "../src/client/lib/api";
import { Profiles } from "../src/client/pages/profiles";
import { returnPath, returnPort } from "../src/client/lib/companies";

// The OpenAI path of the add-subscription dialog and the ChatGPT card, with a
// stand-in server (the same harness as profiles.test.tsx, kept separate so
// the Claude tests stay as they are). The dialog is one flow for both
// companies: these check that OpenAI goes through it with its own words and
// logo, and that every call names the company. The server side runs for real
// in agent-proxy's chatgpt-sign-in.test.ts.

const LINK = "https://auth.openai.example/oauth/authorize?state=abc";
const waiting: SignIn = {
  id: "agent-proxy/signIns:s2",
  company: "openai",
  method: "subscription",
  link: LINK,
  startedAt: 1,
  expired: false,
};
const business: Subscription = {
  id: "agent-proxy/subscriptions:sub2",
  company: "openai",
  method: "subscription",
  label: "",
  plan: "Business",
  enabled: true,
  status: "ok",
  accounts: [{ id: "agent-proxy/accounts:a2", email: "you@acme.test", organization: "Acme", status: "ok" }],
  models: [
    { id: "gpt-5", name: "GPT-5" },
    { id: "gpt-5-codex", name: "GPT-5 Codex" },
  ],
  createdAt: 2,
};
const claude: Subscription = {
  ...business,
  id: "agent-proxy/subscriptions:sub1",
  company: "anthropic",
  label: "Personal",
  plan: "Max",
  accounts: [{ id: "agent-proxy/accounts:a1", email: "you@example.test", status: "ok" }],
  models: [{ id: "claude-opus", name: "Claude Opus" }],
  createdAt: 1,
};

let listed: { subscriptions: Subscription[]; signIns: SignIn[] } = { subscriptions: [], signIns: [] };
let answers: Record<string, JsonValue> = {};
const calls: [string, JsonValue][] = [];
const listeners = new Set<() => void>();

/** A desktop window: its Runner lists both agents’ marks through the caller action. */
function client(): TokamakClient {
  const call = async (name: string, args: JsonValue) => {
    calls.push([name, args]);
    return answers[name] ?? null;
  };
  const transport: ClientTransport = {
    query: call,
    mutation: call,
    action: async (name, args) => (name === "ai/agents:list" ? agents : call(name, args)),
    subscribe(name, _args, onEvent) {
      // The Profiles section's own list (TKM-264): none here.
      if (name === "ai-profiles/profiles:list") {
        queueMicrotask(() => onEvent({ value: [] }));
        return () => {};
      }
      const send = () => onEvent({ value: structuredClone(listed) as unknown as JsonValue });
      listeners.add(send);
      queueMicrotask(send);
      return () => listeners.delete(send);
    },
  };
  const mark = (d: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  const agents = [
    { id: "claude", icon: mark("M1 1h22v22H1z") },
    { id: "codex", icon: mark("M2 2h20v20H2z") },
  ];
  return new TokamakClient(transport);
}

function update(next: typeof listed) {
  listed = next;
  for (const send of listeners) send();
}

const cleanups: (() => void)[] = [];
function mount() {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(
    () => (
      <ClientContext value={client()}>
        <Profiles />
      </ClientContext>
    ),
    root,
  );
  cleanups.push(() => {
    dispose();
    root.remove();
  });
}
afterEach(async () => {
  for (const close of document.querySelectorAll<HTMLElement>('[role="dialog"] [aria-label="Close"]'))
    close.click();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  listed = { subscriptions: [], signIns: [] };
  answers = {};
  calls.length = 0;
});
const named = (name: string) => calls.filter(([called]) => called === `ai-profiles/subscriptions:${name}`);
/** The mark a card or step draws: the agent's own outline, not the neutral stand-in. */
const markIn = (element: HTMLElement) => element.querySelector('[data-mark="agent"] path')?.getAttribute("d");

test("OpenAI goes through the same steps as Anthropic, with ChatGPT's words, logo and return address", async () => {
  const user = userEvent.setup({ document });
  answers["ai-profiles/subscriptions:startSignIn"] = waiting as unknown as JsonValue;
  answers["ai-profiles/subscriptions:finishSignIn"] = business as unknown as JsonValue;
  mount();
  await user.click(await screen.findByRole("button", { name: "Add subscription" }));
  const company = await screen.findByRole("dialog", { name: "Add subscription" });
  await user.click(within(company).getByRole("button", { name: /OpenAI/ }));

  // Method: "ChatGPT subscription" with its plans; the API key is listed as coming later and cannot be picked.
  const method = await screen.findByRole("dialog", { name: "OpenAI" });
  expect(markIn(method)).toBe("M2 2h20v20H2z");
  expect(within(method).getByText("Plus · Pro · Business · Enterprise")).toBeTruthy();
  expect(within(method).getByText("From the OpenAI platform")).toBeTruthy();
  expect(within(method).queryByRole("button", { name: /API key/ })).toBeNull();
  expect(within(method).getByText("Later")).toBeTruthy();
  await user.click(within(method).getByRole("button", { name: /ChatGPT subscription/ }));
  expect(named("startSignIn")).toEqual([
    ["ai-profiles/subscriptions:startSignIn", { company: "openai", method: "subscription" }],
  ]);

  // Sign-in: Claude's step word for word, with ChatGPT's title and port 1455 in the field's example.
  const signIn = await screen.findByRole("dialog", { name: "Sign in to ChatGPT" });
  expect(within(signIn).getByRole("link", { name: "Open sign-in page" }).getAttribute("href")).toBe(LINK);
  expect(within(signIn).getByText(/ends on a page that may not load/)).toBeTruthy();
  const field = within(signIn).getByRole("textbox", { name: /Address the sign-in/ });
  expect(field.getAttribute("placeholder")).toBe("http://localhost:1455/auth/callback?code=…");
  const pasted = "http://localhost:1455/auth/callback?code=the-code&state=abc";
  await user.type(field, pasted);
  await user.click(within(signIn).getByRole("button", { name: "Continue" }));
  expect(named("finishSignIn")).toEqual([
    ["ai-profiles/subscriptions:finishSignIn", { id: waiting.id, pasted }],
  ]);

  // Connected: the plan, the email and the models found.
  const connected = await screen.findByRole("dialog", { name: "Connected" });
  for (const text of ["ChatGPT Business", "you@acme.test", "2 models found", "GPT-5 Codex"])
    expect(within(connected).getByText(text)).toBeTruthy();
  expect(markIn(connected)).toBe("M2 2h20v20H2z");
});

test("a ChatGPT card sits beside a Claude one, shows its workspace, and signs in again through OpenAI", async () => {
  const user = userEvent.setup({ document });
  listed = {
    subscriptions: [
      claude,
      { ...business, status: "signed-out", reason: "ChatGPT would not renew the login. Sign in again." },
    ],
    signIns: [],
  };
  answers["ai-profiles/subscriptions:startSignIn"] = {
    ...waiting,
    repair: business.id,
  } as unknown as JsonValue;
  mount();
  const chatgpt = await screen.findByRole("article", { name: "ChatGPT Business" });
  const max = screen.getByRole("article", { name: "Claude Max, Personal" });
  expect(markIn(chatgpt)).toBe("M2 2h20v20H2z");
  expect(markIn(max)).toBe("M1 1h22v22H1z");
  for (const text of ["you@acme.test", "Acme", "Signed out", "2 models · not used yet"])
    expect(within(chatgpt).getByText(text)).toBeTruthy();

  await user.click(within(chatgpt).getByRole("button", { name: "Sign in" }));
  expect(named("startSignIn")).toEqual([
    [
      "ai-profiles/subscriptions:startSignIn",
      { company: "openai", method: "subscription", repair: business.id },
    ],
  ]);
  await screen.findByRole("dialog", { name: "Sign in to ChatGPT" });

  // The repaired login comes back: the card says OK again, still beside the Claude one.
  update({ subscriptions: [claude, business], signIns: [] });
  // (A changed subscription is a new card, so it is looked up again.)
  await waitFor(() =>
    expect(within(screen.getByRole("article", { name: "ChatGPT Business" })).getByText("OK")).toBeTruthy(),
  );
  expect(screen.getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual([
    "Claude Max, Personal",
    "ChatGPT Business",
  ]);
});

test("a plan the company did not name is left out of the title, never shown as Free", async () => {
  listed = { subscriptions: [{ ...business, plan: "", label: "Work" }], signIns: [] };
  mount();
  const card = await screen.findByRole("article", { name: "ChatGPT, Work" });
  // The line under the email names the workspace alone.
  expect(within(card).getByText("Acme")).toBeTruthy();
  expect(within(card).queryByText(/free/i)).toBeNull();
});

test("each company's return address is written once; its port and path come from it", () => {
  expect([returnPort("anthropic"), returnPath("anthropic")]).toEqual([54545, "/callback"]);
  expect([returnPort("openai"), returnPath("openai")]).toEqual([1455, "/auth/callback"]);
});

test("the line under the email is the workspace or organisation alone, and nothing for a personal account", async () => {
  // The owner's personal ChatGPT Pro showed "pro" there: the plan, already in the title, repeated.
  const personal = (company: "anthropic" | "openai", id: string, plan: string): Subscription => ({
    ...business,
    id: `agent-proxy/subscriptions:${id}`,
    company,
    plan,
    label: id,
    accounts: [{ id: `agent-proxy/accounts:${id}`, email: `${id}@example.test`, status: "ok" }],
  });
  const inWorkspace = (subscription: Subscription, organization: string): Subscription => ({
    ...subscription,
    accounts: [{ ...subscription.accounts[0]!, organization }],
  });
  listed = {
    subscriptions: [
      personal("openai", "gpt-home", "Pro"),
      inWorkspace(personal("openai", "gpt-work", "Business"), "Acme"),
      personal("anthropic", "claude-home", "Max"),
      inWorkspace(personal("anthropic", "claude-work", "Team"), "Acme Inc"),
    ],
    signIns: [],
  };
  mount();
  const lineOf = async (name: string, email: string) => {
    const card = await screen.findByRole("article", { name });
    // The element after the email: the workspace line, or the status when there is none.
    return within(card).getByText(email).nextElementSibling?.textContent ?? "";
  };
  expect(await lineOf("ChatGPT Pro, gpt-home", "gpt-home@example.test")).toBe("");
  expect(await lineOf("ChatGPT Business, gpt-work", "gpt-work@example.test")).toBe("Acme");
  expect(await lineOf("Claude Max, claude-home", "claude-home@example.test")).toBe("");
  expect(await lineOf("Claude Team, claude-work", "claude-work@example.test")).toBe("Acme Inc");
  for (const card of screen.getAllByRole("article"))
    expect(card.textContent).not.toMatch(/\b(pro|business|max|team)\b/);
});
