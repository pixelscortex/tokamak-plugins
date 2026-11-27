import { chmod, cp, mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { bunPath, workspace } from "../../fake-agent/harness.mjs";

import { buildPluginsIn } from "../../support/build-plugins.ts";

const quoted = (text) => "'" + text.replaceAll("'", "'\\''") + "'";

/** Production agent bundles and deterministic stand-ins for the two CLIs. */
export async function prepareReplayAgents(
  scratch,
  { code = false, artifacts = process.env.TOKAMAK_AGENT_FIXTURES } = {},
) {
  const plugins = join(scratch, "plugins");
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  await Promise.all([mkdir(home), mkdir(bin, { mode: 0o755 }), mkdir(plugins)]);
  const ids = ["chat", "ai", "claude", "codex", ...(code ? ["code"] : [])];
  const sources = join(scratch, "sources");
  let built = false;
  for (const id of ids) {
    const cached = artifacts && join(artifacts, id);
    if (cached && (await Bun.file(join(cached, "manifest.json")).exists())) {
      await cp(cached, join(plugins, id), { recursive: true });
    } else {
      if (!built) {
        await buildPluginsIn(sources, ids);
        built = true;
      }
      await cp(join(sources, id, "dist"), join(plugins, id), { recursive: true });
    }
  }
  const bun = quoted(bunPath());
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh
exec ${bun} ${quoted(join(workspace, "plugins/claude/tests/replay.mjs"))} "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "codex"),
    `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 0.170.0' ;;
  app-server)
    if [ "$PWD" -ef "$HOME" ] || [ "$PWD/home" -ef "$HOME" ]; then tape=info; else
      tape="\${PWD##*/}"
      printf '%s' "$$" > codex.pid
    fi
    exec ${bun} ${quoted(join(workspace, "tests/fake-agent/program.mjs"))} --replay "codex/$tape"
    ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  // The Runner refuses to execute a writable shim or a shim in a writable
  // directory; explicitly make fixtures executable even with a strict umask.
  await Promise.all([chmod(join(bin, "claude"), 0o755), chmod(join(bin, "codex"), 0o755)]);
  return {
    plugins,
    env: {
      HOME: home,
      PATH: [bin, dirname(bunPath()), "/usr/bin", "/bin"].join(delimiter),
    },
  };
}
