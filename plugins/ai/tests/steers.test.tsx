import { screen } from "@testing-library/dom";
import { render } from "@solidjs/web";
import { afterEach, expect, test } from "vitest";
import { TokamakClient, type ClientTransport, type JsonValue } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import type { MessageProps } from "plugin:chat/client";
import { usageLine, type Turn } from "../src/client/lib/replies";
import { steeredBody } from "../src/client/lib/steers";
import { ReplyCards } from "../src/client/ui/reply-cards";
import { SteeredBody } from "../src/client/ui/turn-steers";

// A steer is drawn where the reply's text stood when it was sent, as the
// person's own message; the reply's usage line says nothing when it has no tokens.

test("a steer splits the reply at its offset, trimming the blank line around it", () => {
  const text = "Looking at the tests.\n\nNow the cache instead.";
  const at = "Looking at the tests.".length;
  expect(steeredBody(text, { steers: ["Check the cache"], steerOffsets: [at] })).toEqual([
    { kind: "text", text: "Looking at the tests." },
    { kind: "steer", text: "Check the cache", pending: false },
    { kind: "text", text: "Now the cache instead." },
  ]);
});

test("steers without offsets (rows from before them) follow the whole text", () => {
  expect(steeredBody("One. Two.", { steers: ["a", "b"] })).toEqual([
    { kind: "text", text: "One. Two." },
    { kind: "steer", text: "a", pending: false },
    { kind: "steer", text: "b", pending: false },
  ]);
});

test("a pending steer shows at the end of the text so far", () => {
  expect(steeredBody("Working ", { steers: ["a"], steerOffsets: [0], pendingSteer: "b" })).toEqual([
    { kind: "steer", text: "a", pending: false },
    { kind: "text", text: "Working" },
    { kind: "steer", text: "b", pending: true },
  ]);
});

test("a steer sent inside a code fence moves after the fence", () => {
  const text = "Here:\n```ts\nconst a = 1;\nconst b = 2;\n```\nDone.";
  const inside = text.indexOf("const b");
  expect(steeredBody(text, { steers: ["stop"], steerOffsets: [inside] })).toEqual([
    { kind: "text", text: "Here:\n```ts\nconst a = 1;\nconst b = 2;\n```" },
    { kind: "steer", text: "stop", pending: false },
    { kind: "text", text: "Done." },
  ]);
  // A fence still open when the steer came: the steer waits for the end of the text.
  const open = "```\nlet x;";
  expect(steeredBody(open, { steers: ["stop"], steerOffsets: [open.length - 2] })).toEqual([
    { kind: "text", text: open },
    { kind: "steer", text: "stop", pending: false },
  ]);
});

test("the usage line is left out when the agent counted no tokens", () => {
  expect(usageLine({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  expect(usageLine({ inputTokens: 0, outputTokens: 0, costUsd: 0 })).toBeUndefined();
  expect(usageLine({ inputTokens: 12_400, outputTokens: 1_100, costUsd: 0.04 })).toBe(
    "12.4k in · 1.1k out · $0.04",
  );
  expect(usageLine({ inputTokens: 5, outputTokens: 0 })).toBe("5 in · 0 out");
});

// Drawn: the reply with a stand-in client whose `turns:replies` answers `turn`.

let turn: Partial<Turn> = {};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function client(): TokamakClient {
  const transport = {
    action: async () => null,
    subscribe: (name: string, _args: JsonValue, onEvent: (event: { value: JsonValue }) => void) => {
      if (name !== "ai/turns:replies") throw new Error(`Unexpected query ${name}`);
      queueMicrotask(() => onEvent({ value: [{ helpers: [], ...turn, replyId: "r1" }] as JsonValue }));
      return () => {};
    },
  } as unknown as ClientTransport;
  return new TokamakClient(transport);
}

function mount(part: (props: MessageProps) => unknown, text: string) {
  const props = {
    threadId: "t1",
    message: {
      _id: "r1",
      role: "assistant",
      author: { id: "agent:fake", name: "Fake" },
      parts: [{ type: "text", text }],
    },
    next: undefined,
    isLast: true,
  } as unknown as MessageProps;
  const root = document.createElement("div");
  document.body.append(root);
  const Part = part as (props: MessageProps) => never;
  const dispose = render(
    () => (
      <ClientContext value={client()}>
        <Part {...props} />
      </ClientContext>
    ),
    root,
  );
  cleanups.push(() => {
    dispose();
    root.remove();
  });
  return root;
}

test("the steer is drawn between the text before and after it, as the person's message", async () => {
  const before = "Looking at the tests.";
  turn = {
    sender: { id: "u", name: "Sam", device: "d" },
    steers: ["Check the cache"],
    steerOffsets: [before.length],
  };
  const root = mount(SteeredBody, `${before}\n\nNow the cache instead.`);
  const steer = await screen.findByRole("group", { name: "Steer from Sam" });
  expect(steer.textContent).toBe("SteerSSamCheck the cache");
  const pieces = [...root.querySelector("[data-part=body]")!.children].map((node) => node.textContent);
  expect(pieces).toEqual([before, "SteerSSamCheck the cache", "Now the cache instead."]);
});

test("the usage line shows real counts and is gone at 0 in and 0 out", async () => {
  turn = { usage: { inputTokens: 0, outputTokens: 0 } };
  const empty = mount(ReplyCards, "Stopped early");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(empty.querySelector("[aria-label=Usage]")).toBeNull();
  for (const cleanup of cleanups.splice(0)) cleanup();

  turn = { usage: { inputTokens: 12_400, outputTokens: 1_100, costUsd: 0.04 } };
  mount(ReplyCards, "Done");
  expect((await screen.findByLabelText("Usage")).textContent).toBe("12.4k in · 1.1k out · $0.04");
});
