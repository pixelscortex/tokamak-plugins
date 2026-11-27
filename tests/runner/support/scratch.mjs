// Test artifacts may include symlinks into node_modules. Remove the link,
// never its target.
import { readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export async function cleanScratch(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await cleanScratch(path);
    else await unlink(path);
  }
  await rmdir(dir);
}
