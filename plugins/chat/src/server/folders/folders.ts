/// <reference types="node" />
import { action, fail, v } from "@tokamak/sdk";
import { mkdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { api } from "../_generated/api";
import { threadCreatorId } from "../_functions";

/**
 * The folder a thread works in, on its creator's computer, ready to use; null
 * on anyone else's computer. A "No folder" thread's own folder,
 * `<app data>/no-project/threads/<thread>`, is made and stored the first time
 * it is asked for. The window asks right after
 * the first Send, before announcing it; anything that works in the folder
 * (an agent's turn) asks again, so it never starts without one.
 */
export const resolve = action({
  on: "caller",
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.runQuery(api.threads.get, { threadId });
    if (!thread) throw new Error("Thread no longer exists");
    // The folder is on the creator's computer; another member's Send stays plain chat.
    if (threadCreatorId(thread) !== ctx.auth.user.id) return null;
    const folder = thread.folder;
    if (folder?.kind === "chosen") return expand(folder.path);
    if (folder?.path !== undefined) {
      await mkdir(folder.path, { recursive: true });
      return folder.path;
    }
    // Threads from before folders existed work in a folder of their own, too.
    const data = appData();
    const path = join(data ?? join(tmpdir(), "tokamak"), "no-project", "threads", folderKey(threadId));
    await mkdir(path, { recursive: true });
    // A temporary folder is not saved, so the thread gets a lasting one once the client
    // provides its data folder.
    if (data) await ctx.runMutation(api.threads.setFolder, { threadId, path });
    return path;
  },
});

/**
 * Turns a typed folder into the absolute path stored on a thread: expands `~`
 * and refuses anything that is not an existing folder on this computer.
 */
export const check = action({
  on: "caller",
  args: { path: v.string() },
  handler: async (_ctx, { path }) => {
    const full = expand(path.trim());
    if (!isAbsolute(full)) return fail("NotFullPath", {});
    const found = await stat(full).catch(() => undefined);
    if (!found?.isDirectory()) return fail("NotAFolder", { path: full });
    return full;
  },
});

function expand(path: string): string {
  if (path === "~") return home();
  if (path.startsWith("~/")) return join(home(), path.slice(2));
  return resolvePath(path);
}

function home(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

/** The client's data folder; without one (a client that did not set it) a thread's own
 *  folder is a temporary one, so Send and the agent's turn still work. */
function appData(): string | undefined {
  const path = process.env.TOKAMAK_APP_DATA_DIR;
  if (path && isAbsolute(path)) return path;
  // oxlint-disable-next-line no-console -- The Runner worker sends console output to the client's log.
  console.warn("chat: the client did not provide its data folder; using a temporary folder");
  return undefined;
}

/** A thread id ("chat/threads:k5…") as one folder name that is valid on every system. */
function folderKey(threadId: string): string {
  return threadId.slice(threadId.lastIndexOf(":") + 1).replace(/[^A-Za-z0-9_-]/g, "_");
}
