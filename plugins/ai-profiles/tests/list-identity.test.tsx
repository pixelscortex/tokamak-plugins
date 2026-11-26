import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { render } from "@solidjs/web";
import { afterEach, expect, test } from "vitest";
import { TokamakClient, type ClientTransport, type JsonValue } from "@tokamak/sdk";
import { RegionOutlet, RegionProvider } from "@tokamak/sdk/client";
import { ClientContext } from "@tokamak/sdk/solid";
import type { Subscription } from "../src/client/lib/api";
import { openSubscription } from "../src/client/lib/manage";
import { Profiles } from "../src/client/pages/profiles";

// Every answer of a live query brings fresh objects for the same records. The
// lists of records are keyed by id, so an answer that changes nothing keeps
// every row the same element: nothing rebuilt, no hover, focus or open menu
// lost. Unkeyed, each answer rebuilt every card, account and model chip
// (Solid's dev warning UNSTABLE_LIST_IDENTITY).

const models = [
  { id: "m1", name: "Claude One" },
  { id: "m2", name: "Claude Two" },
  { id: "m3", name: "Claude Three" },
];
const card = (id: string, label: string): Subscription => ({
  id: `agent-proxy/subscriptions:${id}`,
  company: "anthropic",
  method: "subscription",
  label,
  plan: "Team",
  enabled: true,
  status: "ok",
  accounts: [
    { id: `agent-proxy/accounts:${id}1`, email: `${id}1@example.test`, status: "ok" },
    { id: `agent-proxy/accounts:${id}2`, email: `${id}2@example.test`, status: "ok" },
  ],
  models,
  createdAt: 1,
});
const subscriptions = [card("a", "One"), card("b", "Two"), card("c", "Three")];
const profiles = ["P1", "P2", "P3"].map((code, i) => ({
  id: `ai-profiles/profiles:${code}`,
  name: `Profile ${code}`,
  code,
  subscriptions: subscriptions.map((item) => item.id),
  createdAt: i,
}));

/** The same elements, by identity: `toEqual` would compare DOM nodes by `isEqualNode`. */
const same = (now: readonly Element[], before: readonly Element[]) =>
  now.length === before.length && now.every((element, i) => element === before[i]);

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  openSubscription.set(undefined);
  document.body.replaceChildren();
});

/** The page; `again` makes every live query answer again with the same records. */
function mount() {
  const senders: (() => void)[] = [];
  const value = (name: string): JsonValue => {
    if (name.endsWith("profiles:list")) return profiles as unknown as JsonValue;
    if (name.endsWith("manage:usedBy"))
      return profiles.map(({ id, code, name }) => ({ id, code, name, threads: 0 })) as unknown as JsonValue;
    return { subscriptions, signIns: [] } as unknown as JsonValue;
  };
  const transport: ClientTransport = {
    query: async () => null,
    mutation: async () => null,
    action: async () => null,
    subscribe(name, _args, onEvent) {
      const send = () => onEvent({ value: structuredClone(value(name)) });
      senders.push(send);
      queueMicrotask(send);
      return () => {};
    },
  };
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(
    () => (
      <ClientContext value={new TokamakClient(transport)}>
        <RegionProvider>
          <header aria-label="Page header">
            <RegionOutlet name="header" />
          </header>
          <Profiles />
        </RegionProvider>
      </ClientContext>
    ),
    root,
  );
  unmount = () => {
    dispose();
    root.remove();
  };
  return async () => {
    for (const send of senders) send();
    await new Promise((done) => setTimeout(done, 20));
  };
}

test("the same records answered again keep the cards, their account lines and the profile menu", async () => {
  const again = mount();
  const user = userEvent.setup({ document });
  const cards = await screen.findAllByRole("article", { name: /^Claude Team, / });
  const emails = screen.getAllByText(/@example\.test$/);
  expect(cards).toHaveLength(3);
  await again();
  await again();
  expect(same(screen.getAllByRole("article", { name: /^Claude Team, / }), cards)).toBe(true);
  expect(same(screen.getAllByText(/@example\.test$/), emails)).toBe(true);
  // The card held earlier is still the one on the page: its menu opens.
  await user.click(within(cards[0]!).getByRole("button", { name: /to a profile$/ }));
  const menu = await screen.findByRole("menu");
  const items = within(menu).getAllByText(/^Profile P\d$/);
  expect(items).toHaveLength(3);
  await again();
  expect(same(within(menu).getAllByText(/^Profile P\d$/), items)).toBe(true);
});

test("the same records answered again keep the details' accounts, models and Used by rows", async () => {
  const again = mount();
  await screen.findAllByRole("article");
  openSubscription.set(subscriptions[0]!.id);
  const details = await screen.findByRole("region", { name: "Claude Team details" });
  const rows = () => [
    ...within(details).getAllByText(/^a\d@example\.test$/),
    ...within(within(details).getByRole("region", { name: "Models" })).getAllByRole("listitem"),
    ...within(within(details).getByRole("region", { name: "Used by" })).getAllByRole("listitem"),
  ];
  await within(details).findAllByText(/^Profile P\d$/);
  const before = rows();
  expect(before).toHaveLength(2 + 3 + 3);
  await again();
  await again();
  expect(same(rows(), before)).toBe(true);
});
