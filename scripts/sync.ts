import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const designNotes = new Map([
  ["chat", "chat.md"],
  ["ai", "ai.md"],
  ["code", "code.md"],
  ["claude", "claude-plugin.md"],
  ["codex", "codex-plugin.md"],
  ["basic-auth", null],
  ["agent-proxy", "agent-proxy.md"],
  ["ai-profiles", "ai-profiles.md"],
]);
const designPlugins = new Map(
  [...designNotes].flatMap(([id, note]) => note ? [[note, id] as const] : []),
);

// Skip Moon tasks and the server-backed tests managed separately.
const EXCLUDE = [
  /(?:^|\/)moon\.yml$/,
  /^agent-proxy\/tests\/(?:workspace\.ts|(?:addresses|chatgpt-sign-in|manage-companies|manage|sign-in|proxy|cli)\.test\.ts|cli-sandbox\.ts)$/,
  /^ai-profiles\/tests\/profiles-server\.test\.ts$/,
];

// Local manifests, editor/test configs, and files maintained only in this repository.
const KEEP = [
  /^[^/]+\/package\.json$/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /^[^/]+\/(?:tests\/)?vitest\.config\.ts$/,
  /^basic-auth\/DESIGN\.md$/,
];
const github = "https://github.com/pixelscortex/tokamak/blob/main/";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function listed(cwd: string, ...args: string[]): string[] {
  return git(cwd, "ls-files", "-z", ...args).split("\0").filter(Boolean);
}

function applies(rules: RegExp[], path: string): boolean {
  return rules.some((rule) => rule.test(path.slice("plugins/".length)));
}

function rewriteDesign(markdown: string): string {
  return markdown.replace(/\]\(([^\s)]+)(?=[\s)])/g, (link, target: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|[\/#])/i.test(target)) return link;
    const [, path, suffix] = /^([^?#]+)(.*)$/.exec(target) ?? [];
    if (!path) return link;
    const source = normalize(join("design", path));
    const note = source.startsWith("design/") && designPlugins.get(source.slice("design/".length));
    if (note) return `](../${note}/DESIGN.md${suffix}`;
    const plugin = /^plugins\/([^/]+)(\/.*)?$/.exec(source);
    if (plugin && designNotes.has(plugin[1])) {
      const rest = plugin[2] ?? "";
      if (!applies(EXCLUDE, source)) return `](../${plugin[1]}${rest}${suffix}`;
    }
    return `](${github}${source}${suffix}`;
  });
}

function destination(path: string): string {
  const target = join(repo, path);
  // A local symlink must not send a copy or deletion outside this checkout.
  for (let part = target; part !== repo; part = dirname(part)) {
    const stat = lstatSync(part, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`move the symlink at ${part} aside first`);
  }
  return target;
}

const serverTests = [
  ...["chat-threads", "ai-turns", "ai-threads", "ai-liveness", "code-changes", "code-snapshots"]
    .map((name) => `${name}-driver.mjs`),
  "code-snapshot-process-cases.mjs",
  "code-snapshot-review-cases.mjs",
  "fixtures/chat-reply-probe",
  "fixtures/ai-rows-probe",
];
const routing = "packages/runner/tests/support/routing.mjs";

function rewriteTest(path: string, source: string): string {
  // The suite runner owns scratch cleanup so it can retain a failed run.
  if (path.startsWith("tests/server/") || path.startsWith("tests/fake-agent/")) {
    source = source.replace(/(^[ \t]*)await rm\(scratch,/gm,
      "$1if (!process.env.TOKAMAK_TEST_TEMP) await rm(scratch,");
  }
  if (path.startsWith("tests/server/")) {
    source = source
      .replaceAll("../../../e2e/fake-agent/", "../fake-agent/")
      .replaceAll("../../sdk/src/", "../../node_modules/@tokamak/sdk/src/")
      .replaceAll("../../../plugins/", "../../plugins/")
      .replaceAll("../../runner/tests/support/routing.mjs", "../support/routing.mjs")
      .replaceAll('join(import.meta.dir, "../target")', "testTemp")
      .replaceAll('join(workspace, "plugins/chat/node_modules")', "testModules")
      .replaceAll('join(workspace, "plugins/ai/node_modules")', "testModules")
      .replaceAll('join(source, "node_modules")', "testModules")
      .replaceAll('join(workspace, "app/tsconfig.json")', "testWindowConfig");
    const paths = ["testModules", "testTemp", "testWindowConfig"].filter((name) => source.includes(name));
    if (paths.length) source = `import { ${paths.join(", ")} } from "../support/paths.mjs";\n` + source;
  } else if (path.startsWith("tests/fake-agent/")) {
    source = source
      .replaceAll("../../packages/sdk/src/", "../../node_modules/@tokamak/sdk/src/")
      .replaceAll("../../packages/runtime/js/", "../../node_modules/@tokamak/runtime/js/")
      .replaceAll('join(workspace, "packages/build/src/build.ts")', "testBuilder")
      .replaceAll("../../packages/runner/tests/support/routing.mjs", "../support/routing.mjs")
      .replaceAll('join(workspace, "packages/server/target")', "testTemp")
      .replaceAll('join(workspace, "plugins/ai/node_modules")', "testModules")
      .replaceAll('join(workspace, "plugins", id, "node_modules")', "testModules")
      .replaceAll('join(original, "node_modules")', "testModules")
      .replaceAll('join(proxySource, "node_modules")', "testModules")
      .replaceAll('join(workspace, "tsconfig.json")', "testServerConfig")
      .replaceAll('basename(binary).startsWith("tokamak-runner")', "isRunner(binary)")
      .replaceAll('useRunner ? join(dirname(binary), "tokamak-server") : binary', 'useRunner ? (process.env.TOKAMAK_TEST_SERVER_BIN ?? join(dirname(binary), "tokamak-server")) : binary')
      .replaceAll('const blocked = installedCodex ? await blockingProxy() : null;', 'const blocked = installedCodex ? await (await import(join(tokamakDir, "plugins/agent-proxy/tests/cli-sandbox.ts"))).blockingProxy() : null;')
      .replace('import { blockingProxy } from "../../plugins/agent-proxy/tests/cli-sandbox.ts";\n', "")
      .replace('    assert.equal(basename(host), "tokamak-plugin-host", `Expected the QuickJS plugin host, got ${host}`);\n', "")
      .replace('import { basename, dirname, join, resolve }', 'import { dirname, join, resolve }')
      .replaceAll("e2e/fake-agent/", "tests/fake-agent/")
      .replace("One harness: a scratch folder under packages/server/target", "One harness: a scratch folder in the test run's temp directory")
      .replace('Server: `CARGO_BUILD_JOBS=2 cargo test --locked -p server --test ai_turns`', 'Server: `proto run bun -- run test:suite ai-turns`')
      .replace('(driver: `packages/server/tests/ai-turns-driver.mjs`)', '(driver: `tests/server/ai-turns-driver.mjs`)');
    const paths = ["isRunner", "testBuilder", "testModules", "testServerConfig", "testTemp", "tokamakDir"]
      .filter((name) => source.includes(name));
    if (paths.length) source = `import { ${paths.join(", ")} } from "../support/paths.mjs";\n` + source;
  } else if (path === "tests/support/routing.mjs") {
    source = source
      .replaceAll("../../../../e2e/fake-agent/", "../fake-agent/")
      .replace("tokamak-plugin-host --local-plugin", "--local-plugin");
  } else if (/^plugins\/(claude|codex)\/tests\/.*\.mjs$/.test(path)) {
    source = source
      .replaceAll("e2e/fake-agent/", "tests/fake-agent/")
      .replaceAll("../../../packages/runner/tests/support/routing.mjs", "../../../tests/support/routing.mjs");
    if (path.endsWith("/codex/tests/e2e.mjs")) {
      source = source.replace(/binary\.split\(.+\.startsWith\("tokamak-runner"\)/, "isRunner(binary)");
      source = 'import { isRunner } from "../../../tests/support/paths.mjs";\n' + source;
    }
  }
  return source;
}

function syncTests(checkout: string): void {
  const roots = [
    ["e2e/fake-agent/", "tests/fake-agent/"],
    ["packages/server/tests/", "tests/server/"],
  ];
  const files = listed(checkout, "--cached", "--", roots[0][0],
    ...serverTests.map((name) => roots[1][0] + name), routing);
  for (const name of [...serverTests.map((path) => roots[1][0] + path), roots[0][0], routing]) {
    if (!files.some((file) => file === name || file.startsWith(name.endsWith("/") ? name : name + "/"))) {
      throw new Error(`${checkout} has no tracked ${name}`);
    }
  }
  for (const from of files) {
    const path = from === routing ? "tests/support/routing.mjs" : roots.reduce(
      (name, [prefix, target]) => name.startsWith(prefix) ? target + name.slice(prefix.length) : name,
      from,
    );
    const to = join(repo, path);
    const stat = lstatSync(join(checkout, from));
    mkdirSync(destination(dirname(path)), { recursive: true });
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(join(checkout, from));
      const local = lstatSync(to, { throwIfNoEntry: false });
      if (local?.isSymbolicLink() && readlinkSync(to) === link) continue;
      if (local) throw new Error(`move ${to} aside first`);
      symlinkSync(link, to);
    } else {
      destination(path);
      if (!stat.isFile()) throw new Error(`${from} is not a regular file`);
      if (/\.(?:mjs|ts|md)$/.test(path)) writeFileSync(to, rewriteTest(path, readFileSync(join(checkout, from), "utf8")));
      else copyFileSync(join(checkout, from), to);
      chmodSync(to, stat.mode & 0o777);
    }
  }
  console.log(`  shared tests: ${files.length} files copied`);
}

function main(): void {
  const testsOnly = process.argv[2] === "--tests" && process.argv.length === 3;
  const args = process.argv.slice(2);
  const ids = testsOnly ? [] : args.length ? [...new Set(args)] : [...designNotes.keys()];
  for (const id of ids) {
    if (!designNotes.has(id)) throw new Error(`unknown plugin ${id}. Choose from: ${[...designNotes.keys()].join(", ")}`);
  }

  const checkout = resolve(repo, process.env.TOKAMAK_DIR || "../tokamak");
  const manifest = join(checkout, "package.json");
  if (!existsSync(manifest) || JSON.parse(readFileSync(manifest, "utf8")).name !== "tokamak" ||
      !existsSync(join(checkout, "packages/sdk/package.json")) ||
      git(checkout, "rev-parse", "--show-prefix").trim() !== "" ||
      realpathSync(checkout) === realpathSync(repo)) {
    throw new Error(`${checkout} is not a Tokamak checkout. Set TOKAMAK_DIR to one.`);
  }
  const commit = git(checkout, "rev-parse", "HEAD").trim();

  const plans = ids.map((id) => {
    const folder = `plugins/${id}`;
    const paths = new Set(listed(checkout, "--cached", "--", folder).filter((path) => !applies(EXCLUDE, path)));
    if (!paths.has(`${folder}/plugin.ts`)) throw new Error(`${checkout} has no tracked ${folder}/plugin.ts`);
    const note = designNotes.get(id);
    const designPath = `${folder}/DESIGN.md`;
    const design = note ? rewriteDesign(readFileSync(join(checkout, "design", note), "utf8")) : null;
    const stale = listed(repo, "--cached", "--others", "--exclude-standard", "--", folder).filter(
      (path) => !paths.has(path) && !applies(KEEP, path) && !(design !== null && path === designPath),
    );
    const copies = [...paths].flatMap((path) => {
      const to = destination(path);
      if (applies(KEEP, path) && existsSync(to)) return [];
      const from = join(checkout, path);
      const stat = lstatSync(from);
      if (!stat.isFile()) throw new Error(`${from} is not a regular file`);
      return [{ path, from, to, mode: stat.mode & 0o777 }];
    });
    return { id, copies, stale: stale.map(destination), design, designPath: destination(designPath) };
  });

  for (const { id, copies, stale, design, designPath } of plans) {
    for (const path of stale) {
      if (existsSync(path)) unlinkSync(path);
    }
    for (const { path, from, to, mode } of copies) {
      mkdirSync(dirname(to), { recursive: true });
      if (/^plugins\/(claude|codex)\/tests\/.*\.mjs$/.test(path)) {
        writeFileSync(to, rewriteTest(path, readFileSync(from, "utf8")));
      } else copyFileSync(from, to);
      chmodSync(to, mode);
    }
    if (design !== null) writeFileSync(designPath, design);
    console.log(`  ${id}: ${copies.length} files copied, ${stale.length} removed`);
  }
  if (testsOnly) syncTests(checkout);
  console.log(`Synced from Tokamak commit: ${commit}`);
}

try {
  main();
} catch (error) {
  console.error(`sync: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
