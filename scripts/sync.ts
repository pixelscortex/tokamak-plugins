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

// Moon tasks belong to the Tokamak checkout.
const EXCLUDE = [/(?:^|\/)moon\.yml$/];

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
const browserTests = [
  ...["ai", "ai-thread", "ai-quit", "chat", "code", "thread-list", "plugin-screens"]
    .map((name) => `e2e/browser/${name}.spec.ts`),
  ...["agent-picker", "desktop"]
    .map((name) => `e2e/browser/${name}.ts`),
  "e2e/serve.ts",
  "e2e/serve-hosted.ts",
  "e2e/hosted-fixture.ts",
];
const runnerTests = [
  "agent-routing.mjs",
  "measure-first-text.mjs",
  "measure-linux-memory.mjs",
  "support/agents.mjs",
  "support/agent-channel.mjs",
  "support/scratch.mjs",
];
const starter = "e2e/starter.mjs";
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
      .replace('    assert.equal(basename(host), "tokamak-plugin-host", `Expected the QuickJS plugin host, got ${host}`);\n', "")
      .replace('import { basename, dirname, join, resolve }', 'import { dirname, join, resolve }')
      .replaceAll("e2e/fake-agent/", "tests/fake-agent/")
      .replace("One harness: a scratch folder under packages/server/target", "One harness: a scratch folder in the test run's temp directory")
      .replace('Server: `CARGO_BUILD_JOBS=2 cargo test --locked -p server --test ai_turns`', 'Server: `proto run bun -- run test:suite ai-turns`')
      .replace('(driver: `packages/server/tests/ai-turns-driver.mjs`)', '(driver: `tests/server/ai-turns-driver.mjs`)');
    if (path === "tests/fake-agent/harness.mjs") {
      source = source.replace('  dir,\n  pluginsDir,', '  dir,\n  dataDir = join(dir, "store"),\n  pluginsDir,')
        .replace('"--data", join(dir, "store")', '"--data", dataDir');
    }
    const paths = ["isRunner", "testBuilder", "testModules", "testServerConfig", "testTemp", "tokamakDir"]
      .filter((name) => source.includes(name));
    if (paths.length) source = `import { ${paths.join(", ")} } from "../support/paths.mjs";\n` + source;
  } else if (path.startsWith("tests/e2e/browser/")) {
    source = source
      .replaceAll("../../packages/sdk/src/", "../../../node_modules/@tokamak/sdk/src/")
      .replaceAll("../../plugins/", "../../../plugins/")
      .replaceAll('"../fake-agent/', '"../../fake-agent/')
      .replaceAll("e2e/fake-agent", "tests/fake-agent");
    if (path === "tests/e2e/browser/desktop.ts") {
      source = source
        .replace('import { dirname, join, resolve } from "node:path";', 'import { dirname, join } from "node:path";')
        .replace(/  const binary = resolve\(\n.*?\n  \);/s, '  const binary = process.env.TOKAMAK_TEST_RUNNER_BIN!;');
    }
  } else if (path === "tests/e2e/serve.ts" || path === "tests/e2e/hosted-fixture.ts") {
    // Tokamak's launchers assume target/debug and app/.dev. Use the runner's binary and scratch.
    source = source
      .replace('import { resolve } from "node:path";\n', 'import { join } from "node:path";\n')
      .replace('const root = resolve(import.meta.dirname, "..");\n', '')
      .replace(/`\$\{root\}\/app\/\.dev\/(serve(?:-hosted)?-)`/, 'join(process.env.TOKAMAK_TEST_TEMP!, "$1")')
      .replace('`${root}/target/debug/tokamak-server`', 'process.env.TOKAMAK_TEST_SERVER_BIN!');
  } else if (path.startsWith("tests/runner/")) {
    source = source
      .replaceAll("../../../../e2e/fake-agent/", "../../fake-agent/")
      .replaceAll("../../../e2e/fake-agent/", "../fake-agent/")
      .replaceAll("../../sdk/src/", "../../node_modules/@tokamak/sdk/src/")
      .replaceAll('join(workspace, "e2e/fake-agent/', 'join(workspace, "tests/fake-agent/')
      .replaceAll('join(workspace, "target/', 'join(testTemp, "')
      .replace('mkdtemp("/tmp/tkm246-memory-")', 'mkdtemp(join(testTemp, "tkm246-memory-"))')
      .replaceAll('await cleanScratch(scratch);', 'if (!process.env.TOKAMAK_TEST_TEMP) await cleanScratch(scratch);')
      .replace(/(connect, (?:within|watchQuery)), workspace/, "$1")
      .replaceAll('from "./support/routing.mjs"', 'from "../support/routing.mjs"')
      .replaceAll('from "./routing.mjs"', 'from "../../support/routing.mjs"');
    if (path.endsWith("/support/agents.mjs")) {
      source = source
        .replace('import { build, bunPath, workspace }', 'import { bunPath, workspace }')
        .replace('const quoted =', 'import { buildPluginsIn } from "../../support/build-plugins.ts";\n\nconst quoted =')
        .replace('  for (const id of ["chat", "ai", "claude", "codex", ...(code ? ["code"] : [])]) {\n    const source = join(workspace, "plugins", id);',
          '  const ids = ["chat", "ai", "claude", "codex", ...(code ? ["code"] : [])];\n  const sources = join(scratch, "sources");\n  let built = false;\n  for (const id of ids) {')
        .replace('      build(source);\n      await cp(join(source, "dist"),',
          '      if (!built) {\n        await buildPluginsIn(sources, ids);\n        built = true;\n      }\n      await cp(join(sources, id, "dist"),');
    }
    if (source.includes("testTemp")) source = 'import { testTemp } from "../support/paths.mjs";\n' + source;
  } else if (path === "tests/starter.mjs") {
    source = source
      .replace("// Fresh packaged installation. Without --real this exercises only the server.", "// Fresh packaged installation against the real server.")
      .replace('import { mkdir, mkdtemp, rm, writeFile }', 'import { mkdir, mkdtemp, writeFile }')
      .replace('import { delimiter, dirname, join, resolve }', 'import { join }')
      .replace('import { homedir } from "node:os";\n', "")
      .replace('import { buildStarterPlugins, installStarterPlugins } from "../app/scripts/starter-plugins.ts";',
        'import { buildStarterPlugins } from "./support/starter-plugins.ts";\nimport { cleanScratch } from "./runner/support/scratch.mjs";\nimport { testTemp } from "./support/paths.mjs";')
      .replace('from "../packages/sdk/src/index.ts"', 'from "../node_modules/@tokamak/sdk/src/index.ts"')
      .replace('import { agentTurns } from "./fake-agent/agent-turn.mjs";\n', "")
      .replace('import { startRunner } from "./fake-agent/start-runner.ts";\n', "")
      .replace('import { connect, startServer, workspace }', 'import { connect, startServer }')
      .replace(/const \[flag, \.\.\.requested\][\s\S]+?const pluginsDir/,
        'const [binary, ...extra] = process.argv.slice(2);\nassert.ok(binary && !extra.length, "Pass only the test server binary");\nconst root = await mkdtemp(join(testTemp, "starter-"));\nconst pluginsDir')
      .replace('const project = join(root, "project");\n', "")
      .replace('  buildStarterPlugins();\n  await installStarterPlugins(pluginsDir);',
        '  await buildStarterPlugins(join(root, "sources"), pluginsDir);')
      .replace('  await mkdir(project);\n', "")
      .replace('const api = { ai: createApi("ai"), chat: createApi("chat") };', 'const api = { chat: createApi("chat") };')
      .replace(/\n\n  if \(requested.length\) \{[\s\S]+?\n} finally/, '\n} finally')
      .replace('  await rm(root, { recursive: true, force: true });',
        '  if (!process.env.TOKAMAK_TEST_TEMP) await cleanScratch(root);');
  } else if (path === "plugins/agent-proxy/tests/addresses.test.ts") {
    source = source
      .replace('join(plugin, "node_modules")', 'join(root, "node_modules")')
      .replace('"proto", ["run", "bun", "--", join(root, "packages/build/src/build.ts"), source]',
        'process.env.TOKAMAK_TEST_BUN!, [join(root, "node_modules/@tokamak/build/src/build.ts"), source]')
      .replace('process.env.TOKAMAK_TEST_SERVER_BIN ?? join(root, "target/debug/tokamak-server")', 'process.env.TOKAMAK_TEST_SERVER_BIN')
      .replace('process.env.TOKAMAK_PLUGIN_HOST ?? join(root, "target/debug/tokamak-plugin-host")', 'process.env.TOKAMAK_TEST_PLUGIN_HOST')
      .replace('if (!existsSync(binary) || !existsSync(host))', 'if (!binary || !host || !existsSync(binary) || !existsSync(host))')
      .replace('    const target = join(root, "target");\n    await mkdir(target, { recursive: true });\n', '')
      .replace('mkdtemp(join(target, "agent-proxy-install-"))', 'mkdtemp(join(process.env.TOKAMAK_TEST_TEMP!, "agent-proxy-install-"))');
  } else if (path === "plugins/agent-proxy/tests/workspace.ts") {
    source = source
      .replace('  stat,\n', "")
      .replace('import { join, resolve }', 'import { join }')
      .replace('const root = resolve(import.meta.dirname, "../../..");', 'const scratch = process.env.TOKAMAK_TEST_TEMP!;')
      .replace(/  const debug = join\(root,[\s\S]+?\n}\n\nlet built:[\s\S]+?\n}\n/,
        '  return [\n' +
        '    { name: "Runner build", server: process.env.TOKAMAK_TEST_SERVER_BIN!, host: process.env.TOKAMAK_TEST_PLUGIN_HOST! },\n' +
        '    { name: "Server build", server: process.env.TOKAMAK_TEST_CLOUD_SERVER_BIN!, host: process.env.TOKAMAK_TEST_CLOUD_PLUGIN_HOST! },\n' +
        '  ].filter((build) => build.server && build.host && existsSync(build.server) && existsSync(build.host));\n}\n')
      .replace('join(root, "plugins/agent-proxy/node_modules")', 'join(scratch, "sources/agent-proxy/node_modules")')
      .replace('join(root, "plugins/agent-proxy/src")', 'join(scratch, "sources/agent-proxy/src")')
      .replace('await execute("proto", ["run", "bun", "--", "packages/build/src/build.ts", source], {\n    cwd: root,\n    timeout: 120_000,\n  });',
        'await execute(process.env.TOKAMAK_TEST_BUN!, [join(sdkModules, "@tokamak/build/src/build.ts"), source],\n    { timeout: 120_000 });')
      .replace('  await buildPlugins();\n  const target = join(root, "target");\n  await mkdir(target, { recursive: true });\n', "")
      .replace('mkdtemp(join(target, "agent-proxy-sign-in-"))', 'mkdtemp(join(scratch, "agent-proxy-sign-in-"))')
      .replace('join(root, "plugins", id, "dist")', 'join(scratch, "sources", id, "dist")');
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
    ["packages/runner/tests/", "tests/runner/"],
    ["e2e/", "tests/e2e/"],
  ];
  const sources = [
    roots[0][0], ...serverTests.map((name) => roots[1][0] + name),
    ...runnerTests.map((name) => roots[2][0] + name), starter, ...browserTests, routing,
  ];
  const files = listed(checkout, "--cached", "--", ...sources);
  for (const name of sources) {
    if (!files.some((file) => file === name || file.startsWith(name.endsWith("/") ? name : name + "/"))) {
      throw new Error(`${checkout} has no tracked ${name}`);
    }
  }
  for (const from of files) {
    const path = from === routing ? "tests/support/routing.mjs" : from === starter ? "tests/starter.mjs" : roots.reduce(
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
      if (/^plugins\/agent-proxy\/tests\/(?:workspace\.ts|addresses\.test\.ts)$/.test(path) || /^plugins\/(claude|codex)\/tests\/.*\.mjs$/.test(path)) {
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
