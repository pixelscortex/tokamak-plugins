import { createInterface } from "node:readline/promises";
import { companyAddresses } from "../../src/server/addresses";
import { exchangeBody, signInLink } from "./oauth";
import { createRecorder } from "./recorder";

async function record() {
  const company = process.argv[2];
  if (company !== "anthropic" && company !== "openai") {
    throw new Error("Usage: record.ts <anthropic|openai> [new-fixture.json]");
  }
  const addresses = (await companyAddresses({ env: async () => null }))[company];
  const flow = signInLink(company, addresses.authorize);
  console.log(flow.link.href);
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let pasted: string;
  try {
    pasted = (
      await input.question("Complete browser consent, then paste the code or full callback URL: ")
    ).trim();
  } finally {
    input.close();
  }
  const recorder = createRecorder();
  const exchange = await recorder.fetch(addresses.token, exchangeBody(company, pasted, flow));
  if (!exchange.ok) throw new Error(`Token exchange failed (HTTP ${exchange.status})`);
  const { access_token, id_token } = (await exchange.json()) as { access_token?: string; id_token?: string };
  if (!access_token) throw new Error("The response did not contain a login");
  const headers: Record<string, string> = {
    authorization: `Bearer ${access_token}`,
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  const prompt = "Say hello in two words.";
  const anthropic = company === "anthropic";
  if (anthropic) {
    headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
    headers["anthropic-version"] = "2023-06-01";
  } else {
    const claims = JSON.parse(Buffer.from(id_token?.split(".")[1] ?? "", "base64url").toString("utf8"));
    const account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof account !== "string") throw new Error("The login did not contain a ChatGPT account ID");
    headers["chatgpt-account-id"] = account;
  }
  const response = await recorder.fetch(addresses.api + (anthropic ? "/v1/messages" : "/codex/responses"), {
    method: "POST",
    headers,
    body: JSON.stringify(
      anthropic
        ? {
            model: process.env.TOKAMAK_RECORD_MODEL ?? "claude-sonnet-4-6",
            max_tokens: 32,
            messages: [{ role: "user", content: prompt }],
            stream: true,
          }
        : {
            model: process.env.TOKAMAK_RECORD_MODEL ?? "gpt-5.5",
            instructions: "Answer briefly.",
            input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
            stream: true,
            store: false,
          },
    ),
  });
  await response.text();
  if (!response.ok) throw new Error(`Turn failed (HTTP ${response.status}); no fixture was written`);
  await recorder.save(process.argv[3] ?? `${company}-fixture.json`);
}

try {
  await record();
} catch {
  // Upstream failures and pasted text can include a login. Never print them.
  console.error("Recording failed. Check the provider, callback, account access, and unused output path.");
  process.exitCode = 1;
}
