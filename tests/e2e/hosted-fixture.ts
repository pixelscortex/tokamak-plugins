import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";


export async function startHostedFixture({
  port,
  ownerKey,
  extraPlugins = [],
}: {
  port: number;
  ownerKey: string;
  extraPlugins?: readonly string[];
}) {
  const directory = await mkdtemp(join(process.env.TOKAMAK_TEST_TEMP!, "serve-hosted-"));
  try {
    await mkdir(`${directory}/plugins`);
    for (const id of ["fixture", "fixture-sign-in", ...extraPlugins]) {
      await cp(`${process.env.TOKAMAK_PLUGIN_DIR}/${id}`, `${directory}/plugins/${id}`, { recursive: true });
    }
    const child = spawn(
      process.env.TOKAMAK_TEST_SERVER_BIN!,
      [
        "--web",
        process.env.TOKAMAK_E2E_WEB_ROOT!,
        "--data",
        `${directory}/store`,
        "--listen",
        `127.0.0.1:${port}`,
        "--plugins",
        `${directory}/plugins`,
      ],
      {
        stdio: ["pipe", "pipe", "inherit"],
        env: {
          ...process.env,
          TOKAMAK_ACCESS_TOKEN: ownerKey,
        },
      },
    );
    const lines = createInterface({ input: child.stdout });
    const exited = new Promise<number>((done) => {
      child.once("exit", (code) => done(code ?? 1));
      child.once("error", () => done(1));
    }).finally(async () => {
      lines.close();
      await rm(directory, { recursive: true, force: true });
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<string>((done, fail) => {
      lines.on("line", (line) => {
        const match = /^Tokamak listening on ws:\/\/(127\.0\.0\.1:\d+)\/ws/.exec(line);
        if (match) done(`http://${match[1]}`);
      });
      void exited.then(() => fail(new Error("Shared server exited before readiness")), fail);
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        void exited.then(() => fail(new Error("Shared server did not start")), fail);
      }, 15_000);
    });
    const url = await ready.finally(() => clearTimeout(timeout));
    return { url, ownerKey, exited, stop: () => child.kill("SIGTERM") };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
