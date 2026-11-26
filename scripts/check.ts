/**
 * Type-checks every plugin: its server part, its window part and its
 * descriptor, using the same configs the editor reads, including tests. `bun run check`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const tsc = join(repo, "node_modules/typescript/bin/tsc");
if (!existsSync(tsc)) {
  console.error("check: TypeScript is not linked. Run ./setup.sh first.");
  process.exit(1);
}
let failed = false;
for (const id of readdirSync(join(repo, "plugins")).sort()) {
  for (const project of ["tsconfig.json", "src/server/tsconfig.json", "src/client/tsconfig.json", "tests/tsconfig.json"]) {
    const path = join(repo, "plugins", id, project);
    if (!existsSync(path)) continue;
    const result = spawnSync(process.execPath, [tsc, "--noEmit", "-p", path], { stdio: "inherit" });
    console.log(`${result.status === 0 ? "ok    " : "FAILED"} plugins/${id}/${project}`);
    failed ||= result.status !== 0;
  }
}
process.exit(failed ? 1 : 0);
