// Private desktop-style Runner on a disposable workspace, for test clients.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runnerLauncher } from "../../node_modules/@tokamak/runtime/js/runner";

export async function startRunner({
  binary,
  plugins,
  directory,
  env,
  onClosedFrame,
}: {
  binary: string;
  plugins: string;
  directory: string;
  env?: NodeJS.ProcessEnv;
  onClosedFrame?: Parameters<typeof runnerLauncher>[1];
}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const child = spawn(binary, ["--desktop", "--data", join(directory, "store"), "--plugins", plugins], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const lines = createInterface({ input: child.stdout });
  let stopping: Promise<number | null> | undefined;
  function stop() {
    if (stopping) return stopping;
    child.stdin.end();
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    return (stopping = exited.finally(() => {
      clearTimeout(deadline);
      lines.close();
    }));
  }

  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const ws = await Promise.race([
      new Promise<string>((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Runner readiness timed out")), 30_000);
        lines.on("line", (line) => {
          const match = /^Tokamak listening on (ws:\/\/127\.0\.0\.1:\d+\/ws)$/.exec(line);
          if (match) resolve(match[1]);
          else if (line.startsWith("Tokamak store busy: ")) reject(new Error(line));
        });
        child.stdin.write(token + "\n");
      }),
      exited.then((status) => {
        throw new Error(`Runner exited before readiness: ${status}`);
      }),
    ]);
    const endpoint = { ws, http: new URL(ws).origin.replace(/^ws:/, "http:"), token };
    return { endpoint, launch: runnerLauncher(async () => endpoint, onClosedFrame), exited, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
