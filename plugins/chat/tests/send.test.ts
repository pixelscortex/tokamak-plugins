import { createRoot, flush } from "solid-js";
import { expect, test } from "vitest";
import { TokamakClient, type ClientTransport, type Id, type JsonValue } from "@tokamak/sdk";
import { onSent, type Sent } from "../src/client/api";
import { createSend } from "../src/client/lib/send";
import { draftOf, error, setDraft } from "../src/client/lib/state";

const threadId = "chat/threads:t1" as Id<"threads">;
const messageId = "chat/messages:m1" as Id<"messages">;

/** A window's client: the server stores the message; a caller action makes the folder (or fails). */
function client(folder: (() => Promise<JsonValue>) | undefined, log: string[]) {
  const transport = {
    mutation: async () => {
      log.push("stored");
      return null;
    },
    action: async (name: string) => {
      log.push(name);
      return folder ? folder() : { failed: true, kind: "noMachine", data: null };
    },
  } as unknown as ClientTransport;
  return new TokamakClient(transport);
}

async function sendOnce(folder: (() => Promise<JsonValue>) | undefined) {
  const log: string[] = [];
  const seen: Sent[] = [];
  const stop = onSent((sent) => {
    log.push("announced");
    seen.push(sent);
  });
  setDraft("draft", "  Add a CSV export ");
  flush();
  const c = client(folder, log);
  // The Send runs from an event handler in the app, outside any component scope.
  const { send, dispose } = createRoot((dispose) => ({
    dispose,
    ...createSend(c, {
      draftKey: () => "draft",
      store: async () => {
        await c.mutation({} as never, {} as never);
        return { threadId, messageId, first: true };
      },
    }),
  }));
  try {
    await send();
    flush();
    dispose();
  } finally {
    stop();
  }
  return { log, seen };
}

test("a Send is announced once stored and once its folder exists on this computer", async () => {
  const { log, seen } = await sendOnce(async () => "/home/sam/invoices-app");
  expect(log).toEqual(["stored", "chat/folders:resolve", "announced"]);
  expect(seen).toEqual([
    { threadId, messageId, text: "Add a CSV export", folder: "/home/sam/invoices-app", first: true },
  ]);
  expect(draftOf("draft")).toBe("");
});

test("a Send whose folder cannot be made is kept but never announced", async () => {
  const { log, seen } = await sendOnce(async () => {
    throw new Error("disk full");
  });
  expect(log).toEqual(["stored", "chat/folders:resolve"]);
  expect(seen).toEqual([]);
  expect(draftOf("draft")).toBe("");
  expect(error()).toBe("Couldn't make this thread's folder: disk full");
});

test("in a window without a Runner a Send is announced with no folder", async () => {
  const { log, seen } = await sendOnce(undefined);
  expect(log).toEqual(["stored", "chat/folders:resolve", "announced"]);
  expect(seen[0]?.folder).toBeUndefined();
});
