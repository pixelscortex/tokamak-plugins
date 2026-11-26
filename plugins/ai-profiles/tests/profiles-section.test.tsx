import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { render } from "@solidjs/web";
import { afterEach, expect, test } from "vitest";
import { TokamakClient, type ClientTransport, type JsonValue } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import type { SignIn, Subscription } from "../src/client/lib/api";
import { UNSAVED, type Profile } from "../src/client/lib/builder";
import { Profiles } from "../src/client/pages/profiles";

// The Profiles section on the Profiles screen, with a stand-in server that
// keeps profiles in memory and answers as the real one does (its own tests,
// on a real server, are in profiles-server.test.ts). Dragging is driven with
// pointer events; jsdom lays nothing out, so each test says which element is
// under the pointer and where a row sits.

const card = (id: string, plan: string, label: string): Subscription => ({
  id: `agent-proxy/subscriptions:${id}`,
  company: "anthropic",
  method: "subscription",
  label,
  plan,
  enabled: true,
  status: "ok",
  accounts: [{ id: `agent-proxy/accounts:${id}`, email: `${id}@example.test`, status: "ok" }],
  models: [],
  createdAt: 1,
});
const personal = card("a", "Pro", "Personal");
const work = card("b", "Max", "Work");
const waiting: SignIn = {
  id: "agent-proxy/signIns:s1",
  company: "anthropic",
  method: "subscription",
  link: "https://claude.example/oauth",
  startedAt: 1,
  expired: false,
};

let profiles: Profile[] = [];
const calls: [string, Record<string, unknown>][] = [];
/** A failure to answer the next `create` with, as the server would. */
let refuseCreate: JsonValue | undefined;
/** Calls that throw instead of answering, as when the connection drops; and one to hold open. */
const broken = new Set<string>();
let hold: Promise<void> | undefined;
const listeners = new Map<string, Set<() => void>>();
const push = () => {
  for (const send of listeners.get("ai-profiles/profiles:list") ?? []) send();
};

/** The real server's rules, in memory: insert at, move to, take out, and a new profile. */
function serve(name: string, args: Record<string, unknown>): JsonValue {
  calls.push([name, args]);
  const profile = profiles.find((item) => item.id === args.profile);
  const ids = profile ? [...profile.subscriptions] : [];
  const subscription = args.subscription as string;
  switch (name) {
    case "ai-profiles/profiles:create": {
      if (refuseCreate) return refuseCreate;
      const made = {
        id: `ai-profiles/profiles:p${profiles.length + 1}`,
        name: args.name as string,
        code: (args.code as string).toUpperCase(),
        subscriptions: [],
        createdAt: profiles.length + 1,
      };
      profiles = [...profiles, made];
      push();
      return made as unknown as JsonValue;
    }
    case "ai-profiles/profiles:add":
      ids.splice((args.at as number | undefined) ?? ids.length, 0, subscription);
      break;
    case "ai-profiles/profiles:move":
      ids.splice(ids.indexOf(subscription), 1);
      ids.splice(args.to as number, 0, subscription);
      break;
    case "ai-profiles/profiles:remove":
      ids.splice(ids.indexOf(subscription), 1);
      break;
    default:
      return null;
  }
  profiles = profiles.map((item) => (item === profile ? { ...item, subscriptions: ids } : item));
  push();
  return profiles.find((item) => item.id === args.profile) as unknown as JsonValue;
}

function client(): TokamakClient {
  const call = async (name: string, args: JsonValue) => {
    if (hold && name.endsWith(":create")) await hold;
    if (broken.has(name)) {
      calls.push([name, args as Record<string, unknown>]);
      throw new Error("connection lost");
    }
    return serve(name, args as Record<string, unknown>);
  };
  const transport: ClientTransport = {
    query: call,
    mutation: call,
    action: call,
    subscribe(name, _args, onEvent) {
      const value = () =>
        (name === "ai-profiles/profiles:list"
          ? structuredClone(profiles)
          : { subscriptions: [personal, work], signIns: [waiting] }) as unknown as JsonValue;
      const send = () => onEvent({ value: value() });
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set.add(send));
      queueMicrotask(send);
      return () => set.delete(send);
    },
  };
  return new TokamakClient(transport);
}

let dispose: (() => void) | undefined;
async function mount(start: Profile[] = []) {
  profiles = start;
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <ClientContext value={client()}>
        <Profiles />
      </ClientContext>
    ),
    root,
  );
  await screen.findByRole("article", { name: "Claude Pro, Personal" });
  return screen.getByRole("region", { name: "Profiles" });
}
afterEach(async () => {
  for (const close of document.querySelectorAll<HTMLElement>('[role="dialog"] [aria-label="Close"]'))
    close.click();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  dispose?.();
  document.body.replaceChildren();
  listeners.clear();
  calls.length = 0;
  refuseCreate = undefined;
  broken.clear();
  hold = undefined;
});

const profile = (id: string, code: string, name: string, subscriptions: string[] = []): Profile => ({
  id: `ai-profiles/profiles:${id}`,
  code,
  name,
  subscriptions,
  createdAt: 1,
});
const box = (code: string) => document.querySelector<HTMLElement>(`[data-profile][aria-label^="${code},"]`)!;
const article = (name: string) => screen.getByRole("article", { name });
const changes = () => calls.filter(([name]) => !name.endsWith(":list") && !name.endsWith(":renew"));

/** A pointer event as a mouse sends it; jsdom has no PointerEvent, so a MouseEvent carries the fields. */
function pointer(type: string, target: EventTarget, y = 0, buttons = type === "pointerup" ? 0 : 1) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons,
    clientX: 10,
    clientY: y,
  });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}
/** Lays a row out at `top`, 40 tall, as the browser would. */
function place(row: Element, top: number) {
  (row as HTMLElement).getBoundingClientRect = () => ({ top, height: 40, bottom: top + 40 }) as DOMRect;
}
/** Drags `source` to `y` over `under`, then lets go there. */
function drag(source: Element, under: Element, y: number) {
  document.elementFromPoint = () => under;
  pointer("pointerdown", source, 0);
  pointer("pointermove", window, y);
  return { drop: () => pointer("pointerup", window, y) };
}

test("New profile asks for a name and a code, shows the code in upper case, and says why one is refused", async () => {
  const user = userEvent.setup({ document });
  const section = await mount();
  expect(
    within(section).getByText("No profiles yet. Make one, then drag subscriptions into it."),
  ).toBeTruthy();
  await user.click(within(section).getByRole("button", { name: "New profile" }));
  const dialog = await screen.findByRole("dialog", { name: "New profile" });
  await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Personal");
  const code = within(dialog).getByRole("textbox", { name: "Code" }) as HTMLInputElement;
  await user.type(code, "pers");
  expect(code.value).toBe("PERS");

  // The server's answer is shown in the dialog, which stays open.
  refuseCreate = {
    failed: true,
    kind: "Taken",
    data: { field: "code", message: "You already have a profile PERS." },
  };
  await user.click(within(dialog).getByRole("button", { name: "Create" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe("You already have a profile PERS.");
  expect(code.getAttribute("aria-invalid")).toBe("true");

  refuseCreate = undefined;
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(changes().at(-1)).toEqual(["ai-profiles/profiles:create", { name: "Personal", code: "PERS" }]);
  // The new box: its code, its name and "Fill first", empty and waiting for a card.
  const made = await waitFor(() => box("PERS"));
  expect(within(made).getByText("Personal")).toBeTruthy();
  expect(within(made).getByText("Fill first")).toBeTruthy();
  expect(within(made).getByText("Drag a subscription here")).toBeTruthy();
});

test("a card dropped on a profile goes in at the drop position, numbered, and the card lists the code", async () => {
  await mount([profile("p1", "PERS", "Personal", [work.id])]);
  const pers = box("PERS");
  const row = pers.querySelector(`[data-entry="${work.id}"]`)!;
  place(row, 100);
  // Above the middle of the first row: it goes in first.
  const move = drag(article("Claude Pro, Personal"), row, 110);
  await waitFor(() => expect(pers.hasAttribute("data-target")).toBe(true));
  // The carried card waits faded; the slot shows the number it would get.
  expect(article("Claude Pro, Personal").hasAttribute("data-dimmed")).toBe(true);
  expect(pers.querySelector("li[aria-hidden]")?.textContent).toBe("1");
  move.drop();
  await waitFor(() =>
    expect(changes()).toEqual([
      ["ai-profiles/profiles:add", { profile: "ai-profiles/profiles:p1", subscription: personal.id, at: 0 }],
    ]),
  );
  // Rows are numbered in use order, and both cards now show the code.
  await waitFor(() =>
    expect(
      within(pers)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["1. Claude Pro, Personal", "2. Claude Max, Work"]),
  );
  expect(within(article("Claude Pro, Personal")).getByText("PERS")).toBeTruthy();
  expect(within(article("Claude Max, Work")).getByText("PERS")).toBeTruthy();
  expect(await screen.findByText("Claude Pro, Personal added to PERS as number 1.")).toBeTruthy();
});

test("while a card is dragged, a profile that holds it fades and says added, and a drop there does nothing", async () => {
  await mount([profile("p1", "PERS", "Personal", [personal.id]), profile("p2", "SBOX", "Sandbox", [])]);
  const pers = box("PERS");
  const move = drag(article("Claude Pro, Personal"), pers, 50);
  await waitFor(() => expect(pers.hasAttribute("data-added")).toBe(true));
  expect(within(pers).getByText("added")).toBeTruthy();
  expect(within(pers).queryByText("Fill first")).toBeNull();
  // It is no drop target, and the other profile does not fade.
  expect(pers.hasAttribute("data-target")).toBe(false);
  expect(box("SBOX").hasAttribute("data-added")).toBe(false);
  move.drop();
  await new Promise((done) => setTimeout(done, 20));
  expect(changes()).toEqual([]);
  expect(pers.hasAttribute("data-added")).toBe(false);
});

test("a drag that is cancelled, interrupted, or dropped outside every profile adds nothing", async () => {
  await mount([profile("p1", "PERS", "Personal")]);
  const pers = box("PERS");
  const card = article("Claude Pro, Personal");
  const carried = () => card.hasAttribute("data-dimmed");
  const endings: [string, () => void][] = [
    ["Escape", () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
    ["pointercancel", () => pointer("pointercancel", window, 50)],
    ["the window losing focus", () => window.dispatchEvent(new Event("blur"))],
    // A release outside the window: the next move arrives with no button down.
    ["a move with no button", () => pointer("pointermove", window, 50, 0)],
  ];
  for (const [how, ending] of endings) {
    drag(card, pers, 50);
    await waitFor(() => expect(carried(), how).toBe(true));
    ending();
    await waitFor(() => expect(carried(), how).toBe(false));
    // Letting go afterwards over the profile still adds nothing.
    pointer("pointerup", window, 50);
  }
  // Dropped where no profile is.
  drag(card, document.body, 50).drop();
  await new Promise((done) => setTimeout(done, 20));
  expect(changes()).toEqual([]);
  expect(pers.hasAttribute("data-target")).toBe(false);
});

test("a row dragged inside its profile is reordered; its menu moves and removes it from the keyboard", async () => {
  const user = userEvent.setup({ document });
  await mount([profile("p1", "PERS", "Personal", [personal.id, work.id])]);
  const pers = box("PERS");
  const [first, second] = pers.querySelectorAll("[data-entry]");
  place(first!, 100);
  place(second!, 144);
  // The second row, carried above the middle of the first, becomes first.
  drag(second!, first!, 105).drop();
  await waitFor(() =>
    expect(changes()).toEqual([
      ["ai-profiles/profiles:move", { profile: "ai-profiles/profiles:p1", subscription: work.id, to: 0 }],
    ]),
  );

  // From the keyboard: the row's menu moves it back down, then takes it out.
  const menuOf = (name: string) => within(pers).getByRole("button", { name: `${name} in PERS` });
  await waitFor(() =>
    expect(within(pers).getAllByRole("listitem")[0]!.getAttribute("aria-label")).toBe("1. Claude Max, Work"),
  );
  menuOf("Claude Max, Work").focus();
  await user.keyboard("{Enter}");
  expect((await screen.findByRole("menuitem", { name: "Move up" })).getAttribute("aria-disabled")).toBe(
    "true",
  );
  await user.click(screen.getByRole("menuitem", { name: "Move down" }));
  await waitFor(() => expect(changes().at(-1)?.[1]).toMatchObject({ subscription: work.id, to: 1 }));
  expect(await screen.findByText("Claude Max, Work is now number 2 in PERS.")).toBeTruthy();
  // Focus comes back to the moved row's menu button.
  await waitFor(() => expect(document.activeElement).toBe(menuOf("Claude Max, Work")));

  await user.keyboard("{Enter}");
  await user.click(await screen.findByRole("menuitem", { name: "Remove from PERS" }));
  await waitFor(() =>
    expect(changes().at(-1)).toEqual([
      "ai-profiles/profiles:remove",
      { profile: "ai-profiles/profiles:p1", subscription: work.id },
    ]),
  );
  await waitFor(() => expect(within(pers).getAllByRole("listitem")).toHaveLength(1));
  expect(within(article("Claude Max, Work")).queryByText("PERS")).toBeNull();

  // The removed row took its menu with it; another menu still opens afterwards.
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  within(article("Claude Max, Work"))
    .getByRole("button", { name: "Add Claude Max, Work to a profile" })
    .focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("menuitem", { name: /PERS/ })).toBeTruthy();
  await user.keyboard("{Escape}");
});

test("pointing at a profile, or focusing in it, dims the cards it does not hold", async () => {
  await mount([profile("p1", "PERS", "Personal", [personal.id])]);
  const pers = box("PERS");
  const dimmed = () =>
    screen
      .getAllByRole("article")
      .filter((item) => item.hasAttribute("data-dimmed"))
      .map((item) => item.getAttribute("aria-label"));
  pers.dispatchEvent(new MouseEvent("pointerenter"));
  await waitFor(() => expect(dimmed()).toEqual(["Claude Max, Work", "Claude, awaiting sign-in"]));
  pers.dispatchEvent(new MouseEvent("pointerleave"));
  await waitFor(() => expect(dimmed()).toEqual([]));

  within(pers).getByRole("button", { name: "Claude Pro, Personal in PERS" }).focus();
  await waitFor(() => expect(dimmed()).toEqual(["Claude Max, Work", "Claude, awaiting sign-in"]));
});

test("a card's menu adds it to a profile from the keyboard; one that holds it says added", async () => {
  const user = userEvent.setup({ document });
  await mount([profile("p1", "PERS", "Personal", [personal.id]), profile("p2", "SBOX", "Sandbox")]);
  within(article("Claude Pro, Personal"))
    .getByRole("button", { name: "Add Claude Pro, Personal to a profile" })
    .focus();
  await user.keyboard("{Enter}");
  const held = await screen.findByRole("menuitem", { name: /PERS/ });
  expect(held.getAttribute("aria-disabled")).toBe("true");
  expect(within(held).getByText("added")).toBeTruthy();
  // The open menu is the keyboard's drag: the profile that holds it fades too.
  expect(box("PERS").hasAttribute("data-added")).toBe(true);
  await user.click(screen.getByRole("menuitem", { name: /SBOX/ }));
  await waitFor(() =>
    expect(changes()).toEqual([
      ["ai-profiles/profiles:add", { profile: "ai-profiles/profiles:p2", subscription: personal.id, at: 0 }],
    ]),
  );
  await waitFor(() => expect(within(article("Claude Pro, Personal")).getByText("SBOX")).toBeTruthy());
  expect(box("PERS").hasAttribute("data-added")).toBe(false);
});

test("a create that cannot reach the server keeps the dialog, its fields and Create, which is off while it runs", async () => {
  const user = userEvent.setup({ document });
  const section = await mount();
  await user.click(within(section).getByRole("button", { name: "New profile" }));
  const dialog = await screen.findByRole("dialog", { name: "New profile" });
  await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Personal");
  await user.type(within(dialog).getByRole("textbox", { name: "Code" }), "pers");
  const create = within(dialog).getByRole("button", { name: "Create" });

  let release = () => {};
  hold = new Promise((done) => (release = done));
  broken.add("ai-profiles/profiles:create");
  await user.click(create);
  await waitFor(() =>
    expect(create.hasAttribute("disabled") || create.getAttribute("aria-disabled") === "true").toBe(true),
  );
  // A second press while it runs sends nothing more.
  await user.keyboard("{Enter}");
  release();
  expect((await within(dialog).findByRole("alert")).textContent).toBe(UNSAVED);
  expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Personal");
  expect((within(dialog).getByRole("textbox", { name: "Code" }) as HTMLInputElement).value).toBe("PERS");
  await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
  expect(calls.filter(([name]) => name.endsWith(":create"))).toHaveLength(1);
});

test("a change that cannot reach the server is announced each time, and the list stays as the server has it", async () => {
  await mount([profile("p1", "PERS", "Personal", [work.id])]);
  const pers = box("PERS");
  const region = document.querySelector('[aria-live="polite"]')!;
  const heard: string[] = [];
  new MutationObserver(() => heard.push(region.textContent ?? "")).observe(region, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  broken.add("ai-profiles/profiles:add");
  for (let attempt = 0; attempt < 2; attempt++) {
    drag(article("Claude Pro, Personal"), pers, 50).drop();
    await waitFor(() => expect(heard.filter((text) => text === UNSAVED)).toHaveLength(attempt + 1));
  }
  // Emptied between the two tellings, so a reader hears the same sentence again.
  expect(heard.slice(heard.indexOf(UNSAVED) + 1, heard.lastIndexOf(UNSAVED))).toContain("");
  expect(
    within(pers)
      .getAllByRole("listitem")
      .map((item) => item.getAttribute("aria-label")),
  ).toEqual(["1. Claude Max, Work"]);
});

test("Add to profile sits in the card's action row, always shown, with a tooltip; pressing it starts no drag", async () => {
  const user = userEvent.setup({ document });
  await mount([profile("p1", "PERS", "Personal")]);
  const button = within(article("Claude Pro, Personal")).getByRole("button", {
    name: "Add Claude Pro, Personal to a profile",
  });
  // In the action row beside Remove, not hidden until hover.
  const row = button.closest("div")!;
  expect(within(row).getByRole("button", { name: "Remove Claude Pro, Personal" })).toBeTruthy();
  expect(button.closest("[class*='opacity-0']")).toBeNull();
  // A press on it is not a drag: moved and released over the profile, it adds nothing.
  document.elementFromPoint = () => box("PERS");
  pointer("pointerdown", button, 0);
  pointer("pointermove", box("PERS"), 120);
  pointer("pointerup", box("PERS"), 120);
  expect(changes()).toEqual([]);
  await user.hover(button);
  expect((await screen.findByRole("tooltip")).textContent).toBe("Add to profile");
});

test("a card shows up to three profile codes; with more, two and +N", async () => {
  const codes = ["PERS", "SBOX", "ACME", "WORK"];
  await mount(codes.slice(0, 3).map((code, i) => profile(`p${i}`, code, code, [personal.id])));
  const line = () => within(article("Claude Pro, Personal"));
  for (const code of codes.slice(0, 3)) expect(line().getByText(code)).toBeTruthy();
  expect(line().queryByText(/^\+/)).toBeNull();
  // A fourth profile takes it in: two codes stay, and "+2" stands for the rest.
  profiles = codes.map((code, i) => profile(`p${i}`, code, code, [personal.id]));
  push();
  await waitFor(() => expect(line().getByText("+2")).toBeTruthy());
  expect(line().getByText("PERS")).toBeTruthy();
  expect(line().getByText("SBOX")).toBeTruthy();
  expect(line().queryByText("ACME")).toBeNull();
  expect(line().getByText("+2")).toBeTruthy();
});
