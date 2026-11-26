import { render, type JSX } from "@solidjs/web";
import { fail, TokamakClient, type ClientTransport, type Id, type JsonValue } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import type { MessageProps } from "plugin:chat/client";
import { For, Show, flush } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { Changes, Cleanup, Notices } from "../src/client/api";
import { BranchChip } from "../src/client/ui/thread-header";

const Notice = Notices.layer!;
const Prune = Cleanup.layer!;
const noMachine = fail("noMachine", null);
const unavailable = fail("runnerCapabilityUnavailable", "privateFunctions");
const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(name: string, count: number) {
  const threadId = `chat/threads:${name}` as Id<"threads">;
  const replies = Array.from({ length: count }, (_, i) => ({
    threadId,
    message: {
      _id: `chat/messages:${name}-${i}`,
      role: "assistant",
      author: { id: "agent:probe" },
      status: "complete",
    },
  })) as MessageProps[];
  const action = vi.fn<NonNullable<ClientTransport["action"]>>();
  const client = new TokamakClient({
    action,
    query: async () =>
      replies.map(({ message }) => ({ _id: message._id, replyId: message._id, state: "done" })),
    mutation: async () => null,
    subscribe: () => () => {},
  });

  function mount(view: () => JSX.Element) {
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(() => <ClientContext value={client}>{view()}</ClientContext>, root);
    const stop = () => {
      dispose();
      root.remove();
    };
    disposers.push(stop);
    return { root, stop };
  }

  return { threadId, replies, action, mount };
}

async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

test("many replies share one Runner probe and focus recovers the branch, cards and notices", async () => {
  vi.useFakeTimers();
  const { threadId, replies, action, mount } = fixture("browser", 30);
  action.mockResolvedValue(noMachine);
  const { root } = mount(() => (
    <>
      <BranchChip
        thread={{ _id: threadId } as Parameters<typeof BranchChip>[0]["thread"]}
        onRename={async () => {}}
        onDelete={async () => {}}
      />
      <For each={replies} keyed={(reply) => reply.message._id}>
        {(reply) => (
          <>
            <Notice threadId={reply().threadId} message={reply().message} />
            <Show when={Changes.when!(reply())}>Changed files</Show>
          </>
        )}
      </For>
    </>
  ));

  await tick();
  expect(action).toHaveBeenCalledTimes(1);
  await tick(12_000);
  expect(action).toHaveBeenCalledTimes(1);
  expect(root.textContent).not.toMatch(/Changed files|main|Snapshot warning/);

  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(action).toHaveBeenCalledTimes(2);
  await tick(6_000);
  expect(action).toHaveBeenCalledTimes(2);

  action.mockImplementation(async (name): Promise<JsonValue> =>
    name === "code/changes:branch"
      ? "main"
      : name === "code/changes:forTurn"
        ? { files: 1 }
        : { warning: "Snapshot warning", omitted: [] },
  );
  window.dispatchEvent(new Event("focus"));
  await tick();
  await tick();
  expect(action.mock.calls.filter(([name]) => name === "code/changes:branch")).toHaveLength(3);
  expect(root.querySelector('[aria-label="Branch main"]')).not.toBeNull();
  expect(root.textContent).toMatch(/Changed files/);
  expect(root.textContent).toMatch(/Snapshot warning/);
});

test("a failed snapshot notice is requested on the next mount", async () => {
  vi.useFakeTimers();
  const { replies, action, mount } = fixture("notice", 1);
  action.mockResolvedValueOnce(unavailable).mockResolvedValue({ warning: "Snapshot warning", omitted: [] });
  const first = mount(() => <Notice threadId={replies[0]!.threadId} message={replies[0]!.message} />);
  await tick();
  expect(action).toHaveBeenCalledTimes(1);
  expect(first.root.textContent).not.toContain("Snapshot warning");
  first.stop();

  const second = mount(() => <Notice threadId={replies[0]!.threadId} message={replies[0]!.message} />);
  await tick();
  expect(action).toHaveBeenCalledTimes(2);
  expect(second.root.textContent).toContain("Snapshot warning");
});

test("a failed prune is retried and a successful prune is kept", async () => {
  vi.useFakeTimers();
  const { action, mount } = fixture("prune", 0);
  action.mockResolvedValueOnce(noMachine).mockResolvedValue(null);
  const first = mount(() => <Prune />);
  await tick();
  expect(action).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(action).toHaveBeenCalledTimes(2);
  first.stop();

  mount(() => <Prune />);
  await tick();
  expect(action).toHaveBeenCalledTimes(2);
});
