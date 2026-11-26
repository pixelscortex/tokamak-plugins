import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TokamakClient, type ClientTransport, type JsonValue } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import type { SignIn, Subscription } from "../src/client/lib/api";
import * as desktop from "../src/client/lib/desktop";
import { Profiles } from "../src/client/pages/profiles";

vi.mock("../src/client/lib/desktop", () => ({
  hasDesktopSignIn: vi.fn(),
  listenForSignInReturn: vi.fn(),
  cancelSignInReturn: vi.fn(),
  openSignInBrowser: vi.fn(),
}));

const address = "http://localhost:54545/callback?code=synthetic&state=test";
const subscription: Subscription = {
  id: "subscription",
  company: "anthropic",
  method: "subscription",
  label: "Personal",
  enabled: true,
  plan: "Pro",
  status: "ok",
  accounts: [],
  models: [],
  createdAt: 1,
};

function pending<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let id = 0;
function mount() {
  const signIn: SignIn = {
    id: `sign-in-${++id}`,
    company: "anthropic",
    method: "subscription",
    link: "https://claude.example/authorize?state=test",
    startedAt: Date.now(),
    expired: false,
  };
  type Listing = { signIns: SignIn[]; subscriptions: Subscription[] };
  let listed: Listing = { signIns: [signIn], subscriptions: [] };
  let publish: () => void = () => {};
  const update = (next: Listing) => {
    listed = next;
    publish();
  };
  const finish = vi.fn(async (_args: JsonValue) => {
    update({ signIns: [], subscriptions: [subscription] });
    return subscription as unknown as JsonValue;
  });
  const cancel = vi.fn(async (_args: JsonValue) => {
    update({ signIns: [], subscriptions: [] });
    return null;
  });
  const transport: ClientTransport = {
    async query() {
      return null;
    },
    async action(name, args) {
      return name.endsWith(":finishSignIn") ? finish(args) : null;
    },
    async mutation(name, args) {
      return name.endsWith(":cancelSignIn") ? cancel(args) : null;
    },
    subscribe(name, _args, onEvent) {
      // The Profiles section's own list (TKM-264): none here.
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
  return { finish, cancel, signIn, update };
}

async function continueSignIn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  return within(await screen.findByRole("dialog", { name: "Sign in to Claude" }));
}

let unmount: (() => void) | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(desktop.hasDesktopSignIn).mockReturnValue(true);
  vi.mocked(desktop.cancelSignInReturn).mockResolvedValue(undefined);
  vi.mocked(desktop.openSignInBrowser).mockResolvedValue("opened");
});

afterEach(async () => {
  for (const close of document.querySelectorAll<HTMLElement>('[role="dialog"] [aria-label="Close"]'))
    close.click();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  unmount?.();
  document.body.replaceChildren();
});

type Return = Awaited<ReturnType<typeof desktop.listenForSignInReturn>>;

test("the return finishes from the Awaiting sign-in card after the system browser opens and the dialog closes", async () => {
  const incoming = pending<Return>();
  vi.mocked(desktop.listenForSignInReturn).mockReturnValue(incoming.promise);
  const { signIn, finish } = mount();
  const user = userEvent.setup({ document });
  const dialog = await continueSignIn(user);
  // Listening: Tokamak finishes by itself, and the field stays for another device or a return that did not come.
  expect(
    await dialog.findByText("Sign in in your browser. Tokamak finishes by itself when you are done."),
  ).toBeTruthy();
  expect(
    dialog.getByText(
      "Signing in on another device, or it did not finish? The browser ends on a page that may not load. Copy its whole address and paste it here.",
    ),
  ).toBeTruthy();
  await user.click(dialog.getByRole("button", { name: "Open sign-in page" }));
  expect(desktop.openSignInBrowser).toHaveBeenCalledWith(signIn.link);
  await user.click(dialog.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(desktop.listenForSignInReturn).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ port: 54545, path: "/callback", expectedState: "test" }),
  );
  expect(desktop.cancelSignInReturn).not.toHaveBeenCalled();
  incoming.resolve({ status: "returned", address });
  expect(await screen.findByText("Personal")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(finish).toHaveBeenCalledExactlyOnceWith({ id: signIn.id, pasted: address });
});

test.each(["busy", "unavailable"] as const)(
  "%s uses browser wording and keeps the paste path",
  async (status) => {
    vi.mocked(desktop.listenForSignInReturn).mockResolvedValue({ status });
    const { signIn, finish } = mount();
    const user = userEvent.setup({ document });
    const dialog = await continueSignIn(user);
    expect(
      await dialog.findByText(
        "Sign in in your browser. It ends on a page that may not load. Copy its whole address and paste it here.",
      ),
    ).toBeTruthy();
    expect(dialog.queryByText(/finishes by itself/)).toBeNull();
    const field = dialog.getByRole("textbox", { name: /Address the sign-in/ });
    await user.clear(field);
    await user.type(field, address);
    await user.click(dialog.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("dialog", { name: "Connected" })).toBeTruthy();
    expect(finish).toHaveBeenCalledExactlyOnceWith({ id: signIn.id, pasted: address });
  },
);

test.each(["paste in flight", "failed automatic finish"] as const)(
  "%s leaves the return available to retry",
  async (mode) => {
    const incoming = pending<Return>();
    vi.mocked(desktop.listenForSignInReturn)
      .mockReturnValueOnce(incoming.promise)
      .mockReturnValue(pending<Return>().promise);
    const { signIn, finish } = mount();
    const paste = pending<JsonValue>();
    if (mode === "paste in flight") finish.mockReturnValueOnce(paste.promise);
    else finish.mockRejectedValueOnce(new Error("Connection lost"));
    const user = userEvent.setup({ document });
    const dialog = await continueSignIn(user);
    const field = dialog.getByRole<HTMLInputElement>("textbox", { name: /Address the sign-in/ });
    if (mode === "paste in flight") {
      await user.clear(field);
      await user.type(field, "other");
      await user.click(dialog.getByRole("button", { name: "Continue" }));
    }
    incoming.resolve({ status: "returned", address });
    await waitFor(() => expect(field.value).toBe(address));
    expect(finish).toHaveBeenCalledTimes(1);
    if (mode === "paste in flight")
      paste.resolve({ failed: true, kind: "WrongSignIn", data: { message: "Wrong state" } });
    await dialog.findByRole("alert");
    await user.click(dialog.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("dialog", { name: "Connected" })).toBeTruthy();
    expect(finish).toHaveBeenLastCalledWith({ id: signIn.id, pasted: address });
  },
);

test.each(["cancel", "expiry", "unmount"] as const)(
  "%s stops listening and ignores a late return",
  async (end) => {
    const incoming = pending<Return>();
    vi.mocked(desktop.listenForSignInReturn).mockReturnValue(incoming.promise);
    const { cancel, finish, signIn, update } = mount();
    const button = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(desktop.listenForSignInReturn).toHaveBeenCalledTimes(1));
    const [[{ requestId }]] = vi.mocked(desktop.listenForSignInReturn).mock.calls;
    if (end === "unmount") unmount?.();
    else if (end === "expiry") update({ subscriptions: [], signIns: [{ ...signIn, expired: true }] });
    else {
      await userEvent.setup({ document }).click(button);
      expect(cancel).toHaveBeenCalledWith({ id: signIn.id });
    }
    await waitFor(() => expect(desktop.cancelSignInReturn).toHaveBeenCalledExactlyOnceWith(54545, requestId));
    incoming.resolve({ status: "returned", address });
    await incoming.promise;
    expect(finish).not.toHaveBeenCalled();
  },
);

test("a newer sign-in replaces the previous listener on its company's port", async () => {
  vi.mocked(desktop.listenForSignInReturn).mockReturnValue(pending<Return>().promise);
  const { signIn, update } = mount();
  await waitFor(() => expect(desktop.listenForSignInReturn).toHaveBeenCalledTimes(1));
  const [[{ requestId }]] = vi.mocked(desktop.listenForSignInReturn).mock.calls;
  const newer = {
    ...signIn,
    id: "newer",
    startedAt: signIn.startedAt + 1,
    link: signIn.link.replace("test", "new"),
  };
  update({ signIns: [signIn, newer], subscriptions: [] });
  await waitFor(() => expect(desktop.listenForSignInReturn).toHaveBeenCalledTimes(2));
  expect(desktop.cancelSignInReturn).toHaveBeenCalledWith(54545, requestId);
  expect(desktop.listenForSignInReturn).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedState: "new" }),
  );
});
