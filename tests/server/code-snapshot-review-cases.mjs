import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, truncate, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { until } from "../support/routing.mjs";

export async function snapshotReviewCases(fixture) {
  await filtersOnlyChangedFiles(fixture);
  await snapshotsDuringMerge(fixture);
  await scopesSnapshotsToFolder(fixture);
  await skipsRepositoryHooks(fixture);
  await Promise.all([snapshotDeadlines(fixture), fixture.stopIsolation()]);
}

async function skipsRepositoryHooks({ desk, project, start, removeThread, refs, turnRef }) {
  const { folder, git, write } = await project("repo-hooks");
  const hookMarker = join(folder, ".git/reference-hook-ran");
  for (const directory of [".git/hooks", ".git/custom-hooks"]) {
    await mkdir(join(folder, directory), { recursive: true });
    const hook = `${directory}/reference-transaction`;
    await write(hook, "#!/bin/sh\nprintf 'hook ran\\n' >> .git/reference-hook-ran\n");
    await chmod(join(folder, hook), 0o755);
  }
  const thread = await start(desk, folder);
  for (const directory of [".git/hooks", ".git/custom-hooks"]) {
    git("config", "core.hooksPath", directory);
    // Verify Git would run this hook without the snapshot command's override.
    git("update-ref", "refs/test/hook-probe", "HEAD");
    assert.match(await readFile(hookMarker, "utf8"), /hook ran/);
    await unlink(hookMarker);
    git("-c", "core.hooksPath=/dev/null", "update-ref", "-d", "refs/test/hook-probe");
    if (directory === ".git/hooks") git("config", "--unset", "core.hooksPath");
    const message = directory === ".git/hooks" ? thread.messageId : await thread.post();
    const { turnId } = await thread.run(message, "edit-fail");
    const prefix = turnRef(thread.threadId, turnId);
    assert.deepEqual(refs(git, prefix), [`${prefix}/after`, `${prefix}/before`]);
    await assert.rejects(stat(hookMarker), { code: "ENOENT" });
  }
  await removeThread(thread.threadId);
  await assert.rejects(stat(hookMarker), { code: "ENOENT" });
}

async function filtersOnlyChangedFiles({ desk, project, start, turnRef }) {
  const { folder, git, write } = await project("clean-filter");
  git("config", "filter.log.clean", "printf '%s\\n' %f >> .git/clean-calls; cat");
  git("config", "filter.log.required", "true");
  await write(".git/info/attributes", "*.txt filter=log\n");
  // Avoid Git's conservative recheck when the file and index timestamps tie.
  await utimes(join(folder, "staged.txt"), 1, 1);
  git("add", "staged.txt");
  await write(".git/clean-calls", "");
  await write("agent.txt", "before the turn\n");
  const thread = await start(desk, folder);
  const { state, turnId } = await thread.run(thread.messageId, "edit-fail");
  assert.equal(state, "failed");
  const prefix = turnRef(thread.threadId, turnId);
  assert.equal(git("show", `${prefix}/before:agent.txt`), "before the turn");
  assert.equal(git("show", `${prefix}/after:agent.txt`), "partial change");
  const calls = (await readFile(join(folder, ".git/clean-calls"), "utf8")).trim().split("\n");
  assert.ok(calls.length >= 2, "the clean filter runs in both snapshots");
  assert.deepEqual(
    [...new Set(calls)],
    ["agent.txt"],
    "unchanged tracked files never pass through the filter",
  );
}

async function snapshotsDuringMerge({ desk, project, start, turnRef }) {
  const { folder, git, write } = await project("merge-conflict");
  const user = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
  const branch = git("symbolic-ref", "--short", "HEAD");
  git("checkout", "-qb", "other");
  await write("staged.txt", "from other\n");
  git(...user, "commit", "-qam", "Other change");
  git("checkout", "-q", branch);
  await write("staged.txt", "from this branch\n");
  git(...user, "commit", "-qam", "Conflicting change");
  assert.throws(() => git(...user, "merge", "--no-edit", "other"), { status: 1 });
  assert.ok(git("ls-files", "--unmerged"));
  const index = await readFile(join(folder, ".git/index"));
  const conflict = await readFile(join(folder, "staged.txt"), "utf8");
  const thread = await start(desk, folder);
  const { turnId } = await thread.run(thread.messageId, "edit-fail");
  const prefix = turnRef(thread.threadId, turnId);
  assert.equal(git("show", `${prefix}/before:staged.txt`), conflict.trimEnd());
  assert.equal(git("show", `${prefix}/after:agent.txt`), "partial change");
  assert.deepEqual(await readFile(join(folder, ".git/index")), index);
}

async function scopesSnapshotsToFolder({ desk, code, project, start, turnRef }) {
  const { folder: root, git, write } = await project("scoped-worktree");
  const scope = "work [draft]";
  await mkdir(join(root, scope));
  await mkdir(join(root, "ignored"));
  await write(".gitignore", "ignored/\n");
  await write(`${scope}/agent.txt`, "from HEAD\n");
  await write("ignored/agent.txt", "from HEAD\n");
  git("add", ".");
  git("add", "--force", "ignored/agent.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Scoped folders");
  await write("staged.txt", "staged outside the folder\n");
  git("add", "staged.txt");
  await write("untracked.txt", "outside the folder\n");
  await write(`${scope}/large.bin`, "");
  await truncate(join(root, `${scope}/large.bin`), 50_000_001);
  await write(`${scope}/new.txt`, "inside the folder\n");
  await write("ignored/private.txt", "an ignored, untracked file\n");

  const thread = await start(desk, join(root, scope));
  const { turnId } = await thread.run(thread.messageId, "edit-fail");
  const prefix = turnRef(thread.threadId, turnId);
  assert.equal(git("diff", "--name-only", "HEAD", `${prefix}/before`), `${scope}/new.txt`);
  assert.equal(git("diff", "--name-only", `${prefix}/before`, `${prefix}/after`), `${scope}/agent.txt`);
  assert.deepEqual(await desk.action(code.notices.forTurn, { threadId: thread.threadId, turnId }), {
    omitted: [`${scope}/large.bin`],
    warning: null,
  });

  const ignored = await start(desk, join(root, "ignored"));
  const ignoredTurn = await ignored.run(ignored.messageId, "edit-fail");
  const ignoredPrefix = turnRef(ignored.threadId, ignoredTurn.turnId);
  assert.equal(git("diff", "--name-only", "HEAD", `${ignoredPrefix}/before`), "");
  assert.equal(
    git("diff", "--name-only", `${ignoredPrefix}/before`, `${ignoredPrefix}/after`),
    "ignored/agent.txt",
  );
}

export async function stall(project, wait = "sleep 90") {
  project.git(
    "config",
    "filter.stall.clean",
    `printf "%s %s\\n" "$PPID" "$$" > .git/stall-pids; ${wait}; cat`,
  );
  await project.write(".git/info/attributes", "agent.txt filter=stall\n");
}

export function alive(pid) {
  const state = Bun.spawnSync(["ps", "-ww", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  return !!state && !state.startsWith("Z");
}

export async function gitPids({ folder }) {
  const file = Bun.file(join(folder, ".git/stall-pids"));
  let line;
  await until("Git's slow clean filter starts", async () => {
    line = (await file.text().catch(() => "")).trim();
    return /^\d+ \d+$/.test(line);
  });
  const pids = line.split(" ").map(Number);
  assert.equal(pids.length, 2);
  assert.ok(pids.every((pid) => pid > 1 && alive(pid)));
  return pids;
}

async function snapshotDeadlines({ desk, code, project, start, refs, gate }) {
  const before = await project("slow-before");
  const after = await project("slow-after");
  await stall(before);
  await before.write("agent.txt", "changed by the person\n");
  const beforeThread = await start(desk, before.folder);
  const afterThread = await start(desk, after.folder);

  const [blocked, finished] = await Promise.all([
    (async () => {
      const running = beforeThread.run(beforeThread.messageId, "edit-fail", 75_000);
      const pids = await gitPids(before);
      const result = await running;
      await until("the timed-out before hook reaps Git and its filter", () =>
        pids.every((pid) => !alive(pid)),
      );
      return result;
    })(),
    (async () => {
      const running = afterThread.run(afterThread.messageId, "edit", 75_000);
      await afterThread.edited();
      await stall(after);
      await gate(after.folder, "go");
      const pids = await gitPids(after);
      const result = await running;
      await until("the timed-out after hook reaps Git and its filter", () =>
        pids.every((pid) => !alive(pid)),
      );
      return result;
    })(),
  ]);

  assert.equal(blocked.state, "failed");
  assert.match((await beforeThread.reply(blocked.turnId)).error, /before hook timed out/);
  assert.equal(await readFile(join(before.folder, "agent.txt"), "utf8"), "changed by the person\n");
  assert.deepEqual(refs(before.git), []);
  assert.equal(finished.state, "done");
  assert.equal(finished.hookNotice, "Couldn't save this turn's code");
  assert.deepEqual(
    await desk.action(code.notices.forTurn, { threadId: afterThread.threadId, turnId: finished.turnId }),
    {
      omitted: [],
      warning: "Couldn't save this turn's code",
    },
  );

  for (const [project, thread] of [
    [before, beforeThread],
    [after, afterThread],
  ]) {
    await unlink(join(project.folder, ".git/info/attributes"));
    const next = await thread.run(await thread.post(), "edit-fail");
    assert.equal((await thread.reply(next.turnId)).error, "rate limited", "the next turn starts normally");
  }
  console.log("code snapshots: both hook deadlines reaped Git and its filter");
}
