import assert from "node:assert/strict";
import { homedir, userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const replays = fileURLToPath(new URL("./replays/", import.meta.url));
const exampleAccountId = "00000000-0000-4000-8000-000000000000";
const exampleMissingThreadId = "00000000-0000-4000-8000-000000000001";
const uuid = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
const email = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
const home = /(?:\/(?:Users|home|var\/home)\/[^/\s]+|\/root(?:\/|\b)|\b[A-Z]:[\\/]Users[\\/])/i;
const fileOwner = /^[-d][rwx@+-]{9,}\s+\d+\s+(\S+)/gm;
const claudeIds = new Set([
  "out.uuid",
  "out.session_id",
  "out.request_id",
  "out.task_id",
  "out.response.request_id",
  "expect.session_id",
  "expect.response.request_id",
]);
const missingSession = "No conversation found with session ID: 11111111-1111-4111-8111-111111111111";
const virtualHelperPath = "/root/helper";
const placeholders = new Map([
  ["chatgptAccountId", exampleAccountId],
  ["planType", "plus"],
  ["processId", "1000"],
  ["userId", "1000"],
  ["startedAt", 1_700_000_000],
  ["completedAt", 1_700_000_000],
  ["startedAtMs", 1_700_000_000_000],
  ["completedAtMs", 1_700_000_000_000],
  ["emittedAtMs", 1_700_000_000_000],
  ["durationMs", 0],
]);

// The words and names this computer must never leak: the login, the home folder and
// TOKAMAK_PRIVATE_WORDS (comma-separated, set locally only; never write the words in the repo).
function localPrivacy() {
  const login = userInfo().username;
  // These logins are also normal words in prompts and source paths. File listings have their own check.
  const genericLogin = /^(?:user|root|runner)$/i.test(login);
  return {
    homePath: homedir().replaceAll("\\", "/").toLowerCase(),
    genericLogin,
    privateWords: (process.env.TOKAMAK_PRIVATE_WORDS ?? "")
      .split(",")
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean),
    loginPattern: genericLogin
      ? null
      : new RegExp(`(^|[^\\w.-])${login.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, "\\$&")}($|[^\\w.-])`, "i"),
  };
}

export async function scanReplays(agent, folder = agent === "codex" ? join(replays, "codex") : replays) {
  const { homePath, privateWords, loginPattern } = localPrivacy();
  const files = (await readdir(folder)).filter((file) =>
    agent === "codex" ? file.endsWith(".jsonl") : /^claude-.*\.jsonl$/.test(file),
  );
  assert.ok(files.length, `No ${agent} replay files found`);
  for (const file of files) {
    const lines = (await readFile(join(folder, file), "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      const location = `${file}:${index + 1}`;
      const check = (pass, issue) => assert.ok(pass, `${location}: ${issue}`);
      function scan(value, field, path = "") {
        if (value === null) return;
        if (agent === "codex" && placeholders.has(field))
          check(value === placeholders.get(field), `non-placeholder ${field}`);
        if (agent === "codex" && field === "userAgent")
          check(/^tokamak\/\d+\.\d+\.\d+ \(example-platform\)$/.test(value), "non-placeholder userAgent");
        if (Array.isArray(value)) for (const child of value) scan(child);
        else if (typeof value === "object")
          for (const [key, child] of Object.entries(value)) {
            scan(key);
            scan(child, key, path ? `${path}.${key}` : key);
          }
        else if (typeof value === "string") {
          check(!loginPattern?.test(value), "local login");
          check(!privateWords.some((word) => value.toLowerCase().includes(word)), "private word");
          check(!email.test(value), "email address");
          // agentPath is a Codex thread address, not a filesystem path.
          check(
            (field === "agentPath" && value === virtualHelperPath) ||
              (!home.test(value) && !value.replaceAll("\\", "/").toLowerCase().includes(homePath)),
            "absolute home path",
          );
          for (const [id] of value.matchAll(uuid))
            check(
              id === exampleAccountId ||
                id === exampleMissingThreadId ||
                (agent === "claude" && ((value === id && claudeIds.has(path)) || value === missingSession)),
              "non-placeholder UUID",
            );
          for (const [, owner] of value.matchAll(fileOwner))
            check(owner === "user", "non-placeholder file owner");
        }
      }
      scan(line.trimStart().startsWith("{") ? JSON.parse(line) : line);
    }
  }
}

const repository = fileURLToPath(new URL("../../", import.meta.url));
// Lockfiles name upstream sources and their owners; they are generated, not written by us.
const skippedFiles = new Set([
  "Cargo.lock",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "skills-lock.json",
]);
// Names the app had before these checks, matched by shape so the words never appear here.
// Each is removed from its line before the line is checked.
const allowedShapes = new Map([
  ["app/src-tauri/tauri.conf.json", [/"identifier": "com\.[\w-]+\.Tokamak"/g]],
  ["packages/server/src/main.rs", [/ProjectDirs::from\("com", "[\w-]+", "Tokamak"\)/g]],
  ["Cargo.toml", [/rquickjs-sys = \{ git = "https:\/\/github\.com\/[\w-]+\/rquickjs"/g]],
]);

/** Checks every tracked or new text file (tests, fixtures, docs) for the private words, the login
 *  and the home folder. Replays get the stricter structural checks in `scanReplays`. */
export async function scanRepository(root = repository) {
  const { homePath, genericLogin, privateWords, loginPattern } = localPrivacy();
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file && !skippedFiles.has(basename(file)));
  assert.ok(files.length, "No repository files found");
  const issues = [];
  for (const file of new Set(files)) {
    let bytes;
    try {
      bytes = await readFile(join(root, file));
    } catch (cause) {
      if (cause.code === "ENOENT" || cause.code === "EISDIR") continue; // deleted, or a submodule
      throw cause;
    }
    if (bytes.includes(0)) continue; // binary
    const shapes = allowedShapes.get(file) ?? [];
    for (const [index, raw] of bytes.toString("utf8").split("\n").entries()) {
      const line = shapes.reduce((text, shape) => text.replace(shape, ""), raw);
      const lower = line.toLowerCase();
      const found = [
        loginPattern?.test(line) && "local login",
        privateWords.some((word) => lower.includes(word)) && "private word",
        // A shared home such as /root also appears in container files; only a personal one is private.
        !genericLogin && lower.replaceAll("\\", "/").includes(homePath) && "absolute home path",
      ].filter(Boolean);
      for (const issue of found) issues.push(`${file}:${index + 1}: ${issue}`);
    }
  }
  assert.ok(!issues.length, `Private data in the repository:\n${issues.join("\n")}`);
}

if (import.meta.main) {
  const agents = process.argv[2] ? [process.argv[2]] : ["claude", "codex"];
  for (const agent of agents) await scanReplays(agent, process.argv[3]);
  if (!process.argv[2]) await scanRepository();
}
