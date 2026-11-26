import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { render } from "@solidjs/web";
import { afterEach, expect, test } from "vitest";
import { TokamakClient, fail, type ClientTransport, type Id, type JsonValue } from "@tokamak/sdk";
import { ShortcutContext } from "@tokamak/sdk/client";
import { ClientContext } from "@tokamak/sdk/solid";
import type { ComposerProps } from "plugin:chat/client";
import { submitDraft } from "../../chat/src/client/lib/sent";
import { isHeld } from "../../chat/src/client/lib/hold";
import type { Info } from "../src/contracts";
import { refreshAgents } from "../src/client/lib/agents";
import { startTurn } from "../src/client/lib/turn";
import { AgentRow } from "../src/client/ui/agent-row";

// The agent row on its own, with a stand-in client: the Runner answers
// `agents:list` with whatever `installed` holds at that moment, the server
// answers `choices:get` with `stored` and records each `choices:set` in `saved`.

const ready: Info = {
  installed: true,
  signedIn: true,
  install: "",
  signIn: "",
  models: [{ id: "opus", name: "opus 5.5", efforts: [] }],
  speeds: [],
  modes: [],
};
let installed: { id: string; name: string; info: Info }[] = [];
let stored: JsonValue = null;
let scoped: typeof installed | undefined;
let requestedScope: JsonValue;
let creator: JsonValue = { id: "local", name: "Sam" };
let asked = 0;
let hasMachine = true;
let active: JsonValue = null;
let queued: JsonValue = [];
let shortcut: (() => void) | undefined;
const actions: string[] = [];
const threadId = "chat/threads:fixture" as Id<"threads">;
const turnId = "ai/turns:fixture" as Id<"turns">;
let saved: JsonValue[] = [];

function client(): TokamakClient {
  const transport = {
    mutation: async (name: string, args: JsonValue) => {
      if (name === "ai/turns:enqueue") return null;
      if (name !== "ai/choices:set") throw new Error(`Unexpected mutation ${name}`);
      saved.push(args);
      return null;
    },
    subscribe: (name: string, _args: JsonValue, onEvent: (event: { value: JsonValue }) => void) => {
      queueMicrotask(() => onEvent({ value: answer(name) }));
      return () => {};
    },
    query: async (name: string) => (name === "ai/turns:pending" ? active : answer(name)),
    action: async (name: string, args: { threadId?: string; draft?: boolean }) => {
      actions.push(name);
      if (name === "chat/folders:resolve") return "/fixture";
      if (!hasMachine) return fail("noMachine", null);
      if (name === "ai/working:list") return [];
      if (name === "ai/run:stop") return null;
      if (name === "ai/run:steer") return { error: null };
      if (name === "ai/run:turn") return { turnId, state: "done" };
      if (name !== "ai/agents:list") throw new Error(`Unexpected action ${name}`);
      asked += 1;
      if (args.threadId || args.draft) requestedScope = args.threadId ?? "draft";
      return structuredClone(
        (args.threadId || args.draft) && scoped ? scoped : installed,
      ) as unknown as JsonValue;
    },
  } as unknown as ClientTransport;
  return new TokamakClient(transport);
}

/** The closed picker by its "Agent: <name> · <model> · <effort>" text (jsdom drops the space browsers keep). */
const chip = (value = ".+") => new RegExp(`^Agent: ?${value}$`);

/** What the stand-in server answers each live query with. */
function answer(name: string): JsonValue {
  if (name === "ai/choices:get") return stored;
  if (name === "ai/choices:creator") return creator;
  if (name === "ai/turns:ready") return queued;
  if (name === "ai/turns:questions") return [];
  if (name === "ai/turns:active") return active;
  if (name === "auth:caller")
    return {
      user: { id: "local", name: "Sam", role: "owner" },
      device: { id: "here", name: "This computer" },
    };
  throw new Error(`Unexpected query ${name}`);
}

const composer = (threadId: string | undefined) => ({ threadId }) as unknown as ComposerProps;

function mount(threadId: string | undefined, connection = client()) {
  const root = document.createElement("div");
  document.body.append(root);
  const props = {
    ...composer(threadId),
    folder: undefined,
    draft: "",
    sending: false,
    onDraft() {},
    onSend() {},
  };
  const dispose = render(
    () => (
      <ClientContext value={connection}>
        <ShortcutContext
          value={{
            registerShortcut: (_key, run) => {
              shortcut = run;
              return () => {
                shortcut = undefined;
              };
            },
          }}
        >
          <AgentRow {...(props as ComposerProps)} />
        </ShortcutContext>
      </ClientContext>
    ),
    root,
  );
  cleanups.push(() => {
    dispose();
    root.remove();
  });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  stored = null;
  scoped = undefined;
  requestedScope = null;
  creator = { id: "local", name: "Sam" };
  asked = 0;
  hasMachine = true;
  active = null;
  queued = [];
  actions.length = 0;
  saved = [];
});

test("with one agent, signed out, the agent picker still opens and asks again", async () => {
  installed = [{ id: "solo", name: "Solo", info: { ...ready, signedIn: false } }];
  mount(undefined);
  const status = await screen.findByRole("status");
  expect(status.textContent).toBe("Solo is signed out. Sign in, then come back.");
  expect(isHeld(composer(undefined))).toBe(true);
  // Signed out, the chip names only the agent.
  const closed = screen.getByRole("button", { name: chip("Solo") });

  // Signing in meanwhile; opening the picker asks the agent again.
  installed = [{ id: "solo", name: "Solo", info: ready }];
  const before = asked;
  await user.click(closed);
  await waitFor(() => expect(asked).toBeGreaterThan(before));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(isHeld(composer(undefined))).toBe(false);
  // The open popover hides the rest of the window from screen readers.
  expect(screen.getByRole("button", { name: chip("Solo · opus 5.5"), hidden: true })).toBeTruthy();
});

test("a thread whose agent plugin was removed keeps that agent, says it isn't installed and holds Send", async () => {
  installed = [{ id: "solo", name: "Solo", info: ready }];
  stored = { agent: { id: "gone", name: "Gone" }, model: "opus", access: "ask" };
  mount("t1");
  const status = await screen.findByRole("status");
  expect(status.textContent).toBe("Gone isn't installed.");
  expect(screen.getByRole("button", { name: chip("Gone") })).toBeTruthy();
  expect(isHeld(composer("t1"))).toBe(true);
  expect(isHeld(composer("t2"))).toBe(false);
});

test("in someone else's thread the row names the creator and hides the agent pickers", async () => {
  installed = [{ id: "solo", name: "Solo", info: ready }];
  stored = { agent: { id: "gone", name: "Gone" }, model: "opus", access: "ask" };
  creator = { id: "morgan", name: "Morgan" };
  mount("t1");
  const status = await screen.findByRole("status");
  expect(status.textContent).toBe("Only Morgan can run the agent here");
  expect(screen.queryByRole("button")).toBeNull();
  // The creator's missing agent does not hold another member's text.
  expect(isHeld(composer("t1"))).toBe(false);
});

const sent = {
  threadId,
  messageId: "chat/messages:fixture" as Id<"messages">,
  text: "Hello",
  first: true,
};

test("no machine is shown only when a Send tries to start a turn", async () => {
  installed = [];
  hasMachine = false;
  const connection = client();
  mount(undefined, connection);
  await refreshAgents(connection);
  await startTurn(connection, { ...sent, folder: undefined });
  await startTurn(connection, { ...sent, folder: "/fixture" });
  expect(screen.queryByRole("status")).toBeNull();
  expect(actions).not.toContain("ai/run:turn");

  installed = [{ id: "solo", name: "Solo", info: ready }];
  hasMachine = true;
  await refreshAgents(connection);
  hasMachine = false;
  await startTurn(connection, { ...sent, folder: "/fixture" });
  expect((await screen.findByRole("status")).textContent).toBe("Connect a machine to run this.");
  expect(actions).toContain("ai/run:turn");
});

test("a transient noMachine leaves Stop and steer usable and retries a ready queue", async () => {
  installed = [{ id: "solo", name: "Solo", info: ready }];
  active = { _id: turnId, threadId, state: "running", sender: { id: "local", device: "here" } };
  queued = [
    {
      _id: "ai/turns:queued",
      threadId: "chat/threads:queued",
      messageId: "queued",
      agent: { id: "solo", name: "Solo" },
    },
  ];
  hasMachine = false;
  const connection = client();
  hasMachine = true;
  await refreshAgents(connection);
  hasMachine = false;
  mount(threadId, connection);
  await waitFor(() => {
    expect(actions).toContain("ai/run:turn");
    expect(shortcut).toBeDefined();
  });
  // Discovery also lost the Runner; it must not disable shortcuts or consume the draft as chat.
  await refreshAgents(connection);
  expect(shortcut).toBeDefined();
  await expect(submitDraft({ threadId, text: "Steer", intent: "steer" })).rejects.toThrow(
    "Connect a machine to run this.",
  );

  hasMachine = true;
  await expect(submitDraft({ threadId, text: "Steer", intent: "steer" })).resolves.toBe(true);
  await waitFor(() => expect(actions.filter((name) => name === "ai/run:turn")).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("esc to stop"));
  shortcut?.();
  await waitFor(() => expect(actions).toContain("ai/run:stop"));
});

// Two agents as the picker lists them: Solo offers levels, speeds and modes; Other only a model.
const solo = {
  id: "solo",
  name: "Solo",
  info: {
    ...ready,
    models: [
      { id: "opus", name: "Solo Opus 5.5", efforts: ["low", "high"] },
      { id: "haiku", name: "Haiku 5.5", efforts: ["low"] },
    ],
    speeds: ["standard", "fast"],
    modes: ["build", "plan"],
  },
};
const other = { id: "other", name: "Other", info: ready };

const user = userEvent.setup();

/** Opens the picker and waits for its popover. */
async function open(name: RegExp) {
  await user.click(await screen.findByRole("button", { name }));
  return screen.findByRole("menu");
}

/** The radio items of one group in the open popover, as "label" or "label ✓" when checked. */
function choices(group: string) {
  return [...screen.getByRole("group", { name: group }).querySelectorAll("[role=menuitemradio]")].map(
    (item) => `${item.textContent}${item.getAttribute("aria-checked") === "true" ? " ✓" : ""}`,
  );
}

test("the picker is one popover: agent and model, effort, then speed, mode, access and the computer", async () => {
  installed = [solo, other];
  stored = {
    agent: { id: "solo", name: "Solo" },
    model: "opus",
    effort: "high",
    speed: "fast",
    access: "full",
  };
  mount("t1");
  // The closed chip: the agent's model without the agent's name, then the level.
  const menu = await open(chip("Solo · Opus 5.5 · High"));
  expect(menu.textContent).toContain("Agent and model");
  // Every agent with its models; the thread's model is checked.
  expect(choices("Agent and model")).toEqual(["Opus 5.5 ✓", "Haiku 5.5", "opus 5.5"]);
  expect(choices("Effort")).toEqual(["Low", "High ✓"]);
  expect(choices("Speed")).toEqual(["Standard", "Fast ✓"]);
  // The mode was never picked: the first one the agent offers.
  expect(choices("Mode")).toEqual(["Build ✓", "Plan"]);
  expect(choices("Access level")).toEqual(["Full access ✓", "Ask first"]);
  expect(menu.textContent).toContain("Runs onThis computer");
});

test("a pick is stored on the thread as it is made, and another agent's model switches agent", async () => {
  installed = [solo, other];
  stored = {
    agent: { id: "solo", name: "Solo" },
    model: "opus",
    effort: "high",
    speed: "fast",
    access: "ask",
  };
  mount("t1");
  await open(chip("Solo · Opus 5.5 · High"));
  await user.click(screen.getByRole("menuitemradio", { name: "Low" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toEqual({
    threadId: "t1",
    agent: { id: "solo", name: "Solo" },
    model: "opus",
    effort: "low",
    speed: "fast",
    mode: "build",
    access: "ask",
  });

  // The same popover stays open for the next choice: Other's only model.
  await user.click(screen.getByRole("menuitemradio", { name: "opus 5.5" }));
  await waitFor(() => expect(saved).toHaveLength(2));
  expect(saved[1]).toEqual({
    threadId: "t1",
    agent: { id: "other", name: "Other" },
    model: "opus",
    access: "ask",
  });
});

test("a stored model, level or speed no longer offered falls back to the first offered one", async () => {
  installed = [solo];
  stored = {
    agent: { id: "solo", name: "Solo" },
    model: "retired",
    effort: "max",
    speed: "warp",
    access: "full",
  };
  mount("t1");
  await open(chip("Solo · Opus 5.5 · Low"));
  expect(choices("Agent and model")).toEqual(["Opus 5.5 ✓", "Haiku 5.5"]);
  expect(choices("Effort")).toEqual(["Low ✓", "High"]);
  expect(choices("Speed")).toEqual(["Standard ✓", "Fast"]);
  // What a change stores is the fallback too, never the retired values.
  await user.click(screen.getByRole("menuitemradio", { name: "Plan" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toMatchObject({ model: "opus", effort: "low", speed: "standard", mode: "plan" });
});

test("a scoped catalog keeps the thread's current agent until an offered agent is selected", async () => {
  const claude = { id: "claude", name: "Claude", info: ready };
  const codex = { id: "codex", name: "Codex", info: ready };
  installed = [claude, codex];
  scoped = [claude];
  stored = { agent: { id: "codex", name: "Codex" }, model: "opus", access: "full" };
  mount(threadId);
  await user.click(await screen.findByRole("button", { name: /^Agent: ?Codex/ }));
  await screen.findByText("Codex · Not available");
  expect(requestedScope).toBe(threadId);
  expect(isHeld(composer(threadId))).toBe(true);
  expect(saved).toEqual([]);
  expect(screen.getByRole("menuitemradio", { name: "opus 5.5" })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Codex" })).toBeNull();
});
