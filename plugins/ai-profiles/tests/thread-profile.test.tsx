import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { render } from "@solidjs/web";
import { expect, test } from "vitest";
import { TokamakClient, type ClientTransport, type Id, type JsonValue } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import { Menu } from "@tokamak/ui";
import { isHeld } from "../../chat/src/client/lib/hold";
import type { ComposerProps } from "plugin:chat/client";
import { PickerProfileChip, PickerProfileColumn, PickerProfileStatus } from "../src/client/ui/thread-profile";

const profile = {
  id: "ai-profiles/profiles:test",
  name: "Work",
  code: "WORK",
  subscriptions: [],
  createdAt: 0,
};
const threadId = "chat/threads:test" as Id<"threads">;
const composer = { threadId } as ComposerProps;

function mount(profiles: (typeof profile)[]) {
  const subscriptions = new Set<(event: { value: JsonValue }) => void>();
  let saved: JsonValue;
  let refreshes = 0;
  const connection = new TokamakClient({
    subscribe(name: string, _args: JsonValue, listener: (event: { value: JsonValue }) => void) {
      const isList = name === "ai-profiles/profiles:list";
      const isSelection = name === "ai-profiles/thread-profiles:selection";
      if (isSelection) subscriptions.add(listener);
      const value = isList ? profiles : isSelection ? null : { subscriptions: [], signIns: [] };
      queueMicrotask(() => listener({ value }));
      return () => subscriptions.delete(listener);
    },
    async action() {
      return [];
    },
    async mutation(_name: string, args: JsonValue) {
      saved = args;
      for (const listener of subscriptions)
        listener({ value: { id: profile.id, code: profile.code, agents: { claude: null, codex: null } } });
      return null;
    },
  } as unknown as ClientTransport);
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(
    () => (
      <ClientContext value={connection}>
        <Menu.Root>
          <Menu.Trigger>
            Agent
            <PickerProfileChip
              threadId={threadId}
              resetCatalog={() => {}}
              refreshCatalog={() => {
                refreshes++;
              }}
            />
          </Menu.Trigger>
          <Menu.Content>
            <PickerProfileColumn threadId={threadId} />
          </Menu.Content>
        </Menu.Root>
        <PickerProfileStatus threadId={threadId} />
      </ClientContext>
    ),
    root,
  );
  return {
    saved: () => saved,
    refreshes: () => refreshes,
    close: () => {
      dispose();
      root.remove();
    },
  };
}

test("a profile is required until picked, then the composer shows its code and refreshes the catalog", async () => {
  const mounted = mount([profile]);
  try {
    await screen.findByText("Pick a profile to send.");
    expect(isHeld(composer)).toBe(true);
    const trigger = screen.getByRole("button", { name: /Agent.*Profile/ });
    expect(
      within(trigger).getByText("Profile").closest('[data-slot="chip"]')?.classList.contains("text-warn"),
    ).toBe(true);
    const user = userEvent.setup();
    await user.click(trigger);
    const row = await screen.findByRole("menuitemradio", { name: "WORK" });
    expect(row.querySelector("svg")).not.toBeNull();
    await user.click(row);
    await waitFor(() => expect(mounted.saved()).toEqual({ thread: threadId, profile: profile.id }));
    expect(row.getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{Escape}");
    await screen.findByRole("button", { name: /Agent.*WORK/ });
    expect(screen.queryByText("Pick a profile to send.")).toBeNull();
    expect(isHeld(composer)).toBe(false);
    expect(mounted.refreshes()).toBeGreaterThan(0);
  } finally {
    mounted.close();
  }
});

test("with no profiles, the composer adds no column, chip or Send hold", async () => {
  const mounted = mount([]);
  try {
    await waitFor(() => expect(isHeld(composer)).toBe(false));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Agent" }));
    await screen.findByRole("menu");
    expect(screen.queryByText("Profile")).toBeNull();
    expect(screen.queryByText("Pick a profile to send.")).toBeNull();
    expect(mounted.refreshes()).toBe(0);
  } finally {
    mounted.close();
  }
});
