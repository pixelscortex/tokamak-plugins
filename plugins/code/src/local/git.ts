/// <reference types="node" />
import { cp, lstat, mkdtemp, realpath, rm, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { CallerActionContext, Id } from "@tokamak/sdk";

export type Repository = { root: string; prefix: string };
type TurnSnapshot = { root: string; threadId: Id<"threads">; turnId: string };
const repositoryEnv =
  /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CONFIG.*)$/i;

export function threadRefs(threadId: string): string {
  return `refs/tokamak/threads/${key(threadId)}`;
}

export function turnRefs(threadId: string, turnId: string): string {
  return `${threadRefs(threadId)}/turns/${key(turnId)}`;
}

// Tokamak ids contain a table and a colon, neither of which Git needs.
function key(id: string): string {
  const key = id.slice(id.lastIndexOf(":") + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error("Invalid snapshot id");
  return key;
}

async function lines(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of stream) out.push(line);
  return out;
}

function startGit(
  ctx: CallerActionContext,
  cwd: string,
  args: string[],
  override: Record<string, string> = {},
  finishOnCancel = false,
) {
  // A surrounding Git session must not redirect us to another repository or index.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => !repositoryEnv.test(entry[0]) && entry[1] !== undefined,
    ),
  );
  return ctx.proc(
    [
      "git",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.splitIndex=false",
      "-c",
      "core.quotePath=true",
      // User config may permit an indefinite wait for another Git writer.
      ...(finishOnCancel ? ["-c", "core.filesRefLockTimeout=100", "-c", "core.packedRefsTimeout=1000"] : []),
      ...args,
    ],
    { cwd, env: { ...env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", ...override }, finishOnCancel },
  );
}

function gitAt(
  ctx: CallerActionContext,
  cwd: string,
  override: Record<string, string> = {},
  signal = ctx.signal,
) {
  return async (args: string[], input?: string) => {
    if (signal.aborted) throw new Error("Snapshot cancelled");
    // An interrupted ref transaction can leave a lock in the user's repository.
    const writesRefs = args[0] === "update-ref";
    const program = startGit(ctx, cwd, args, override, writesRefs);
    const stop = () => program.stop("SIGKILL");
    if (!writesRefs) signal.addEventListener("abort", stop, { once: true });
    try {
      if (input !== undefined) program.write(input);
      program.closeInput();
      const [out, err, code] = await Promise.all([
        lines(program.stdout),
        lines(program.stderr),
        program.exited,
      ]);
      return { out, err, code };
    } finally {
      signal.removeEventListener("abort", stop);
    }
  };
}

/** Runs a read-only Git command in `root` and resolves its output lines; fails on a non-zero exit. */
export async function readGit(ctx: CallerActionContext, root: string, args: string[]): Promise<string[]> {
  return checked(gitAt(ctx, root), args);
}

/**
 * Hands each output line of a read-only Git command in `root` to `take` until
 * it returns false, then stops Git: a huge diff is never read whole. Resolves
 * false when Git was stopped early.
 */
export async function readGitUntil(
  ctx: CallerActionContext,
  root: string,
  args: string[],
  take: (line: string) => boolean,
): Promise<boolean> {
  const program = startGit(ctx, root, args);
  program.closeInput();
  const errors = lines(program.stderr);
  let complete = true;
  for await (const line of program.stdout) {
    if (!take(line)) {
      complete = false;
      program.stop("SIGKILL");
      break;
    }
  }
  const code = await program.exited;
  const err = await errors;
  if (complete && code !== 0) throw new Error(`Git could not ${args[0]}: ${err.join("\n")}`);
  return complete;
}

type Git = ReturnType<typeof gitAt>;

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

async function checked(git: Git, args: string[], stdin?: string): Promise<string[]> {
  const result = await git(args, stdin);
  if (result.code !== 0) throw new Error(`Git could not ${args[0]}: ${result.err.join("\n")}`);
  return result.out;
}

/** Finds the worktree and the selected folder's path within it. Plain folders have no worktree. */
export async function repository(
  ctx: CallerActionContext,
  folder: string,
  signal = ctx.signal,
): Promise<Repository | undefined> {
  const path = folderPath(folder);
  try {
    const result = await gitAt(ctx, path, {}, signal)(["rev-parse", "--show-toplevel"]);
    if (result.code === 0) {
      const root = result.out.join("\n");
      const prefix = folderPrefix(root, await realpath(path));
      return { root, prefix };
    }
    // The local process runner invokes Git through a shell on Unix; a missing
    // executable exits 127 instead of throwing ENOENT as it does on Windows.
    if (result.code === 127 && result.err.some((line) => line.endsWith("git: not found"))) return;
    if (result.err.some((line) => /not a git repository|must be run in a work tree/.test(line))) return;
    throw new Error(`Git could not read the repository: ${result.err.join("\n")}`);
  } catch (cause) {
    if (isMissing(cause)) return;
    throw cause;
  }
}

export function folderPath(folder: string): string {
  return folder === "~"
    ? homedir()
    : folder.startsWith("~/")
      ? join(homedir(), folder.slice(2))
      : resolve(folder);
}

export function folderPrefix(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

const MAX_NEW_FILE_BYTES = 50_000_000;
const gitEscapes: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
};

function decodeGitPath(path: string) {
  if (!path.startsWith('"')) return Buffer.from(path);
  return Buffer.from(
    path
      .slice(1, -1)
      .replace(/\\([0-7]{3}|.)/g, (_, code: string) =>
        code.length === 3 ? String.fromCharCode(parseInt(code, 8)) : gitEscapes[code]!,
      ),
    "latin1",
  );
}

async function oversized(git: Git, root: string, pathsInScope: string[]) {
  // The process API is line based. Git's quoted paths preserve embedded
  // newlines and non-ASCII bytes, and Git accepts the same quoting on stdin.
  const paths = await checked(git, ["ls-files", "--others", "--exclude-standard", ...pathsInScope]);
  const parent = Buffer.from(root.endsWith(sep) ? root : root + sep);
  const excluded: { pathspec: string; name: string }[] = [];
  for (const path of paths) {
    const bytes = decodeGitPath(path);
    const file = await lstat(Buffer.concat([parent, bytes])).catch((cause: unknown) => {
      if (!isMissing(cause)) throw cause;
    });
    if (!file?.isFile() || file.size <= MAX_NEW_FILE_BYTES) continue;
    const magic = ":(exclude,literal)";
    const pathspec = path.startsWith('"') ? `"${magic}${path.slice(1)}` : magic + path;
    excluded.push({ pathspec, name: bytes.toString() });
  }
  return excluded;
}

function quotePathspec(pathspec: string): string {
  const escapes: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\r": "\\r", "\n": "\\n" };
  return `"${pathspec.replace(/[\\"\r\n]/g, (char) => escapes[char]!)}"`;
}

async function stageFiles(git: Git, { root, prefix }: Repository) {
  const pathspec = prefix ? `:(top,literal)${prefix}/` : undefined;
  const pathsInScope = pathspec ? ["--", pathspec] : [];
  if (prefix) {
    // --no-index still checks the directory rule when it contains tracked files.
    const ignore = await git(["check-ignore", "--no-index", "-q", "--", `./${prefix}/`]);
    if (ignore.code === 0) {
      const tracked = await checked(git, ["ls-files", ...pathsInScope]);
      if (tracked.length) await checked(git, ["add", "-u", ...pathsInScope]);
      return [];
    }
    if (ignore.code !== 1) throw new Error(`Git could not check-ignore: ${ignore.err.join("\n")}`);
  }
  const excluded = await oversized(git, root, pathsInScope);
  if (!excluded.length) {
    await checked(git, ["add", "-A", ...pathsInScope]);
  } else {
    const pathspecs = excluded.map((file) => file.pathspec);
    if (pathspec) pathspecs.unshift(quotePathspec(pathspec));
    await checked(git, ["add", "-A", "--pathspec-from-file=-"], pathspecs.join("\n") + "\n");
  }
  return excluded.map((file) => file.name);
}

async function seedIndex(repoGit: Git, git: Git, root: string, index: string, hasHead: boolean) {
  if (!hasHead) {
    await checked(git, ["read-tree", "--empty"]);
    return;
  }
  const indexPath = (await checked(repoGit, ["rev-parse", "--git-path", "index"])).join("\n");
  const copied = await cp(resolve(root, indexPath), index, { preserveTimestamps: true }).then(
    () => true,
    (cause: unknown) => {
      if (isMissing(cause)) return false;
      throw cause;
    },
  );
  if (copied) {
    // Keep cached stat data for unchanged HEAD entries; drop staged additions
    // and reset staged edits. An unmerged index can refuse this operation.
    const reset = await git(["read-tree", "-m", "HEAD"]);
    if (reset.code === 0) {
      const flags = await checked(git, ["ls-files", "-v"]);
      // An index can explicitly tell Git to skip checks for individual files.
      if (!flags.some((line) => /^[a-zS] /.test(line))) return;
    }
    await unlink(index);
  }
  await checked(git, ["read-tree", "HEAD"]);
}

async function latest(git: Git, threadId: string): Promise<string | undefined> {
  const refs = await checked(git, [
    "rev-list",
    "--no-walk=unsorted",
    "--parents",
    `--glob=${threadRefs(threadId)}/turns/*`,
  ]);
  // The ids are random and commits from the same second tie on time. The tip
  // is the one snapshot that no other snapshot names as its parent.
  const commits = refs.map((line) => line.split(" "));
  const parents = new Set(commits.flatMap(([, ...parents]) => parents));
  return commits.find(([id]) => id && !parents.has(id))?.[0];
}

/**
 * Builds a commit from the selected folder through a temporary index and publishes its hidden ref.
 * After uses its own before as parent. Before continues the thread's chain, starting from HEAD
 * (or a root commit in an unborn worktree).
 */
export async function snapshot(
  ctx: CallerActionContext,
  target: TurnSnapshot & Repository & { signal: CallerActionContext["signal"] },
  phase: "before" | "after",
  before?: string,
): Promise<string> {
  const { root, threadId, turnId, signal } = target;
  const dir = await mkdtemp(join(tmpdir(), "tokamak-index-"));
  try {
    const index = join(dir, "index");
    const git = gitAt(
      ctx,
      root,
      {
        GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: "Tokamak",
        GIT_AUTHOR_EMAIL: "snapshots@tokamak.invalid",
        GIT_COMMITTER_NAME: "Tokamak",
        GIT_COMMITTER_EMAIL: "snapshots@tokamak.invalid",
      },
      signal,
    );
    const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.code !== 0 && head.code !== 1) throw new Error("Git could not read HEAD");
    await seedIndex(gitAt(ctx, root, {}, signal), git, root, index, head.code === 0);
    const excluded = await stageFiles(git, target);
    const [tree] = await checked(git, ["write-tree"]);
    const parent = before ?? (await latest(git, threadId)) ?? head.out[0];
    // Keep omitted filenames alongside the snapshot, on this computer only.
    const note = excluded.length ? `\n${JSON.stringify(excluded)}\n` : "";
    const [commit] = await checked(
      git,
      ["commit-tree", tree!, ...(parent ? ["-p", parent] : []), "--no-gpg-sign", "-F", "-"],
      `Tokamak turn ${phase}\n${note}`,
    );
    await checked(git, ["update-ref", "--no-deref", `${turnRefs(threadId, turnId)}/${phase}`, commit!]);
    return commit!;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Finds the persisted before snapshot for this exact turn, even after a restart. */
export async function beforeSnapshot(
  ctx: CallerActionContext,
  { root, threadId, turnId, signal }: TurnSnapshot & { signal: CallerActionContext["signal"] },
) {
  const result = await gitAt(
    ctx,
    root,
    {},
    signal,
  )(["rev-parse", "--verify", "--quiet", `${turnRefs(threadId, turnId)}/before`]);
  if (result.code === 1 && result.err.length === 0) return;
  if (result.code !== 0) throw new Error(`Git could not read the before snapshot: ${result.err.join("\n")}`);
  return result.out[0];
}

export const AFTER_SNAPSHOT_WARNING = "Couldn't save this turn's code";

/** Removes this thread's snapshot refs, leaving other Git refs in place. */
export async function deleteSnapshots(
  ctx: CallerActionContext,
  { root, threadId }: Omit<TurnSnapshot, "turnId">,
  signal = ctx.signal,
): Promise<void> {
  const git = gitAt(ctx, root, {}, signal);
  const prefix = `${threadRefs(threadId)}/turns/`;
  const refs = (await checked(git, ["for-each-ref", "--format=%(refname)", prefix])).filter(
    (ref) => ref.startsWith(prefix) && /^[A-Za-z0-9_-]+\/(before|after)$/.test(ref.slice(prefix.length)),
  );
  if (refs.length) {
    await checked(
      git,
      ["update-ref", "--no-deref", "--stdin"],
      refs.map((ref) => `delete ${ref}\n`).join(""),
    );
  }
}

/** Reads omitted filenames and detects a missing after ref, without storing server data. */
export async function snapshotNotice(ctx: CallerActionContext, { root, threadId, turnId }: TurnSnapshot) {
  const git = gitAt(ctx, root);
  const prefix = turnRefs(threadId, turnId);
  const messages = await checked(git, [
    "for-each-ref",
    "--format=%(refname)%00%(contents:body)",
    `${prefix}/`,
  ]);
  const omitted = new Set<string>();
  let before = false;
  let after = false;
  for (const line of messages) {
    const [ref, note] = line.split("\0");
    if (ref === `${prefix}/before`) before = true;
    else if (ref === `${prefix}/after`) after = true;
    else continue;
    if (note) for (const name of JSON.parse(note) as string[]) omitted.add(name);
  }
  return before || after
    ? { omitted: [...omitted], warning: before && !after ? AFTER_SNAPSHOT_WARNING : null }
    : null;
}
