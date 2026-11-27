// The browser suite installs only fake agent providers.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const directory = await mkdtemp(join(process.env.TOKAMAK_TEST_TEMP!, "serve-"));
try {
  const child = spawn(
    process.env.TOKAMAK_TEST_SERVER_BIN!,
    [
      "--local-dir",
      process.env.TOKAMAK_SERVER_DIR!,
      "--data",
      `${directory}/store`,
      "--listen",
      "127.0.0.1:43123",
      "--plugins",
      process.env.TOKAMAK_PLUGIN_DIR!,
    ],
    {
      // The server treats stdin closing as its parent going away.
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  process.exitCode = await new Promise<number>((done) => child.on("exit", (code) => done(code ?? 1)));
} finally {
  await rm(directory, { recursive: true, force: true });
}
