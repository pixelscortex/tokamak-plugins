import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { render } from "@solidjs/web";
import { afterEach, expect, test } from "vitest";
import { TokamakClient, type ClientTransport, type JsonValue } from "@tokamak/sdk";
import { RegionOutlet, RegionProvider } from "@tokamak/sdk/client";
import { ClientContext } from "@tokamak/sdk/solid";
import type { SignIn, Subscription } from "../src/client/lib/api";
import { openSubscription, removing } from "../src/client/lib/manage";
import { Profiles } from "../src/client/pages/profiles";

// Managing a subscription in the window (TKM-265): the card's icon buttons,
// the details screen, "Add account", "Sign out" and the remove confirmation.
// A stand-in server answers `list` and `usedBy` from what the test holds and
// records every call; agent-proxy's manage tests run the same calls for real.

const team: Subscription = {
  id: "agent-proxy/subscriptions:team",
  company: "anthropic",
  method: "subscription",
  label: "Acme",
  plan: "Team",
  enabled: true,
  status: "ok",
  accounts: [
    { id: "agent-proxy/accounts:a", email: "you@acme.test", organization: "Acme Inc", status: "ok" },
    {
      id: "agent-proxy/accounts:b",
      email: "you2@acme.test",
      status: "signed-out",
      reason: "You signed this account out. Sign in again to use it.",
    },
  ],
  models: [
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  ],
  createdAt: 1,
};
/** What TKM-264's profiles will answer through the `usedBy` seam. */
const acme = [{ id: "profile-1", code: "ACME", name: "Acme", threads: 3 }];
const waiting: SignIn = {
  id: "agent-proxy/signIns:add",
  company: "anthropic",
  method: "subscription",
  link: "https://claude.example/oauth/authorize?state=abc",
  addTo: team.id,
  startedAt: 2,
  expired: false,
};

let listed: { subscriptions: Subscription[]; signIns: SignIn[] } = { subscriptions: [team], signIns: [] };
let uses: JsonValue = acme;
/** Each call's answer: a value, or a function that may throw (a call that fails on the way). */
const answers: Record<string, JsonValue | (() => JsonValue)> = {};
const listeners = new Set<() => void>();
/** What another window did: the list changes and every open subscription hears it. */
function update(next: typeof listed) {
  listed = next;
  for (const send of listeners) send();
}
const calls: [string, JsonValue][] = [];
const named = (name: string) => calls.filter(([called]) => called === `ai-profiles/${name}`);

function client(): TokamakClient {
  const call = async (name: string, args: JsonValue) => {
    calls.push([name, args]);
    const answer = answers[name];
    return typeof answer === "function" ? answer() : (answer ?? null);
  };
  const transport: ClientTransport = {
    query: call,
    mutation: call,
    action: call,
    subscribe(name, args, onEvent) {
      calls.push([name, args]);
      // The Profiles section's own list (TKM-264): none here.
      if (name === "ai-profiles/profiles:list") {
        queueMicrotask(() => onEvent({ value: [] }));
        return () => {};
      }
      const send = () =>
        onEvent({
          value: structuredClone(
            name === "ai-profiles/manage:usedBy" ? uses : (listed as unknown as JsonValue),
          ),
        });
      listeners.add(send);
      queueMicrotask(send);
      return () => listeners.delete(send);
    },
  };
  return new TokamakClient(transport);
}

const cleanups: (() => void)[] = [];
/** The Profiles page with the shell's header region, where the details put their breadcrumb. */
function mount() {
  const root = document.createElement("div");
  document.body.append(root);
  cleanups.push(
    render(
      () => (
        <ClientContext value={client()}>
          <RegionProvider>
            <header aria-label="Page header">
              <RegionOutlet name="header" />
            </header>
            <Profiles />
          </RegionProvider>
        </ClientContext>
      ),
      root,
    ),
  );
}
afterEach(async () => {
  for (const close of document.querySelectorAll<HTMLElement>('[role="dialog"] [aria-label="Close"]'))
    close.click();
  removing.set(undefined);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  openSubscription.set(undefined);
  listed = { subscriptions: [team], signIns: [] };
  uses = acme;
  for (const key of Object.keys(answers)) delete answers[key];
  calls.length = 0;
  listeners.clear();
});

test("a card's actions are sm icon buttons with names and tooltips; Check again says why it failed", async () => {
  const user = userEvent.setup({ document });
  answers["ai-profiles/manage:checkAgain"] = {
    failed: true,
    kind: "Unreachable",
    data: { message: "Claude did not answer. Nothing changed; try again." },
  };
  mount();
  const card = await screen.findByRole("article", { name: "Claude Team, Acme" });
  const names = [
    "Claude Team, Acme models",
    "Check Claude Team, Acme again",
    "Claude Team, Acme details",
    "Remove Claude Team, Acme",
  ];
  for (const name of names) {
    const button = within(card).getByRole("button", { name });
    // Button `sm`, icon only: 24 × 24.
    expect(button.className).toMatch(/\bh-6\b/);
    expect(button.className).toMatch(/\bw-6\b/);
  }
  // The models button's tooltip lists the models by the names people know.
  await user.hover(within(card).getByRole("button", { name: "Claude Team, Acme models" }));
  expect(await screen.findByText("Opus 4.6 · Sonnet 4.6")).toBeTruthy();

  await user.click(within(card).getByRole("button", { name: "Check Claude Team, Acme again" }));
  expect(named("manage:checkAgain")).toEqual([["ai-profiles/manage:checkAgain", { id: team.id }]]);
  expect((await within(card).findByRole("alert")).textContent).toMatch(/did not answer/);
});

test("the details show each account with its status, the models and the profiles that use it; Sign out, Add account and back", async () => {
  const user = userEvent.setup({ document });
  answers["ai-profiles/manage:addAccount"] = waiting as unknown as JsonValue;
  answers["ai-profiles/subscriptions:finishSignIn"] = team as unknown as JsonValue;
  mount();
  const card = await screen.findByRole("article", { name: "Claude Team, Acme" });
  await user.click(within(card).getByRole("button", { name: "Claude Team, Acme details" }));

  const details = await screen.findByRole("region", { name: "Claude Team details" });
  const cards = document.querySelector<HTMLElement>('section[aria-label="Subscriptions"]')!;
  expect(cards.hidden).toBe(true);
  const accounts = within(details).getByRole("region", { name: "Accounts" });
  const [first, second] = within(accounts).getAllByRole("listitem");
  expect(first!.textContent).toMatch(/you@acme\.test.*OK/);
  expect(second!.textContent).toMatch(/you2@acme\.test.*Signed out/);
  expect(
    within(within(details).getByRole("region", { name: "Models" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Opus 4.6", "Sonnet 4.6"]);
  // "Used by" comes from ai-profiles' own seam, for TKM-264's profiles.
  const usedBy = within(details).getByRole("region", { name: "Used by" });
  expect((await within(usedBy).findByRole("listitem")).textContent).toMatch(/ACME.*Acme.*3 threads/);

  // Each account's buttons are named with it; the signed-out one signs that one account in.
  await user.click(within(first!).getByRole("button", { name: "Sign out you@acme.test" }));
  expect(named("manage:signOut")).toEqual([["ai-profiles/manage:signOut", { id: "agent-proxy/accounts:a" }]]);
  const { addTo: _addTo, ...oneAccount } = waiting;
  answers["ai-profiles/manage:signInAccount"] = {
    ...oneAccount,
    repair: team.id,
    repairAccount: "agent-proxy/accounts:b",
  } as unknown as JsonValue;
  await user.click(within(second!).getByRole("button", { name: "Sign in you2@acme.test" }));
  expect(named("manage:signInAccount")).toEqual([
    ["ai-profiles/manage:signInAccount", { id: "agent-proxy/accounts:b" }],
  ]);
  await user.click(
    within(await screen.findByRole("dialog", { name: "Sign in to Claude" })).getByRole("button", {
      name: "Close",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // Add account: the same sign-in step, for this subscription; it closes when the account is in.
  await user.click(within(accounts).getByRole("button", { name: "Add account" }));
  expect(named("manage:addAccount")).toEqual([["ai-profiles/manage:addAccount", { id: team.id }]]);
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude" });
  await user.type(
    within(dialog).getByRole("textbox", { name: /Address the sign-in/ }),
    "http://localhost:54545/callback?code=c&state=abc",
  );
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(named("subscriptions:finishSignIn")[0]![1]).toMatchObject({ id: waiting.id });

  // "Profiles" in the page header goes back to the cards.
  const header = screen.getByRole("banner", { name: "Page header" });
  await user.click(within(header).getByRole("button", { name: "Profiles" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Claude Team details" })).toBeNull());
  expect(cards.hidden).toBe(false);
});

test("Remove asks once, names the profiles that lose it, and removes it on the second press", async () => {
  const user = userEvent.setup({ document });
  mount();
  const card = await screen.findByRole("article", { name: "Claude Team, Acme" });
  await user.click(within(card).getByRole("button", { name: "Remove Claude Team, Acme" }));

  const dialog = await screen.findByRole("dialog", { name: "Remove Claude Team, Acme?" });
  expect(named("manage:remove")).toEqual([]);
  const lose = within(dialog).getByRole("list", { name: "Profiles that lose it" });
  expect(within(lose).getByRole("listitem").textContent).toMatch(/ACME.*Acme/);
  expect(within(dialog).getByText(/logins are deleted/)).toBeTruthy();

  await user.click(within(dialog).getByRole("button", { name: "Remove" }));
  expect(named("manage:remove")).toEqual([["ai-profiles/manage:remove", { id: team.id }]]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("with no profile using it, the confirmation says so", async () => {
  const user = userEvent.setup({ document });
  uses = [];
  mount();
  const card = await screen.findByRole("article", { name: "Claude Team, Acme" });
  await user.click(within(card).getByRole("button", { name: "Remove Claude Team, Acme" }));
  const dialog = await screen.findByRole("dialog", { name: "Remove Claude Team, Acme?" });
  expect(await within(dialog).findByText("No profile uses it.")).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(named("manage:remove")).toEqual([]);
});

test("an add-account sign-in cancelled in another window is said so, not shown as connected", async () => {
  const user = userEvent.setup({ document });
  answers["ai-profiles/manage:addAccount"] = waiting as unknown as JsonValue;
  mount();
  const card = await screen.findByRole("article", { name: "Claude Team, Acme" });
  await user.click(within(card).getByRole("button", { name: "Claude Team, Acme details" }));
  const details = await screen.findByRole("region", { name: "Claude Team details" });
  await user.click(within(details).getByRole("button", { name: "Add account" }));
  await screen.findByRole("dialog", { name: "Sign in to Claude" });
  // The cards say what is waiting: another account, not a new subscription.
  update({ subscriptions: [team], signIns: [waiting] });
  await waitFor(() =>
    expect(document.querySelector('section[aria-label="Subscriptions"]')!.textContent).toMatch(
      /Awaiting another account/,
    ),
  );
  // Cancelled elsewhere: the subscription is still "OK", which says nothing about this sign-in.
  update({ subscriptions: [team], signIns: [] });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect((await within(details).findByRole("alert")).textContent).toMatch(/cancelled in another window/);
});

test("an add-account sign-in finished in another window closes the dialog quietly", async () => {
  const user = userEvent.setup({ document });
  answers["ai-profiles/manage:addAccount"] = waiting as unknown as JsonValue;
  mount();
  await user.click(
    within(await screen.findByRole("article", { name: "Claude Team, Acme" })).getByRole("button", {
      name: "Claude Team, Acme details",
    }),
  );
  const details = await screen.findByRole("region", { name: "Claude Team details" });
  await user.click(within(details).getByRole("button", { name: "Add account" }));
  await screen.findByRole("dialog", { name: "Sign in to Claude" });
  update({ subscriptions: [team], signIns: [waiting] });
  await waitFor(() => expect(listeners.size).toBeGreaterThan(0));
  const third = { id: "agent-proxy/accounts:c", email: "you3@acme.test", status: "ok" as const };
  update({ subscriptions: [{ ...team, accounts: [...team.accounts, third] }], signIns: [] });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(within(details).queryByRole("alert")).toBeNull();
  expect(within(details).getByText("you3@acme.test")).toBeTruthy();
});

test("a sign out that fails on the way says so", async () => {
  const user = userEvent.setup({ document });
  answers["ai-profiles/manage:signOut"] = () => {
    throw new Error("connection lost");
  };
  mount();
  await user.click(
    within(await screen.findByRole("article", { name: "Claude Team, Acme" })).getByRole("button", {
      name: "Claude Team, Acme details",
    }),
  );
  const details = await screen.findByRole("region", { name: "Claude Team details" });
  await user.click(within(details).getByRole("button", { name: "Sign out you@acme.test" }));
  expect((await within(details).findByRole("alert")).textContent).toMatch(/could not be signed out/);
});

test("a subscription whose plan is unknown is titled by its product and says so beside Check again", async () => {
  listed = { subscriptions: [{ ...team, plan: "", label: "" }], signIns: [] };
  mount();
  const card = await screen.findByRole("article", { name: "Claude" });
  // The line under the emails names the organisation alone; the hint sits by the action that reads the plan.
  expect(within(card).getByText("Acme Inc")).toBeTruthy();
  // The hint sits in the action row, beside the Check again that reads the plan.
  const actions = within(card).getByRole("toolbar", { name: "Claude actions" });
  expect(within(actions).getByRole("button", { name: "Check Claude again" })).toBeTruthy();
  expect(within(actions).getByText("plan unknown")).toBeTruthy();
});

test("the Profiles section goes with the cards while a subscription's details are open", async () => {
  const user = userEvent.setup({ document });
  mount();
  const card = await screen.findByRole("article", { name: "Claude Team, Acme" });
  expect(await screen.findByRole("region", { name: "Profiles" })).toBeTruthy();
  await user.click(within(card).getByRole("button", { name: "Claude Team, Acme details" }));
  await screen.findByRole("region", { name: "Claude Team details" });
  expect(screen.queryByRole("region", { name: "Profiles" })).toBeNull();
  const header = screen.getByRole("banner", { name: "Page header" });
  await user.click(within(header).getByRole("button", { name: "Profiles" }));
  expect(await screen.findByRole("region", { name: "Profiles" })).toBeTruthy();
});
