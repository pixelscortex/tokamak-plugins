import { createServer } from "node:http";
import { expect, test } from "vitest";
import type { Addresses } from "../src/server/addresses";
import { claude } from "../src/server/claude";
import { openai } from "../src/server/openai";
import { syntheticJwt } from "./fake-companies/oauth";

// A plan is only shown when the company named it. An answer that carries no
// plan field (a profile without `organization_type` or `has_claude_*`, an ID
// token without `chatgpt_plan_type`) is "unknown", never "Free" by guess: a
// person on Max must not be told they are on Free because a field went missing.

/** A company that answers every request with `body` and HTTP 200. */
async function answering(body: unknown) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const addresses = {
    anthropic: { authorize: url, token: url, api: url },
    openai: { authorize: url, token: url, api: url },
  } as Addresses;
  return { addresses, stop: () => new Promise<void>((done) => server.close(() => done())) };
}
const login = (idToken?: string) => ({
  login: { access: "a", ...(idToken && { idToken }) },
  identity: {},
});

test("Claude: a profile without plan fields leaves the plan unknown; one with them names it, Free included", async () => {
  const bare = await answering({ account: { uuid: "u1", email: "you@example.test" } });
  try {
    expect(await claude.details(bare.addresses, login())).toMatchObject({ plan: "", planKnown: false });
  } finally {
    await bare.stop();
  }
  const free = await answering({ account: { uuid: "u1", has_claude_max: false, has_claude_pro: false } });
  try {
    expect(await claude.details(free.addresses, login())).toMatchObject({ plan: "Free", planKnown: true });
  } finally {
    await free.stop();
  }
});

test("ChatGPT: an ID token without chatgpt_plan_type leaves the plan unknown", async () => {
  const company = await answering({ models: [] });
  try {
    const idToken = syntheticJwt({
      email: "you@example.test",
      "https://api.openai.com/auth": { chatgpt_account_id: "ws-1", chatgpt_user_id: "user-1" },
    });
    expect(await openai.details(company.addresses, login(idToken))).toMatchObject({
      plan: "",
      planKnown: false,
      identity: { workspace: "ws-1" },
    });
  } finally {
    await company.stop();
  }
});

test("ChatGPT, later from a stored login: no ID token, the workspace from the account, the plan from the accounts check", async () => {
  // The map form of /wham/accounts/check, one of the two Codex reads.
  const company = await answering({
    accounts: { "ws-1": { account: { account_id: "ws-1", name: "Acme", plan_type: "business" } } },
    account_ordering: ["ws-1"],
  });
  try {
    expect(
      await openai.details(company.addresses, { login: { access: "a" }, identity: { workspace: "ws-1" } }),
    ).toMatchObject({
      plan: "Business",
      planKnown: true,
      identity: { workspace: "ws-1", organization: "Acme" },
    });
  } finally {
    await company.stop();
  }
});
