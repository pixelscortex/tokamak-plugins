/// <reference types="node" />
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { CallerActionContext, Id } from "@tokamak/sdk";
import { api as chat } from "plugin:chat/server";
import {
  beforeSnapshot,
  deleteSnapshots,
  folderPath,
  folderPrefix,
  repository,
  type Repository,
} from "./git";

type Tracked = { root: string; threadId: Id<"threads">; turnId?: string; prefix?: string };
type TurnFolder = {
  folder: string;
  threadId: Id<"threads">;
  turnId: string;
  signal: CallerActionContext["signal"];
};

function key(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Where this device records its repositories; `undefined` when the client gave no data folder. */
function directory(ctx: CallerActionContext): string | undefined {
  const base = process.env.TOKAMAK_APP_DATA_DIR;
  if (!base || !isAbsolute(base)) return undefined;
  // Two servers can use the same repository. Only inspect refs recorded by this device key.
  return join(base, "code", "snapshots", key(ctx.auth.user.id, ctx.auth.device.id));
}

/**
 * Records a worktree for later cleanup and for after hooks whose folder moved.
 * Best-effort: the Git ref still works without a data folder.
 */
export async function trackSnapshots(ctx: CallerActionContext, tracked: Tracked): Promise<void> {
  try {
    await record(ctx, tracked);
  } catch (cause) {
    // oxlint-disable-next-line no-console -- The Runner worker sends console output to the client's log.
    console.warn(`code: could not record this repository for later cleanup: ${String(cause)}`);
  }
}

async function record(ctx: CallerActionContext, tracked: Tracked): Promise<void> {
  const { root, threadId } = tracked;
  const dir = directory(ctx);
  if (!dir) throw new Error("the client did not provide its data folder");
  await mkdir(dir, { recursive: true });
  const file = join(dir, key(threadId, root));
  const temporary = file + "." + crypto.randomUUID();
  await writeFile(temporary, JSON.stringify(tracked), { mode: 0o600 });
  try {
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Find this turn's before ref even if Git now discovers a different worktree. */
export async function findBeforeSnapshot(ctx: CallerActionContext, turn: TurnFolder) {
  const find = async (repo: Repository) => {
    const target = { ...turn, ...repo };
    const before = await beforeSnapshot(ctx, target);
    if (before) return { target, before };
  };
  const current = await repository(ctx, turn.folder, turn.signal);
  if (current) {
    const found = await find(current);
    if (found) return found;
  }
  const dir = directory(ctx);
  if (dir) {
    for (const name of await records(dir)) {
      const tracked = await readTracked(dir, name).catch(() => undefined);
      if (tracked?.threadId !== turn.threadId || tracked.turnId !== turn.turnId) continue;
      if (typeof tracked.prefix !== "string") continue;
      // A recorded before cannot silently disappear if the folder or worktree was removed.
      await realpath(folderPath(turn.folder));
      const root = await repository(ctx, tracked.root, turn.signal);
      if (root?.root === tracked.root) {
        const found = await find({ root: tracked.root, prefix: tracked.prefix });
        if (found) return found;
      }
      throw new Error("The original snapshot worktree is no longer available");
    }
  }

  // No data folder (or an older record): enclosing worktrees can still hold the ref.
  const path = await realpath(folderPath(turn.folder));
  for (let root = dirname(path); root !== dirname(root); root = dirname(root)) {
    if (root === current?.root || !(await lstat(join(root, ".git")).catch(() => undefined))) continue;
    if ((await repository(ctx, root, turn.signal))?.root !== root) continue;
    const found = await find({ root, prefix: folderPrefix(root, path) });
    if (found) return found;
  }
}

async function records(dir: string) {
  return (
    await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })
  ).filter((name) => /^[a-f\d]{64}$/.test(name));
}

async function readTracked(dir: string, name: string): Promise<Tracked | undefined> {
  const tracked: Tracked = JSON.parse(await readFile(join(dir, name), "utf8"));
  if (name === key(tracked.threadId, tracked.root) && isAbsolute(tracked.root)) return tracked;
}

export async function pruneSnapshots(ctx: CallerActionContext): Promise<void> {
  const dir = directory(ctx);
  if (!dir) return; // Nothing was recorded without a data folder.
  for (const name of await records(dir)) {
    try {
      const tracked = await readTracked(dir, name);
      if (!tracked) continue;
      if (await ctx.runQuery(chat.getThread, { threadId: tracked.threadId })) continue;
      await deleteSnapshots(ctx, tracked);
      await unlink(join(dir, name));
    } catch {
      // An unavailable drive, server, or repository can be checked the next time the client starts.
    }
  }
}
