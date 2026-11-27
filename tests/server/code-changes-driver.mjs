import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentHarness, build, within, workspace } from "../fake-agent/harness.mjs";

// What a turn changed, as `code`'s local part reads it from Git for the change
// card, the review panel and the branch chip. Expected values come from the
// `git` command line run on the same snapshot refs.
const h = await agentHarness({ binary: process.argv[2], name: "code-changes" });
const { ai, chat } = h.api;
const source = join(workspace, "plugins/code");
const turnRef = (threadId, turnId) =>
  `refs/tokamak/threads/${threadId.split(":")[1]}/turns/${turnId.split(":")[1]}`;

try {
  build(source);
  await cp(join(source, "dist"), join(h.plugins, "code"), { recursive: true });
  const { api: code } = await import(join(source, "src/server/_generated/api.ts"));
  const desk = await h.connect(await h.serve("changes"), { local: true });
  await countsAndDiffsMatchGit(desk, code);
  await quietTurnChangesNothing(desk, code);
  await folderScope(desk, code);
  await hugeDiffIsCut(desk, code);
  await changesWithoutLines(desk, code);
  await startedTracking(desk, code);
  await branchChip(desk, code);
  console.log(
    "code changes: counts and diffs match git diff, quiet turn, folder scope, line budget, started tracking, branch",
  );
} finally {
  await h.close();
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

async function project(name, files = { "agent.txt": "from HEAD\n" }) {
  const folder = await h.folder(name);
  const git = gitAt(folder);
  git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(folder, ".gitignore"), "go\n");
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(folder, file, ".."), { recursive: true });
    await writeFile(join(folder, file), content);
  }
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Initial");
  return { folder, git };
}

/** A thread in `folder` with one turn of `model`; `during` edits the folder while the agent works. */
async function turn(desk, folder, { model = "edit", during, threadId, earlier } = {}) {
  let messageId;
  if (threadId) messageId = await desk.mutation(chat.messages.post, { threadId, text: "Next" });
  else
    ({ threadId, messageId } = await desk.mutation(chat.threads.start, {
      text: "Edit",
      folder: { kind: "chosen", path: folder },
    }));
  await h.closeGate(folder, "go").catch(() => {});
  const running = within(
    desk.action(ai.run.turn, { threadId, messageId, folder, agentId: "fake-agent", model }),
    model,
  );
  if (model === "edit") {
    const messages = h.watch(desk, chat.messages.list, { threadId });
    await messages.until("the agent edited", (rows) =>
      rows.some((row) => row.parts.some((part) => part.text === "I edited agent.txt.")),
    );
  }
  await during?.();
  await h.gate(folder, "go");
  const { turnId, state } = await running;
  assert.equal(state, "done");
  return { threadId, turnId, earlier };
}

function numstat(git, threadId, turnId, ...scope) {
  const ref = turnRef(threadId, turnId);
  return git("diff", "--numstat", "--no-renames", `${ref}/before`, `${ref}/after`, ...scope)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, path] = line.split("\t");
      return { path, added, removed };
    });
}

async function countsAndDiffsMatchGit(desk, code) {
  const lines = (count, word) => Array.from({ length: count }, (_, i) => `${word} ${i + 1}\n`).join("");
  const { folder, git } = await project("counts", {
    "agent.txt": "from HEAD\n",
    "src/table.ts": lines(20, "row"),
    "gone.txt": "deleted by the turn\n",
  });
  const { threadId, turnId } = await turn(desk, folder, {
    during: async () => {
      await writeFile(
        join(folder, "src/table.ts"),
        lines(20, "row").replace("row 3\n", "row three\n").replace("row 15\n", "row 15\nrow 15b\nrow 15c\n"),
      );
      await unlink(join(folder, "gone.txt"));
      await writeFile(join(folder, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0, 3]));
      // Written by the operating system, not the agent: never part of the turn's change, in any
      // case, and "._agent.txt" only because agent.txt is beside it. "._notes.txt" has no
      // "notes.txt": it is a file like any other.
      await writeFile(join(folder, ".DS_Store"), Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31, 0]));
      await writeFile(join(folder, "THUMBS.DB"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 1]));
      await writeFile(join(folder, "._agent.txt"), Buffer.from([0, 5, 0x16, 7, 0, 2, 0, 0]));
      await writeFile(join(folder, "._notes.txt"), "kept\n");
    },
  });

  const expected = numstat(git, threadId, turnId);
  // agent.txt +1 −1 (the agent), gone.txt −1, logo.png binary, src/table.ts +3 −1, ._notes.txt +1;
  // .DS_Store, ._agent.txt and THUMBS.DB are left out.
  assert.deepEqual(expected, [
    { path: ".DS_Store", added: "-", removed: "-" },
    { path: "._agent.txt", added: "-", removed: "-" },
    { path: "._notes.txt", added: "1", removed: "0" },
    { path: "THUMBS.DB", added: "-", removed: "-" },
    { path: "agent.txt", added: "1", removed: "1" },
    { path: "gone.txt", added: "0", removed: "1" },
    { path: "logo.png", added: "-", removed: "-" },
    { path: "src/table.ts", added: "3", removed: "1" },
  ]);
  assert.deepEqual(await desk.action(code.changes.forTurn, { threadId, turnId, ranEarlier: [] }), {
    files: 5,
    added: 5,
    removed: 3,
    binary: 1,
    tracking: null,
  });

  const diff = await desk.action(code.changes.diff, { threadId, turnId });
  assert.equal(diff.cut, false);
  assert.equal(diff.added, 5);
  assert.equal(diff.removed, 3);
  assert.deepEqual(
    diff.files.map(({ path, added, removed, binary, partial, note }) => ({
      path,
      added,
      removed,
      binary,
      partial,
      note,
    })),
    [
      { path: "._notes.txt", added: 1, removed: 0, binary: false, partial: false, note: null },
      { path: "agent.txt", added: 1, removed: 1, binary: false, partial: false, note: null },
      { path: "gone.txt", added: 0, removed: 1, binary: false, partial: false, note: null },
      { path: "logo.png", added: 0, removed: 0, binary: true, partial: false, note: "Binary file" },
      { path: "src/table.ts", added: 3, removed: 1, binary: false, partial: false, note: null },
    ],
  );
  const ref = turnRef(threadId, turnId);
  for (const file of diff.files) {
    const patch = git("diff", "--no-color", `${ref}/before`, `${ref}/after`, "--", file.path).split("\n");
    const hunks = patch.slice(patch.findIndex((line) => line.startsWith("@@")));
    assert.deepEqual(file.patch, file.binary ? [] : hunks, `${file.path} matches git diff`);
  }
  assert.deepEqual(diff.files[4].patch.slice(0, 2), ["@@ -1,6 +1,6 @@", " row 1"]);
}

async function quietTurnChangesNothing(desk, code) {
  const { folder } = await project("quiet");
  const { threadId, turnId } = await turn(desk, folder, { model: "echo" });
  assert.deepEqual(await desk.action(code.changes.forTurn, { threadId, turnId, ranEarlier: [] }), {
    files: 0,
    added: 0,
    removed: 0,
    binary: 0,
    tracking: null,
  });
  assert.deepEqual((await desk.action(code.changes.diff, { threadId, turnId })).files, []);
}

async function folderScope(desk, code) {
  const { folder, git } = await project("scope", {
    "app/agent.txt": "from HEAD\n",
    "other.txt": "outside\n",
  });
  const app = join(folder, "app");
  const { threadId, turnId } = await turn(desk, app, {
    during: () => writeFile(join(folder, "other.txt"), "changed outside the thread's folder\n"),
  });
  assert.deepEqual(numstat(git, threadId, turnId, "--", "app"), [
    { path: "app/agent.txt", added: "1", removed: "1" },
  ]);
  const diff = await desk.action(code.changes.diff, { threadId, turnId });
  assert.deepEqual(
    diff.files.map((file) => file.path),
    ["agent.txt"],
    "paths are relative to the thread's folder, and nothing outside it is listed",
  );
  assert.equal((await desk.action(code.changes.forTurn, { threadId, turnId, ranEarlier: [] })).files, 1);
}

async function hugeDiffIsCut(desk, code) {
  const { folder } = await project("huge");
  const { threadId, turnId } = await turn(desk, folder, {
    during: async () => {
      await writeFile(
        join(folder, "big.txt"),
        Array.from({ length: 5000 }, (_, i) => `line ${i}\n`).join(""),
      );
      await writeFile(join(folder, "wide.txt"), `${"x".repeat(5000)}\n`);
      await writeFile(join(folder, "zz-late.txt"), "after the budget\n");
    },
  });
  const diff = await desk.action(code.changes.diff, { threadId, turnId });
  assert.equal(diff.cut, true);
  assert.deepEqual(
    diff.files.map(({ path, added }) => ({ path, added })),
    [
      { path: "agent.txt", added: 1 },
      { path: "big.txt", added: 5000 },
      { path: "wide.txt", added: 1 },
      { path: "zz-late.txt", added: 1 },
    ],
    "every file keeps its counts",
  );
  const [agent, big, wide, late] = diff.files;
  // Only hunk lines count: agent.txt's "@@", "-" and "+" lines, then big.txt up to 3,000.
  assert.deepEqual(agent.patch, ["@@ -1 +1 @@", "-from HEAD", "+written by the agent"]);
  assert.equal(agent.partial, false);
  assert.equal(big.patch.length, 2997);
  assert.deepEqual(big.patch.slice(0, 2), ["@@ -0,0 +1,5000 @@", "+line 0"]);
  assert.equal(big.partial, true, "the file cut part-way says so");
  assert.equal(wide.patch, null);
  assert.equal(wide.partial, false);
  assert.equal(late.patch, null);
  assert.equal(diff.added, 5003);
}

async function changesWithoutLines(desk, code) {
  const { folder, git } = await project("lineless", { "agent.txt": "from HEAD\n", "run.sh": "echo hi\n" });
  const { threadId, turnId } = await turn(desk, folder, {
    during: async () => {
      await chmod(join(folder, "run.sh"), 0o755);
      await writeFile(join(folder, "empty.txt"), "");
      await writeFile(join(folder, "wide.txt"), `${"y".repeat(600)}\n`);
    },
  });
  assert.deepEqual(numstat(git, threadId, turnId), [
    { path: "agent.txt", added: "1", removed: "1" },
    { path: "empty.txt", added: "0", removed: "0" },
    { path: "run.sh", added: "0", removed: "0" },
    { path: "wide.txt", added: "1", removed: "0" },
  ]);
  const diff = await desk.action(code.changes.diff, { threadId, turnId });
  const [, empty, mode, wide] = diff.files;
  assert.deepEqual([empty.note, empty.patch], ["New empty file", []]);
  assert.deepEqual([mode.note, mode.patch], ["Mode changed from 100644 to 100755", []]);
  assert.equal(wide.note, null);
  assert.deepEqual(
    wide.patch,
    ["@@ -0,0 +1 @@", `+${"y".repeat(399)}…`],
    "a long line is shown, cut at 400 characters",
  );
}

async function startedTracking(desk, code) {
  // A folder under the checkout would discover the checkout's Git repository.
  const folder = await mkdtemp(join(tmpdir(), "tokamak-changes-"));
  try {
    const git = gitAt(folder);
    const first = await turn(desk, folder, { model: "echo" });
    git("init", "--quiet");
    await writeFile(join(folder, ".gitignore"), "go\n");
    await writeFile(join(folder, "one.txt"), "1\n");
    await writeFile(join(folder, "two.txt"), "2\n");
    const second = await turn(desk, folder, { threadId: first.threadId });
    const third = await turn(desk, folder, { threadId: first.threadId });
    assert.equal(
      (
        await desk.action(code.changes.forTurn, {
          threadId: first.threadId,
          turnId: second.turnId,
          ranEarlier: [],
        })
      ).tracking,
      null,
      "without an earlier turn that ran without Git, a first snapshot is a plain card",
    );
    assert.deepEqual(
      await desk.action(code.changes.forTurn, {
        threadId: first.threadId,
        turnId: second.turnId,
        ranEarlier: [first.turnId],
      }),
      { files: 1, added: 1, removed: 0, binary: 0, tracking: 3 },
      "tracking starts with .gitignore, one.txt and two.txt; the agent then adds agent.txt",
    );
    assert.equal(
      (
        await desk.action(code.changes.forTurn, {
          threadId: first.threadId,
          turnId: third.turnId,
          ranEarlier: [first.turnId, second.turnId],
        })
      ).tracking,
      null,
      "only the first tracked turn says so",
    );
    assert.equal(
      await desk.action(code.changes.forTurn, {
        threadId: first.threadId,
        turnId: first.turnId,
        ranEarlier: [],
      }),
      null,
      "the turn before Git has nothing to show",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function branchChip(desk, code) {
  const { folder, git } = await project("branch");
  const { threadId } = await turn(desk, folder, { model: "echo" });
  assert.equal(await desk.action(code.changes.branch, { threadId }), "main");
  git("checkout", "--quiet", "-b", "feat/csv-export");
  assert.equal(await desk.action(code.changes.branch, { threadId }), "feat/csv-export");
  git("checkout", "--quiet", "--detach");
  assert.equal(await desk.action(code.changes.branch, { threadId }), git("rev-parse", "--short", "HEAD"));

  const plain = await mkdtemp(join(tmpdir(), "tokamak-plain-"));
  try {
    const { threadId: plainThread, turnId } = await turn(desk, plain, { model: "echo" });
    assert.equal(await desk.action(code.changes.branch, { threadId: plainThread }), null);
    assert.equal(
      await desk.action(code.changes.forTurn, { threadId: plainThread, turnId, ranEarlier: [] }),
      null,
    );
    assert.equal(await desk.action(code.changes.diff, { threadId: plainThread, turnId }), null);
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
}
