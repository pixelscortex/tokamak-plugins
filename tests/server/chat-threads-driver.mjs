import { testModules, testTemp } from "../support/paths.mjs";
// End to end for chat on the new API: the real tokamak-server binary, the real
// chat build, two real WebSocket clients ("windows") and chat's real local part
// in its plugin process. Checks what a person sees: thread rows, messages, live updates in a
// second window, folders, and the "No folder" thread's own folder on disk.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { createApi } from "../../node_modules/@tokamak/sdk/src/index.ts";
import {
  build,
  connect as connectWindow,
  copySource,
  startRunner,
  startServer,
  installBasicAuth,
  signInMember,
  watchQuery,
  workspace,
} from "../fake-agent/harness.mjs";

const binary = process.argv[2];
assert.ok(binary, "Expected the path to the tokamak-server binary");
const target = testTemp;
await mkdir(target, { recursive: true });
const scratch = await mkdtemp(join(target, "chat-threads-"));
const cleanup = [];

const watch = (client, reference, args) => watchQuery(client, reference, args, cleanup);

/** A window; with `local`, chat's local part as the desktop starts it, with only the person's account paths. */
async function connect(address, token, local) {
  return { client: await connectWindow(address, { token, launch: local, cleanup }) };
}

async function checkTranscriptLimits(client, api) {
  const { threadId } = await client.mutation(api.threads.start, {
    text: "Transcript limits",
    folder: { kind: "own" },
  });
  const post = (text) => client.mutation(api.messages.post, { threadId, text });
  const list = () => client.query(api.messages.list, { threadId });
  for (let index = 0; index < 205; index++) await post(String(index));
  const recent = await list();
  assert.equal(recent.length, 200);
  assert.equal(recent[0].parts[0].text, "5");
  assert.equal(recent.at(-1).parts[0].text, "204");

  const body = "💬".repeat(12_000);
  for (let index = 0; index < 20; index++) await post(`${index}:${body}`);
  const bounded = await list();
  assert.ok(bounded.length > 0 && bounded.length < 20);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 768 * 1024);
  assert.equal(bounded.at(-1).parts[0].text, `19:${body}`);
}

/** Starts the real server on a plugins folder; resolves its WebSocket address. */
const serve = (plugins, name, shared) =>
  startServer({
    binary,
    dir: join(scratch, name),
    pluginsDir: plugins,
    shared,
    ownerToken,
    servers,
    cleanup,
  });

const ownerToken = "chat-acceptance-owner-token-for-test";
const servers = [];
const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
try {
  build(join(workspace, "plugins/chat"));
  // The probe builds beside chat's source, where the build looks for `plugin:chat/server`.
  const sources = join(scratch, "sources");
  const modules = testModules;
  await copySource(join(workspace, "plugins/chat"), join(sources, "chat"), modules);
  const probeSource = join(sources, "reply-probe");
  await copySource(new URL("./fixtures/chat-reply-probe/", import.meta.url).pathname, probeSource, modules);
  build(probeSource);
  // Serve copies so a concurrent rebuild of the checkout cannot change the plugins under test.
  const plugins = join(scratch, "plugins");
  await cp(join(workspace, "plugins/chat/dist"), join(plugins, "chat"), { recursive: true });
  await cp(join(probeSource, "dist"), join(plugins, "reply-probe"), { recursive: true });
  const home = join(scratch, "home");
  await mkdir(home);
  const { launch, stop } = await startRunner({
    binary: process.env.TOKAMAK_TEST_RUNNER_BIN,
    plugins,
    directory: join(home, "app-data"),
    env: { HOME: home },
  });
  cleanup.push(stop);
  const { api } = await import(join(workspace, "plugins/chat/src/server/_generated/api.ts"));
  const probe = createApi("reply-probe");

  // ---- The local server: the person is the owner; two windows, one with a local part.
  const address = await serve(plugins, "local", false);
  const a = (await connect(address, undefined, launch)).client;
  const b = (await connect(address)).client;

  // Nothing exists before the first Send, and a Send with no text makes nothing.
  const threads = watch(b, api.threads.list, {});
  assert.deepEqual(await threads.until("empty list", () => true), []);
  assert.deepEqual(await a.query(api.threads.recentFolders, {}), []);
  await assert.rejects(
    a.mutation(api.threads.start, { text: "   ", folder: { kind: "own" } }),
    /must not be empty/,
  );
  await assert.rejects(
    a.mutation(api.threads.start, { text: "Hi", folder: { kind: "chosen", path: "relative/path" } }),
    /full path/,
  );
  assert.deepEqual(await a.query(api.threads.list, {}), []);

  // A typed folder is checked and expanded on this computer before it is stored.
  const project = join(home, "invoices-app");
  await mkdir(project);
  assert.equal(await a.action(api.folders.check, { path: "~/invoices-app" }), project);
  assert.deepEqual(await a.action(api.folders.check, { path: "~/missing" }), {
    failed: true,
    kind: "NotAFolder",
    data: { path: join(home, "missing") },
  });

  // The first Send makes the thread with its folder and first message; the other window sees both.
  const started = await a.mutation(api.threads.start, {
    text: "Add a CSV export\nwith filters",
    folder: { kind: "chosen", path: project },
  });
  const [row] = await threads.until("thread in second window", (list) => list.length === 1);
  assert.equal(row._id, started.threadId);
  assert.equal(row.title, "Add a CSV export");
  assert.deepEqual(row.folder, { kind: "chosen", path: project });
  assert.equal(row.createdBy, "local");
  assert.equal(await a.action(api.folders.resolve, { threadId: started.threadId }), project);
  const messages = watch(b, api.messages.list, { threadId: started.threadId });
  const [opening] = await messages.until("first message", (list) => list.length === 1);
  assert.equal(opening._id, started.messageId);
  assert.equal(opening.parts[0].text, "Add a CSV export\nwith filters");
  assert.deepEqual(opening.author, { id: "local", name: "Sam" });

  // A later Send is stored and reaches the other window live, in order.
  const second = await a.mutation(api.messages.post, {
    threadId: started.threadId,
    text: "Keep the totals exact.",
  });
  const both = await messages.until("second message", (list) => list.length === 2);
  assert.equal(both[1]._id, second);
  assert.deepEqual(
    both.map((message) => message.parts[0].text),
    ["Add a CSV export\nwith filters", "Keep the totals exact."],
  );
  assert.deepEqual(await a.query(api.threads.recentFolders, {}), [project]);

  // Another plugin writes a reply with its own token; nobody else can write into it,
  // the token never reaches a window, and no window can call the reply functions.
  const token = randomToken();
  const replyId = await a.mutation(probe.replies.open, { threadId: started.threadId, token });
  await a.mutation(probe.replies.write, { messageId: replyId, token, text: "Exporting" });
  await assert.rejects(
    a.mutation(probe.replies.write, { messageId: replyId, token: randomToken(), text: "Hijacked" }),
    /another writer/,
  );
  await a.mutation(probe.replies.write, { messageId: replyId, token, text: "Exported 12 rows.", done: true });
  await assert.rejects(
    a.mutation(probe.replies.write, { messageId: replyId, token, text: "Again" }),
    /finished/,
  );
  const withReply = await messages.until(
    "reply",
    (list) => list.at(-1)?.status === "complete" && list.length === 3,
  );
  assert.deepEqual(withReply[2].author, { id: "agent:probe", name: "Probe" });
  assert.equal(withReply[2].role, "assistant");
  assert.equal(withReply[2].parts[0].text, "Exported 12 rows.");
  assert.equal("replyToken" in withReply[2], false);
  const replies = createApi("chat");
  await assert.rejects(
    b.mutation(replies.replies.start, {
      threadId: started.threadId,
      token: randomToken(),
      author: { id: "x", name: "X" },
    }),
    /unknown function|not callable|plugin/i,
  );

  // "No folder": the thread is stored with an own folder, made by the creator's
  // local part under the app's data the first time it is asked for, then kept.
  const loose = await a.mutation(api.threads.start, { text: "Plan the week", folder: { kind: "own" } });
  const unmade = (await threads.until("no-folder thread", (list) => list.length === 2)).find(
    (t) => t._id === loose.threadId,
  );
  assert.deepEqual(unmade.folder, { kind: "own" });
  const own = await a.action(api.folders.resolve, { threadId: loose.threadId });
  assert.ok(own.startsWith(home + sep), `own folder ${own} is under the person's app data`);
  assert.ok(own.includes(join("no-project", "threads")), own);
  assert.ok((await stat(own)).isDirectory());
  assert.deepEqual(await readdir(own), []);
  await threads.until(
    "own folder stored",
    (list) => list.find((t) => t._id === loose.threadId)?.folder?.path === own,
  );
  assert.equal(await a.action(api.folders.resolve, { threadId: loose.threadId }), own);
  await assert.rejects(
    a.mutation(api.threads.setFolder, { threadId: loose.threadId, path: "/elsewhere" }),
    /already has a folder/,
  );
  await assert.rejects(
    a.mutation(api.threads.setFolder, { threadId: started.threadId, path: "/elsewhere" }),
    /already has a folder/,
  );
  // Own folders are not offered as starting points; the newest chosen folder comes first.
  const other = join(home, "website");
  await a.mutation(api.threads.start, { text: "Fix the header", folder: { kind: "chosen", path: other } });
  assert.deepEqual(await a.query(api.threads.recentFolders, {}), [other, project]);

  // Rename and delete, seen live by the other window.
  await a.mutation(api.threads.rename, { threadId: started.threadId, title: "CSV export" });
  await threads.until(
    "renamed",
    (list) => list.find((t) => t._id === started.threadId)?.title === "CSV export",
  );
  await assert.rejects(
    a.mutation(api.threads.rename, { threadId: started.threadId, title: " " }),
    /must not be empty/,
  );
  await a.mutation(api.threads.remove, { threadId: started.threadId });
  await threads.until("deleted", (list) => !list.some((t) => t._id === started.threadId));
  assert.deepEqual(await b.query(api.messages.list, { threadId: started.threadId }), []);
  assert.deepEqual(await a.query(api.threads.recentFolders, {}), [other]);

  // A window without a local part cannot make folders.
  assert.deepEqual(await b.action(api.folders.resolve, { threadId: loose.threadId }), {
    failed: true,
    kind: "noMachine",
    data: null,
  });
  await checkTranscriptLimits(a, api);

  // ---- A shared server: a member cannot point the owner's thread at a folder.
  await installBasicAuth(plugins);
  const shared = await serve(plugins, "shared", true);
  const owner = (await connect(shared, ownerToken)).client;
  const member = (await connect(shared, (await signInMember(shared, ownerToken, "Noor")).key, launch)).client;
  const mine = await owner.mutation(api.threads.start, { text: "Owner's thread", folder: { kind: "own" } });
  await assert.rejects(
    member.mutation(api.threads.setFolder, { threadId: mine.threadId, path: "/tmp/elsewhere" }),
    /Only the person who started this thread/,
  );
  for (const attempt of [
    () => member.mutation(api.threads.rename, { threadId: mine.threadId, title: "Not mine" }),
    () => member.mutation(api.threads.remove, { threadId: mine.threadId }),
    () => member.action(api.threads.removeLocal, { threadId: mine.threadId }),
  ])
    await assert.rejects(attempt(), /Only the person who started this thread/);
  assert.equal((await owner.query(api.threads.get, { threadId: mine.threadId })).title, "Owner's thread");
  const theirs = await member.mutation(api.threads.start, {
    text: "Member's thread",
    folder: { kind: "own" },
  });
  await member.mutation(api.threads.rename, { threadId: theirs.threadId, title: "My thread" });
  assert.equal((await owner.query(api.threads.get, { threadId: theirs.threadId })).title, "My thread");
  await member.action(api.threads.removeLocal, { threadId: theirs.threadId });
  assert.equal(await owner.query(api.threads.get, { threadId: theirs.threadId }), null);
  await owner.mutation(api.threads.setFolder, { threadId: mine.threadId, path: "/home/owner/own" });
  console.log(
    "chat threads: start, folders, replies, live messages, transcript limits, rename, delete, member refused",
  );
} finally {
  for (const stop of cleanup.reverse()) await Promise.resolve(stop()).catch(() => {});
  for (const server of servers) {
    server.kill("SIGTERM");
    await server.exited;
  }
  if (!process.env.TOKAMAK_TEST_TEMP) await rm(scratch, { recursive: true });
}
