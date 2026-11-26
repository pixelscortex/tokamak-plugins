import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TokamakClient, type ClientTransport, type JsonValue } from "@tokamak/sdk";
import { RegionOutlet, RegionProvider } from "@tokamak/sdk/client";
import { ClientContext } from "@tokamak/sdk/solid";
import type { SignIn, Subscription } from "../src/client/lib/api";
import * as desktop from "../src/client/lib/desktop";
import { openSubscription } from "../src/client/lib/manage";
import { Profiles } from "../src/client/pages/profiles";

// The desktop app's return listener on the Profiles page, for every kind of
// waiting sign-in and both companies: the port and path come from each
// company's return address (`lib/companies.ts`), the expected state from the
// sign-in's own link, and a return is finished without anyone pasting it,
// with no dialog open. desktop-sign-in.test.tsx covers the listener's life
// (busy, unavailable, cancel, expiry, replacement) for one Claude sign-in.

vi.mock("../src/client/lib/desktop", () => ({
  hasDesktopSignIn: vi.fn(),
  listenForSignInReturn: vi.fn(),
  cancelSignInReturn: vi.fn(),
  openSignInBrowser: vi.fn(),
}));

type Return = Awaited<ReturnType<typeof desktop.listenForSignInReturn>>;
const team: Subscription = {
  id: "agent-proxy/subscriptions:team",
  company: "anthropic",
  method: "subscription",
  label: "Acme",
  enabled: true,
  plan: "Team",
  status: "ok",
  accounts: [{ id: "agent-proxy/accounts:a1", email: "you@acme.test", status: "ok" }],
  models: [],
  createdAt: 1,
};

let unmount: (() => void) | undefined;
/** The page with `signIns` waiting; `finishSignIn` answers `answer` and empties the list. */
function mount(signIns: SignIn[], answer: Subscription) {
  let listed = { signIns, subscriptions: [team] };
  let publish = () => {};
  const finish = vi.fn(async (_args: JsonValue) => {
    listed = { signIns: [], subscriptions: [team, answer].filter((item, i, all) => all.indexOf(item) === i) };
    publish();
    return answer as unknown as JsonValue;
  });
  const transport: ClientTransport = {
    query: async () => null,
    mutation: async () => null,
    action: async (name, args) => (name.endsWith(":finishSignIn") ? finish(args) : null),
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
  };
  return { finish };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(desktop.hasDesktopSignIn).mockReturnValue(true);
  vi.mocked(desktop.cancelSignInReturn).mockResolvedValue(undefined);
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.replaceChildren();
});

test("a ChatGPT sign-in is listened for on 1455 /auth/callback with its own state, and its return finishes it", async () => {
  const address = "http://localhost:1455/auth/callback?code=synthetic&state=gpt-state";
  vi.mocked(desktop.listenForSignInReturn)
    .mockResolvedValueOnce({ status: "returned", address } as Return)
    .mockReturnValue(new Promise<Return>(() => {}));
  const chatgpt: SignIn = {
    id: "agent-proxy/signIns:g1",
    company: "openai",
    method: "subscription",
    link: "https://auth.openai.example/oauth/authorize?state=gpt-state",
    startedAt: Date.now(),
    expired: false,
  };
  const { finish } = mount([chatgpt], { ...team, id: "agent-proxy/subscriptions:gpt", company: "openai" });
  await waitFor(() =>
    expect(desktop.listenForSignInReturn).toHaveBeenCalledWith(
      expect.objectContaining({ port: 1455, path: "/auth/callback", expectedState: "gpt-state" }),
    ),
  );
  await waitFor(() => expect(finish).toHaveBeenCalledWith({ id: chatgpt.id, pasted: address }));
});

test("an add-account sign-in waiting with no dialog open is finished by its return, on its company's port", async () => {
  const address = "http://localhost:54545/callback?code=synthetic&state=add-state";
  vi.mocked(desktop.listenForSignInReturn)
    .mockResolvedValueOnce({ status: "returned", address } as Return)
    .mockReturnValue(new Promise<Return>(() => {}));
  const another: SignIn = {
    id: "agent-proxy/signIns:add1",
    company: "anthropic",
    method: "subscription",
    link: "https://claude.example/oauth/authorize?state=add-state",
    startedAt: Date.now(),
    expired: false,
    addTo: team.id,
  };
  const { finish } = mount([another], team);
  await waitFor(() =>
    expect(desktop.listenForSignInReturn).toHaveBeenCalledWith(
      expect.objectContaining({ port: 54545, path: "/callback", expectedState: "add-state" }),
    ),
  );
  await waitFor(() => expect(finish).toHaveBeenCalledWith({ id: another.id, pasted: address }));
});

// The details' "Add account" waits in the details' own dialog, while the page's
// return watch finishes it. The details must say how it ended, never assume it
// was cancelled in another window, even when their list never showed it.

/** The page with the details of `team` open; `addAccount` starts `another`, `finishSignIn` answers `answer`. */
let added = 0;
async function details(answer: JsonValue, after: Subscription | undefined) {
  const another: SignIn = {
    id: `agent-proxy/signIns:add-details-${++added}`,
    company: "anthropic",
    method: "subscription",
    link: "https://claude.example/oauth/authorize?state=add2-state",
    startedAt: Date.now(),
    expired: false,
    addTo: team.id,
  };
  let listed = { signIns: [] as SignIn[], subscriptions: [team] };
  let publish = () => {};
  const transport: ClientTransport = {
    query: async () => null,
    mutation: async () => null,
    action: async (name) => {
      if (name.endsWith(":addAccount")) return another as unknown as JsonValue;
      if (name.endsWith(":finishSignIn")) {
        // The sign-in ends on the server; the list never showed it.
        if (after) listed = { signIns: [], subscriptions: [after] };
        publish();
        return answer;
      }
      return null;
    },
    subscribe(name, _args, onEvent) {
      if (name === "ai-profiles/profiles:list" || name === "ai-profiles/manage:usedBy") {
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
    openSubscription.set(undefined);
  };
  const user = userEvent.setup({ document });
  const card = await screen.findByRole("article", { name: "Claude Team, Acme" });
  await user.click(within(card).getByRole("button", { name: "Claude Team, Acme details" }));
  const region = await screen.findByRole("region", { name: "Claude Team details" });
  await user.click(within(region).getByRole("button", { name: "Add account" }));
  return region;
}

test("an add-account return the page finished before the details' list showed it closes their dialog", async () => {
  // The return is held until the details' dialog is open on the sign-in step.
  // Held until the details' dialog is open; every listen the page starts waits for the same return.
  let arrive: (result: Return) => void = () => {};
  const held = new Promise<Return>((done) => (arrive = done));
  vi.mocked(desktop.listenForSignInReturn).mockImplementation(() => held);
  const two: Subscription = {
    ...team,
    accounts: [...team.accounts, { id: "agent-proxy/accounts:a2", email: "you2@acme.test", status: "ok" }],
  };
  const region = await details(two as unknown as JsonValue, two);
  expect(await screen.findByRole("dialog", { name: "Sign in to Claude" })).toBeTruthy();
  await waitFor(() => expect(desktop.listenForSignInReturn).toHaveBeenCalled());
  arrive({ status: "returned", address: "http://localhost:54545/callback?code=c&state=add2-state" });
  // Nothing to label after another account: the dialog closes when it is in, and nobody says "cancelled".
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await within(region).findByText("you2@acme.test")).toBeTruthy();
  expect(screen.queryByText(/cancelled in another window/)).toBeNull();
});

test("an add-account return the page finished with a failure is said in the details as that failure", async () => {
  // Held until the details' dialog is open; every listen the page starts waits for the same return.
  let arrive: (result: Return) => void = () => {};
  const held = new Promise<Return>((done) => (arrive = done));
  vi.mocked(desktop.listenForSignInReturn).mockImplementation(() => held);
  const message = "you@acme.test is already in this subscription.";
  const region = await details({ failed: true, kind: "AlreadyAdded", data: { message } }, undefined);
  expect(await screen.findByRole("dialog", { name: "Sign in to Claude" })).toBeTruthy();
  await waitFor(() => expect(desktop.listenForSignInReturn).toHaveBeenCalled());
  arrive({ status: "returned", address: "http://localhost:54545/callback?code=c&state=add2-state" });
  expect(await within(region).findByText(message)).toBeTruthy();
  expect(screen.queryByText(/cancelled in another window/)).toBeNull();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
