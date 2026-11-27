import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { syntheticJwt } from "./fake-companies/oauth";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { blockingProxy, cliEnvironment, empty, run } from "./cli-sandbox";
import { startFakeCompanies } from "./fake-companies";

async function appServer(home: string, env: NodeJS.ProcessEnv, prompt: string) {
  const child = spawn("codex", ["app-server"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const exited = new Promise<number | null>((done) => child.once("close", done));
  const send = (method: string, params?: object, id?: number) =>
    child.stdin.write(JSON.stringify({ method, params, id }) + "\n");
  let stdout = "";
  let stderr = "";
  let code = 1;
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const result = new Promise<void>((done) => {
      void exited.then(() => done());
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "item/completed" && message.params.item.type === "agentMessage")
          stdout += message.params.item.text;
        if (message.method === "error") stderr += `${message.params?.error?.message ?? "App-server error"}\n`;
        if (message.error) return done();
        if (message.id === 1) {
          send("initialized");
          send(
            "thread/start",
            { cwd: home, approvalPolicy: "never", sandbox: "read-only", ephemeral: true },
            2,
          );
        } else if (message.id === 2) {
          send(
            "turn/start",
            {
              threadId: message.result.thread.id,
              input: [{ type: "text", text: prompt, text_elements: [] }],
            },
            3,
          );
        } else if (message.method === "turn/completed") {
          code = message.params.turn.status === "completed" ? 0 : 1;
          done();
        }
      });
    });
    send("initialize", { clientInfo: { name: "fixture-probe", version: "0.1.0" } }, 1);
    await result;
  } finally {
    lines.close();
    child.stdin.end();
    await exited;
    clearTimeout(timeout);
  }
  return { code, stdout, stderr };
}

async function loopbackTls(home: string) {
  const key = join(home, "loopback-key.pem");
  const cert = join(home, "loopback.pem");
  const config = join(home, "openssl.cnf");
  await writeFile(config, "[req]\ndistinguished_name=dn\n[dn]\n[tls]\nsubjectAltName=IP:127.0.0.1\n");
  await promisify(execFile)(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-config",
      config,
      "-extensions",
      "tls",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { cwd: home },
  );
  return { key: await readFile(key), cert: await readFile(cert), path: cert };
}

for (const variant of ["claude", "codex", "codex-app-server"] as const) {
  const cli = variant === "claude" ? "claude" : "codex";
  test(`${variant} completes a turn using a path-prefixed base URL`, { timeout: 45_000 }, async (context) => {
    const home = await mkdtemp(join(tmpdir(), "fake-company-cli-"));
    let fake: Awaited<ReturnType<typeof startFakeCompanies>> | undefined;
    const proxy = await blockingProxy();
    try {
      const env = cliEnvironment(home, proxy.url);
      let version;
      try {
        version = await run(cli, ["--version"], home, env);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const reason = `${cli} is not installed (not found on PATH)`;
        console.log(`Skipping: ${reason}`);
        context.skip(reason);
        return;
      }
      expect(version.code).toBe(0);
      console.log(`${variant}: ${version.stdout.trim()}`);
      let tls;
      try {
        if (variant === "codex-app-server") tls = await loopbackTls(home);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        console.log("Skipping: openssl is required for the isolated Codex HTTPS probe");
        context.skip("openssl is not installed");
        return;
      }
      fake = await startFakeCompanies({ tls });
      const account = fake.addAccount(cli === "claude" ? "anthropic" : "openai", cli, {
        strict: variant === "codex-app-server",
      });
      const base = `${fake.address}/plugins/agent-proxy/ACME`;
      const prompt = "Say hello in two words.";
      let result;
      if (cli === "claude") {
        result = await run(
          cli,
          ["--bare", "-p", "--tools", "", "--model", "claude-sonnet-4-6", "--no-session-persistence", prompt],
          home,
          {
            ...env,
            ANTHROPIC_BASE_URL: base,
            ANTHROPIC_API_KEY: account.accessToken,
          },
        );
      } else if (variant === "codex-app-server") {
        await writeFile(
          join(home, "config.toml"),
          `
model = "gpt-5"
openai_base_url = "${base}/backend-api/codex"
chatgpt_base_url = "${base}/backend-api"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
[features]
apps = false
plugins = false
[analytics]
enabled = false
`,
        );
        const idToken = syntheticJwt({
          email: "fixture@example.test",
          "https://api.openai.com/auth": { chatgpt_account_id: account.id, chatgpt_plan_type: "plus" },
        });
        await writeFile(
          join(home, "auth.json"),
          JSON.stringify({
            auth_mode: "chatgpt",
            OPENAI_API_KEY: null,
            last_refresh: new Date().toISOString(),
            tokens: {
              id_token: idToken,
              access_token: account.accessToken,
              refresh_token: account.refreshToken,
              account_id: account.id,
            },
          }),
          { mode: 0o600 },
        );
        result = await appServer(
          home,
          {
            ...env,
            CODEX_REFRESH_TOKEN_URL_OVERRIDE: fake.addresses.openai.token,
            CODEX_CA_CERTIFICATE: tls!.path,
          },
          prompt,
        );
      } else {
        await writeFile(
          join(home, "config.toml"),
          `
model = "gpt-5"
model_provider = "fixture"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"

[model_providers.fixture]
name = "Fixture"
base_url = "${base}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`,
        );
        result = await run(
          cli,
          ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", prompt],
          home,
          {
            ...env,
            OPENAI_API_KEY: account.accessToken,
          },
        );
      }
      for (const { method, path, headers, body } of fake.requests) {
        // Header names are useful even when the values contain device/session IDs.
        const safe = Object.fromEntries(
          Object.entries(headers).map(([key, value]) => [
            key,
            /authorization|api-key|cookie|token/i.test(key)
              ? "[masked]"
              : /^(accept|content-type|content-encoding|user-agent|anthropic-version|anthropic-beta)$/.test(
                    key,
                  )
                ? value
                : "[present]",
          ]),
        );
        const shape =
          body && typeof body === "object"
            ? Object.fromEntries(
                Object.entries(body).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
                ]),
              )
            : typeof body;
        console.log(`${method} ${path} headers=${JSON.stringify(safe)} body=${JSON.stringify(shape)}`);
      }
      console.log(`Blocked outbound hosts: ${JSON.stringify(proxy.attempts)}`);
      expect(result.code, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain("Fake reply.");
      const endpoint =
        cli === "claude"
          ? "/v1/messages"
          : variant === "codex-app-server"
            ? "/backend-api/codex/responses"
            : "/responses";
      expect(
        fake.requests.some(
          ({ method, account, path }) =>
            method === "POST" &&
            account === cli &&
            path.split("?")[0] === `/plugins/agent-proxy/ACME${endpoint}`,
        ),
        `Missing authenticated POST to the prefixed ${endpoint} endpoint`,
      ).toBe(true);
    } finally {
      proxy.stop();
      await fake?.stop();
      await empty(home);
    }
  });
}
