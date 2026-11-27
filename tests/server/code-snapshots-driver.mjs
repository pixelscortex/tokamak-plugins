import { testModules, testWindowConfig } from "../support/paths.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editBundle } from "../support/routing.mjs";
import {
  cancelledCleanup,
  managerCrash,
  reloadManager,
  reloadManagerTimeout,
  windowOwnership,
  separateProcesses,
  stopDuringAfter,
  stopIsolation,
  unavailableProviders,
} from "./code-snapshot-process-cases.mjs";
import { snapshotReviewCases } from "./code-snapshot-review-cases.mjs";
import { agentHarness, build, copySource, within, workspace } from "../fake-agent/harness.mjs";

const h = await agentHarness({ binary: process.argv[2], name: "code-snapshots" });
const { ai, chat } = h.api;
const source = join(workspace, "plugins/code");
const threadRef = (id) => `refs/tokamak/threads/${id.split(":")[1]}`;
const turnRef = (threadId, turnId) => `${threadRef(threadId)}/turns/${turnId.split(":")[1]}`;

try {
  build(source);
  await cp(join(source, "dist"), join(h.plugins, "code"), { recursive: true });
  const { api: code } = await import(join(source, "src/server/_generated/api.ts"));
  await installThirdPartyHook();
  const address = await h.serve("snapshots");
  const runner = h.runner(address);
  assert.ok(runner, "Code process tests require the Runner");
  const desk = await h.connect(address, { local: true });
  await preservesWorktree(desk, code);
  await snapshotFailures(desk, code);
  await changedWorktree(desk);
  await prunesWhenReopened(address, desk, code);
  await withoutDataFolder();
  const fixture = { h, runner, desk, code, project, start, refs, turnRef };
  await stopDuringAfter(fixture);
  await separateProcesses(fixture);
  await unavailableProviders(fixture);
  await thirdPartyNotice(desk);
  await cancelledCleanup(fixture);
  await windowOwnership(fixture);
  await reloadManager(fixture);
  await reloadManagerTimeout(fixture);
  await snapshotReviewCases({
    ...fixture,
    gate: h.gate,
    removeThread: (threadId) => desk.action(chat.threads.removeLocal, { threadId }),
    stopIsolation: () => stopIsolation(fixture),
  });
  await gitAppearsMidTurn(desk);
  await stoppedTurn(desk);
  await withoutAi(code);
  await managerCrash(fixture);
  console.log(
    "code snapshots: refs, parent chain, unchanged user Git state, clean filters, ignored files, folder scope, merge conflicts, disabled Git hooks, hook deadlines, deletion, Git added mid-thread, standalone code",
  );
} finally {
  await h.close();
}

async function changedWorktree(desk) {
  const outer = await project("before-worktree-root");
  const folder = join(outer.folder, "subfolder");
  await mkdir(folder);
  await writeFile(join(folder, "agent.txt"), "before nested init\n");
  outer.git("add", "subfolder");
  outer.git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Track subfolder",
  );
  const nested = await start(desk, folder);
  const running = nested.run(nested.messageId, "edit");
  await nested.edited();
  gitAt(folder)("init", "--quiet");
  await h.gate(folder, "go");
  const result = await running;
  const prefix = turnRef(nested.threadId, result.turnId);
  assert.equal(result.state, "done");
  assert.equal(result.hookNotice, undefined);
  assert.equal(outer.git("rev-parse", `${prefix}/after^`), outer.git("rev-parse", `${prefix}/before`));
  assert.deepEqual(refs(gitAt(folder)), []);

  const moved = await project("before-folder-vanished");
  const thread = await start(desk, moved.folder);
  const ending = thread.run(thread.messageId, "edit");
  await thread.edited();
  const other = moved.folder + "-moved";
  await rename(moved.folder, other);
  await h.gate(other, "go");
  const lost = await ending;
  assert.equal(lost.state, "done");
  assert.equal(lost.hookNotice, "Couldn't save this turn's code");
  assert.deepEqual(refs(gitAt(other), turnRef(thread.threadId, lost.turnId)), [
    `${turnRef(thread.threadId, lost.turnId)}/before`,
  ]);
}

async function installThirdPartyHook() {
  const folder = join(h.scratch, "sources", "other-hook");
  await mkdir(join(folder, "src/server"), { recursive: true });
  await symlink(testModules, join(folder, "node_modules"), "dir");
  await writeFile(join(folder, "package.json"), '{"name":"other-hook","version":"1.0.0","type":"module"}');
  await writeFile(
    join(folder, "plugin.ts"),
    `
import { definePlugin } from "@tokamak/sdk";
export default definePlugin({ id: "other-hook", version: "1.0.0", depends: ["ai"] });
`,
  );
  await writeFile(
    join(folder, "src/server/hook.ts"),
    `
import { action, provide } from "@tokamak/sdk";
import { turnHooks, type TurnInfo } from "plugin:ai/contracts";
export const hooks = provide(turnHooks, {
  before: action({ on: "caller", handler: async (ctx, turn: TurnInfo) => {
    if (turn.signal !== ctx.signal || turn.signal.aborted) throw new Error("Missing provider signal");
    return 1 as never; // Non-object hook results have always been ignored.
  } }),
  after: action({ on: "caller", handler: async (_ctx, turn: TurnInfo) => {
    if (turn.folder.endsWith("/third-party-after")) throw new Error("The example hook could not update its report");
  } }),
});
`,
  );
  build(folder);
  await cp(join(folder, "dist"), join(h.plugins, "other-hook"), { recursive: true });
}

async function thirdPartyNotice(desk) {
  const { folder, git } = await project("third-party-after");
  const thread = await start(desk, folder);
  await h.gate(folder, "go");
  const result = await thread.run(thread.messageId, "edit");
  assert.deepEqual(result, {
    turnId: result.turnId,
    state: "done",
    hookNotice: "The example hook could not update its report",
  });
  assert.equal(refs(git, turnRef(thread.threadId, result.turnId)).length, 2);
  console.log("code snapshots: third-party after error is shown verbatim and leaves the outcome alone");
}

function gitAt(folder) {
  const env = {
    ...process.env,
    HOME: h.home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(h.home, ".gitconfig"),
  };
  return (...args) => execFileSync("git", args, { cwd: folder, env }).toString().trimEnd();
}

async function project(name) {
  const folder = await h.folder(name);
  const git = gitAt(folder);
  const write = (file, content) => writeFile(join(folder, file), content);
  git("init", "--quiet");
  await write("agent.txt", "from HEAD\n");
  await write("staged.txt", "from HEAD\n");
  await write(".gitignore", "go\n.env\nnode_modules/\ndist/\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Initial");
  return { folder, git, write };
}

async function start(desk, folder, text = "Make an edit") {
  const sent = await desk.mutation(chat.threads.start, { text, folder: { kind: "chosen", path: folder } });
  const { threadId } = sent;
  const run = (messageId, model, timeout) =>
    within(
      desk.action(ai.run.turn, { threadId, messageId, folder, agentId: "fake-agent", model }),
      model,
      timeout,
    );
  const post = (text = "Next") => desk.mutation(chat.messages.post, { threadId, text });
  const messages = h.watch(desk, chat.messages.list, { threadId });
  const turns = h.watch(desk, ai.turns.list, { threadId });
  const reply = async (turnId) =>
    (await desk.query(ai.turns.list, { threadId })).find((row) => row._id === turnId);
  const edited = () =>
    messages.until("agent edited the file", (rows) =>
      rows.some((row) => row.parts.some((part) => part.text === "I edited agent.txt.")),
    );
  return { ...sent, run, post, reply, edited, turns };
}

function refs(git, root = "refs/tokamak/threads") {
  return git("for-each-ref", "--format=%(refname)", root).split("\n").filter(Boolean);
}

async function readState({ folder, git }, large) {
  const branch = git("symbolic-ref", "HEAD");
  const sharedIndexes = (await readdir(join(folder, ".git"))).filter((name) =>
    name.startsWith("sharedindex."),
  );
  const paths = [
    ".git/HEAD",
    `.git/${branch}`,
    ".git/index",
    ".git/refs/stash",
    ".git/logs/refs/stash",
    ...sharedIndexes.map((name) => `.git/${name}`),
    ".gitignore",
    ".env",
    "staged.txt",
    "untracked.txt",
    large,
    "node_modules/junk",
    "dist/junk",
    "go",
  ];
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => {
        const content = await readFile(join(folder, path));
        return [path, new Bun.CryptoHasher("sha256").update(content).digest("hex")];
      }),
    ),
  );
}

async function preservesWorktree(desk, code) {
  const { folder, git, write } = await project("worktree");
  git("config", "core.splitIndex", "true");
  await write("staged.txt", "in the stash\n");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "stash",
    "push",
    "--quiet",
    "-m",
    "My stash",
  );
  await write("staged.txt", "staged by the person\n");
  git("add", "staged.txt");
  await write("staged.txt", "unstaged edit\n");
  await write("agent.txt", "edited by the person\n");
  const large = "large [draft] é.bin";
  await write(large, "");
  await truncate(join(folder, large), 50_000_001);
  await write(".env", "secret\n");
  // The real index can even stage this ignored file, without leaking it to the temporary index.
  git("add", "--force", ".env");
  for (const directory of ["node_modules", "dist"]) {
    await mkdir(join(folder, directory));
    await write(`${directory}/junk`, "ignored output\n");
  }
  await write("untracked.txt", "include me\n");
  await h.gate(folder, "go");
  const before = await readState({ folder, git }, large);
  const thread = await start(desk, folder);
  const { threadId } = thread;
  const { turnId, state } = await thread.run(thread.messageId, "edit");
  assert.equal(state, "done");
  assert.equal(await readFile(join(folder, "agent.txt"), "utf8"), "written by the agent\n");
  assert.deepEqual(
    await readState({ folder, git }, large),
    before,
    "snapshotting leaves the person's files, branch, index and stash byte-for-byte unchanged",
  );

  const prefix = turnRef(threadId, turnId);
  assert.deepEqual(refs(git, threadRef(threadId)), [`${prefix}/after`, `${prefix}/before`]);
  assert.equal(git("show", `${prefix}/before:agent.txt`), "edited by the person");
  assert.equal(git("show", `${prefix}/after:agent.txt`), "written by the agent");
  assert.equal(git("diff", "--name-only", `${prefix}/before`, `${prefix}/after`), "agent.txt");
  assert.equal(git("show", `${prefix}/before:staged.txt`), "unstaged edit");
  assert.equal(git("rev-parse", `${prefix}/before^`), git("rev-parse", "HEAD"));
  assert.equal(git("rev-parse", `${prefix}/after^`), git("rev-parse", `${prefix}/before`));
  const tracked = ".gitignore\nagent.txt\nstaged.txt\nuntracked.txt";
  for (const phase of ["before", "after"]) {
    assert.equal(git("ls-tree", "-r", "--name-only", `${prefix}/${phase}`), tracked);
  }
  assert.deepEqual(await desk.action(code.notices.forTurn, { threadId, turnId }), {
    omitted: [large],
    warning: null,
  });
  assert.equal(
    (await desk.query(ai.turns.list, { threadId })).some((row) => JSON.stringify(row).includes(large)),
    false,
  );

  const failed = await thread.run(await thread.post(), "edit-fail");
  assert.equal(failed.state, "failed");
  assert.equal((await thread.reply(failed.turnId)).error, "rate limited");
  const failedPrefix = turnRef(threadId, failed.turnId);
  assert.equal(git("rev-parse", `${failedPrefix}/before^`), git("rev-parse", `${prefix}/after`));
  assert.equal(git("show", `${failedPrefix}/after:agent.txt`), "partial change");

  const other = await start(desk, folder, "Keep this thread");
  await other.run(other.messageId, "edit");
  assert.equal(refs(git, threadRef(other.threadId)).length, 2);
  await desk.action(chat.threads.removeLocal, { threadId });
  assert.equal(await desk.query(chat.threads.get, { threadId }), null);
  assert.deepEqual(
    refs(git),
    refs(git, threadRef(other.threadId)),
    "only the deleted thread's refs disappear",
  );
}

async function snapshotFailures(desk, code) {
  const { folder, git } = await project("write-failures");
  const thread = await start(desk, folder);
  const { threadId } = thread;
  const blocked = join(folder, ".git/refs/tokamak");
  await writeFile(blocked, "block the ref namespace");
  const before = await thread.run(thread.messageId, "edit-fail");
  assert.equal(before.state, "failed");
  assert.match(before.hookNotice, /Couldn't save the code before this turn.*update-ref failed/);
  assert.equal((await thread.reply(before.turnId)).error, before.hookNotice);
  assert.equal(await readFile(join(folder, "agent.txt"), "utf8"), "from HEAD\n", "the agent never started");
  await unlink(blocked);

  const running = thread.run(await thread.post(), "edit");
  await thread.edited();
  const [, current] = await thread.turns.until("second turn", (rows) => rows.length === 2);
  const prefix = turnRef(threadId, current._id);
  const lock = join(folder, ".git", `${prefix}/after.lock`);
  await writeFile(lock, "");
  await h.gate(folder, "go");
  assert.deepEqual(await running, {
    turnId: current._id,
    state: "done",
    hookNotice: "Couldn't save this turn's code",
  });
  assert.equal((await thread.reply(current._id)).state, "done");
  assert.deepEqual(refs(git, prefix), [`${prefix}/before`]);
  assert.deepEqual(await desk.action(code.notices.forTurn, { threadId, turnId: current._id }), {
    omitted: [],
    warning: "Couldn't save this turn's code",
  });
  await unlink(lock);
}

async function gitAppearsMidTurn(desk) {
  // A folder under the checkout would discover the checkout's Git repository.
  const folder = await mkdtemp(join(tmpdir(), "tokamak-without-git-"));
  try {
    const git = gitAt(folder);
    const thread = await start(desk, folder);
    const running = thread.run(thread.messageId, "edit");
    await thread.edited();
    await assert.rejects(stat(join(folder, ".git")), { code: "ENOENT" });
    git("init", "--quiet");
    await h.gate(folder, "go");
    const first = await running;
    assert.deepEqual(first, { turnId: first.turnId, state: "done" });
    assert.deepEqual(refs(git), [], "Git added during this turn takes effect from the next turn");
    const second = await thread.run(await thread.post(), "edit-fail");
    assert.equal(second.state, "failed");
    const prefix = turnRef(thread.threadId, second.turnId);
    const [commit, ...parents] = git("rev-list", "--parents", "-1", `${prefix}/before`).split(" ");
    assert.equal(commit, git("rev-parse", `${prefix}/before`));
    assert.deepEqual(parents, [], "an unborn repository starts the chain with a root snapshot");
    assert.equal(git("show", `${prefix}/after:agent.txt`), "partial change");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function stoppedTurn(desk) {
  const { folder, git } = await project("stop");
  const thread = await start(desk, folder);
  const running = thread.run(thread.messageId, "edit-stop");
  await thread.edited();
  const [turn] = await thread.turns.until("running stop fixture", (rows) => rows.length === 1);
  await desk.action(ai.run.stop, { turnId: turn._id });
  assert.equal((await running).state, "stopped");
  const saved = await thread.reply(turn._id);
  assert.equal(saved.state, "stopped");
  assert.equal(saved.sessionId, "replay-edit-stop-session");
  assert.equal(git("show", `${turnRef(thread.threadId, turn._id)}/after:agent.txt`), "edit before stop");
  console.log("code snapshots: stopped turns keep the after snapshot");
}

async function withoutAi(code) {
  const isolated = join(h.scratch, "standalone-sources");
  const codeSource = join(isolated, "code");
  await copySource(
    join(workspace, "plugins/chat"),
    join(isolated, "chat"),
    testModules,
  );
  await copySource(source, codeSource, testModules);
  await writeFile(
    join(codeSource, "src/client/tsconfig.json"),
    JSON.stringify({ extends: testWindowConfig }),
  );
  build(codeSource);
  const only = join(h.scratch, "without-ai");
  await cp(join(h.plugins, "chat"), join(only, "chat"), { recursive: true });
  await cp(join(codeSource, "dist"), join(only, "code"), { recursive: true });
  const address = await h.serve("standalone", { pluginsDir: only });
  const desk = await h.connect(address, { local: true, pluginsDir: only });
  const { folder, git } = await project("without-ai");
  const { threadId } = await desk.mutation(chat.threads.start, {
    text: "Plain chat",
    folder: { kind: "chosen", path: folder },
  });
  assert.equal(await desk.action(code.notices.forTurn, { threadId, turnId: "older" }), null);
  const fromEarlier = `${threadRef(threadId)}/turns/older/after`;
  git("update-ref", fromEarlier, "HEAD");
  assert.deepEqual(refs(git), [fromEarlier]);
  await desk.action(chat.threads.removeLocal, { threadId });
  assert.deepEqual(refs(git), [], "code cleans up older snapshots even while ai is uninstalled");
}

async function prunesWhenReopened(address, desk, code) {
  const { folder, git } = await project("prune-on-open");
  await h.gate(folder, "go");
  const deleted = await start(desk, folder);
  const kept = await start(desk, folder, "Keep these snapshots");
  await deleted.run(deleted.messageId, "edit");
  await kept.run(kept.messageId, "edit");
  const branch = git("symbolic-ref", "HEAD");
  const branchHead = git("rev-parse", branch);
  const browser = await h.connect(address);
  await browser.mutation(chat.threads.remove, { threadId: deleted.threadId });
  assert.equal(refs(git, threadRef(deleted.threadId)).length, 2);

  const reopened = await h.connect(address, { local: true });
  await reopened.action(code.hooks.prune, {});
  assert.deepEqual(refs(git), refs(git, threadRef(kept.threadId)));
  assert.equal(refs(git).length, 2);
  assert.equal(git("rev-parse", branch), branchHead);
}

async function withoutDataFolder() {
  // A client that gives no data folder still runs turns: the record for later cleanup is skipped.
  const plugins = join(h.scratch, "without-data-folder-plugins");
  await cp(h.plugins, plugins, { recursive: true });
  for (const id of ["chat", "code"]) {
    const plugin = join(plugins, id);
    await editBundle(plugin, "delete process.env.TOKAMAK_APP_DATA_DIR;");
  }
  // Use the actual Runner against that installed build. A manifest for each
  // changed local bundle must also be served by the workspace it connects to.
  const desk = await h.connect(await h.serve("without-data-folder", { pluginsDir: plugins }), {
    local: true,
  });
  const { folder, git } = await project("without-data-folder");
  await h.gate(folder, "go");
  const thread = await start(desk, folder);
  const done = await thread.run(thread.messageId, "edit");
  assert.equal(done.state, "done");
  const prefix = turnRef(thread.threadId, done.turnId);
  assert.deepEqual(refs(git, prefix), [`${prefix}/after`, `${prefix}/before`]);

  const loose = await desk.mutation(chat.threads.start, { text: "No folder", folder: { kind: "own" } });
  const own = await desk.action(chat.folders.resolve, { threadId: loose.threadId });
  assert.ok((await stat(own)).isDirectory(), "the thread still gets a folder of its own");
  await rm(own, { recursive: true, force: true });
  assert.equal((await desk.query(chat.threads.get, { threadId: loose.threadId })).folder.path, undefined);
  console.log("code snapshots: a client without a data folder still saves snapshots");
}
