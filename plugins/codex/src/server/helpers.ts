import type { Helper } from "plugin:ai/contracts";
import { isRecord, lookup, type AppServer, type Params } from "./rpc";

const activities = {
  started: "running",
  interacted: "running",
  interrupted: "failed",
  completed: "done",
} as const;
const agents = {
  pendingInit: "running",
  running: "running",
  completed: "done",
  interrupted: "failed",
  errored: "failed",
  shutdown: "failed",
  notFound: "failed",
} as const;
const turns = { inProgress: "running", completed: "done", interrupted: "failed", failed: "failed" } as const;

export function turnHelpers(app: AppServer, sessionId: string, report: (helper: Helper) => void) {
  const known = new Set<string>();
  const displayed = new Map<string, Helper>();
  const reads = new Map<string, Promise<void>>();

  function update(id: string, changes: Partial<Omit<Helper, "id">>) {
    const old = displayed.get(id) ?? { id, name: "Codex", title: "Helper", state: "running" };
    const next = { ...old, ...changes };
    if (old.state !== "running" && next.state === "running") next.state = old.state;
    if (
      displayed.has(id) &&
      Object.keys(changes).every((key) => Object.is(next[key as keyof Helper], old[key as keyof Helper]))
    )
      return;
    displayed.set(id, next);
    report(next);
  }

  function discover(id: string, changes: Partial<Omit<Helper, "id">>) {
    if (id === sessionId) return;
    known.add(id);
    update(id, changes);
    if (reads.has(id)) return;
    // Codex 0.170 can emit a helper activity without sending thread/started for the child.
    const read = app
      .call<{ thread: Params }>("thread/read", { threadId: id, includeTurns: false }, 5_000)
      .then(
        ({ thread }) => describeThread(thread),
        () => {}, // The child can already be gone; keep the activity path as its title.
      );
    reads.set(id, read);
    void read.catch(() => {});
  }

  function describeThread(thread: Params) {
    const id = thread.id;
    if (typeof id !== "string" || id === sessionId) return;
    if (thread.parentThreadId === sessionId) {
      known.add(id);
      update(id, {
        ...named("name", thread.agentRole),
        ...named("title", thread.preview),
      });
    } else if (typeof thread.parentThreadId === "string" && known.has(thread.parentThreadId)) {
      known.add(id);
    }
  }

  function activity(item: Params, topLevel: boolean) {
    const id = item.agentThreadId;
    const state = lookup(activities, item.kind);
    if (typeof id !== "string" || !id || !state) return;
    if (topLevel) discover(id, { state, ...(!displayed.has(id) && named("title", item.agentPath)) });
    else known.add(id);
  }

  function legacy(item: Params) {
    if (!Array.isArray(item.receiverThreadIds)) return;
    const states = isRecord(item.agentsStates) ? item.agentsStates : {};
    for (const id of item.receiverThreadIds) {
      if (typeof id !== "string" || !id) continue;
      const child = states[id];
      const state = isRecord(child) ? lookup(agents, child.status) : undefined;
      discover(id, {
        ...(state && { state }),
        ...named("title", item.prompt),
        ...(isRecord(child) && named("text", child.message)),
      });
    }
  }

  return {
    has: (id: unknown) => typeof id === "string" && known.has(id),
    thread: describeThread,
    parentItem(item: Params) {
      if (item.type === "subAgentActivity") activity(item, true);
      if (item.type === "collabAgentToolCall") legacy(item);
    },
    childEvent(id: string, method: string, params: Params) {
      const item = isRecord(params.item) ? params.item : undefined;
      if (item?.type === "subAgentActivity") activity(item, false);
      if (!displayed.has(id)) return;
      if (method === "item/completed" && item?.type === "agentMessage" && item.phase !== "commentary")
        update(id, named("text", item.text));
      if (method === "turn/completed" && isRecord(params.turn)) {
        const state = lookup(turns, params.turn.status);
        if (state && state !== "running") update(id, { state });
      }
    },
    async finish(state: "done" | "failed") {
      for (const [id, helper] of displayed) if (helper.state === "running") update(id, { state });
      await Promise.all(reads.values());
    },
  };
}

function named<K extends "name" | "title" | "text">(field: K, value: unknown) {
  return typeof value === "string" && value.length > 0 ? { [field]: value } : {};
}
