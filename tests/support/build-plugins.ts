import { spawnSync } from "node:child_process";
import { cp, mkdir, symlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const modules = join(repo, "node_modules");
const omitted = new Set(["dist", "node_modules", ".tokamak", "target"]);

export async function copyPluginSources(sources: string, ids: readonly string[]) {
  await mkdir(sources, { recursive: true });
  for (const id of ids) {
    const folder = join(sources, id);
    await cp(join(repo, "plugins", id), folder, {
      recursive: true,
      filter: (path) => !omitted.has(basename(path)),
    });
    await symlink(modules, join(folder, "node_modules"), "dir");
  }
}

export function buildPlugin(folder: string, bun = process.env.TOKAMAK_TEST_BUN ?? process.execPath) {
  const result = spawnSync(bun, [join(modules, "@tokamak/build/src/build.ts"), folder], {
    cwd: repo,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not build plugin at ${folder}: ${result.signal ?? result.status}`);
}

export async function buildPluginsIn(sources: string, ids: readonly string[]) {
  await copyPluginSources(sources, ids);
  for (const id of ids) buildPlugin(join(sources, id));
}
