import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
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

// Skip Moon tasks and tests that require Tokamak's test server, real CLIs, or another plugin's private files.
const EXCLUDE = [
  /(?:^|\/)moon\.yml$/,
  /^agent-proxy\/tests\/(?:workspace\.ts|(?:addresses|chatgpt-sign-in|manage-companies|manage|sign-in|proxy|cli)\.test\.ts|cli-sandbox\.ts)$/,
  /^ai\/tests\/agent-row\.test\.tsx$/,
  /^ai-profiles\/tests\/(?:profiles-server\.test\.ts|thread-profile\.test\.tsx)$/,
  /^claude\/tests\/[^/]+\.mjs$/,
  /^codex\/tests\/e2e\.mjs$/,
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

function main(): void {
  const args = process.argv.slice(2);
  const ids = args.length ? [...new Set(args)] : [...designNotes.keys()];
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
      return [{ from, to, mode: stat.mode & 0o777 }];
    });
    return { id, copies, stale: stale.map(destination), design, designPath: destination(designPath) };
  });

  for (const { id, copies, stale, design, designPath } of plans) {
    for (const path of stale) {
      if (existsSync(path)) unlinkSync(path);
    }
    for (const { from, to, mode } of copies) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      chmodSync(to, mode);
    }
    if (design !== null) writeFileSync(designPath, design);
    console.log(`  ${id}: ${copies.length} files copied, ${stale.length} removed`);
  }
  console.log(`Synced from Tokamak commit: ${commit}`);
}

try {
  main();
} catch (error) {
  console.error(`sync: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
