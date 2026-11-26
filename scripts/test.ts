/** Runs the unit tests declared by each plugin in folder order. */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const plugins = join(repo, "plugins");
if (!existsSync(join(repo, "node_modules/vitest/vitest.mjs"))) {
  console.error("test: Vitest is not linked. Run ./setup.sh first.");
  process.exit(1);
}

let failed = false;
for (const id of readdirSync(plugins).sort()) {
  const folder = join(plugins, id);
  const manifest = Bun.file(join(folder, "package.json"));
  if (!(await manifest.exists())) continue;
  if (!(await manifest.json()).scripts?.test) {
    console.log(`skip   plugins/${id} (no unit tests)`);
    continue;
  }
  const result = spawnSync(process.execPath, ["run", "test"], { cwd: folder, stdio: "inherit" });
  console.log(`${result.status === 0 ? "ok    " : "FAILED"} plugins/${id}`);
  failed ||= result.status !== 0;
}
process.exit(failed ? 1 : 0);
