import { createServer } from "node:http";
import { expect, test } from "vitest";
import type { Addresses } from "../src/server/addresses";
import { SignInError } from "../src/server/company";
import { details, exchange, readPasted, renew } from "../src/server/openai";
import { syntheticJwt } from "./fake-companies/oauth";

// The parts of ChatGPT's sign-in that the real server test cannot reach with
// the fake: what a person may paste, and answers the fake never gives.

test("a paste is read as CLIProxyAPI reads a callback, and a bare code is refused for want of its state", () => {
  const base = "http://localhost:1455/auth/callback";
  const read = { code: "abc", state: "xyz" };
  expect(readPasted(`${base}?code=abc&state=xyz`)).toEqual(read);
  // Copied from the address bar without the scheme, or only the query.
  expect(readPasted(`localhost:1455/auth/callback?code=abc&state=xyz`)).toEqual(read);
  expect(readPasted(`?code=abc&state=xyz`)).toEqual(read);
  expect(readPasted(`code=abc&state=xyz`)).toEqual(read);
  expect(readPasted(`${base}#code=abc&state=xyz`)).toEqual(read);
  // ChatGPT may append an onboarding entry point to the state (Codex accepts it).
  expect(readPasted(`${base}?code=abc&state=xyz.onboarding_entrypoint%3Dlife_sciences`)).toEqual(read);
  for (const wrong of ["", "abc", `${base}?code=abc`, `${base}?error=access_denied`])
    expect(readPasted(wrong)).toHaveProperty("error");
});

test("an error return keeps its state, so it is checked first, and is worded as Codex words it", () => {
  const base = "http://localhost:1455/auth/callback";
  // Codex's own case: the workspace has not enabled Codex for this person.
  expect(
    readPasted(`${base}?error=access_denied&error_description=missing_codex_entitlement&state=xyz`),
  ).toEqual({
    refused: "Codex is not enabled for your workspace. Ask your workspace administrator to enable it.",
    state: "xyz",
  });
  // Any other error names its code (as a short token) and sends the person back to the page.
  expect(readPasted(`${base}?error=access_denied&state=xyz`)).toEqual({
    refused: "ChatGPT refused the sign-in (access_denied). Open the sign-in page again.",
    state: "xyz",
  });
  expect(readPasted(`${base}?error=%3Cscript%3E%2F..&state=xyz`)).toMatchObject({
    refused: expect.stringMatching(/^ChatGPT refused the sign-in \(script\.\.\)/),
  });
});

/** A company that answers every request with `answer`, and remembers what it was sent. */
async function endpoint(
  answer: (path: string) => { status: number; body: string; headers?: Record<string, string> },
) {
  const seen: { path: string; headers: Record<string, unknown>; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ path: request.url ?? "", headers: request.headers, body });
      const { status, body: text, headers } = answer(request.url ?? "");
      response.writeHead(status, headers);
      response.end(text);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  const addresses = {
    anthropic: { authorize: url, token: url, api: url },
    openai: { authorize: url, token: url, api: url },
  } as Addresses;
  return { addresses, seen, stop: () => new Promise<void>((done) => server.close(() => done())) };
}

test("only a definite refusal signs out: 401, a 400 invalid_grant, or Codex's refresh-token codes", async () => {
  const cases: [number, unknown, Record<string, string>, unknown][] = [
    [401, {}, {}, { kind: "refused" }],
    [400, { error: "invalid_grant" }, {}, { kind: "refused" }],
    [403, { error: { code: "refresh_token_reused" } }, {}, { kind: "refused" }],
    [400, { code: "REFRESH_TOKEN_EXPIRED" }, {}, { kind: "refused" }],
    // A 400 for any other reason, a 403 or a 5xx may pass: Codex calls them transient.
    [400, { error: "invalid_request" }, {}, { kind: "later" }],
    [403, {}, {}, { kind: "later" }],
    [503, {}, {}, { kind: "later" }],
    [429, {}, { "retry-after": "120" }, { kind: "later", afterMs: 120_000 }],
  ];
  for (const [status, body, headers, expected] of cases) {
    const company = await endpoint(() => ({ status, headers, body: JSON.stringify(body) }));
    try {
      expect(await renew(company.addresses, "r")).toEqual(expected);
    } finally {
      await company.stop();
    }
  }
});

test("a renewal without a new refresh or ID token keeps the old refresh token and leaves the ID token out", async () => {
  const company = await endpoint(() => ({
    status: 200,
    body: JSON.stringify({ access_token: "a2", expires_in: 60 }),
  }));
  try {
    const answer = await renew(company.addresses, "r1");
    expect(answer).toMatchObject({ kind: "renewed", login: { access: "a2", refresh: "r1" } });
    expect(answer.kind === "renewed" && "idToken" in answer.login).toBe(false);
    // Codex's renewal: JSON, with the reason it gives.
    expect(JSON.parse(company.seen[0]!.body)).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: "r1",
      refresh_reason: "proactive_expiry",
    });
  } finally {
    await company.stop();
  }
});

test("a JWT access token's own exp sets the expiry, as Codex reads it, over expires_in", async () => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const company = await endpoint(() => ({
    status: 200,
    body: JSON.stringify({ access_token: syntheticJwt({ exp }), refresh_token: "r2", expires_in: 86_400 }),
  }));
  try {
    const answer = await renew(company.addresses, "r1");
    expect(answer).toMatchObject({ kind: "renewed", login: { expiresAt: exp * 1000, refresh: "r2" } });
  } finally {
    await company.stop();
  }
});

test("an exchange without an ID token is refused: without it no workspace is known", async () => {
  const company = await endpoint(() => ({
    status: 200,
    body: JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 60 }),
  }));
  try {
    const failure = await exchange(company.addresses, { code: "c", state: "s" }, "v").catch((error) => error);
    expect(failure).toBeInstanceOf(SignInError);
    expect(failure).toMatchObject({ kind: "Refused" });
  } finally {
    await company.stop();
  }
});

test("the plan is Codex's name for the claim, and a model hidden from Codex's picker is left out", async () => {
  const company = await endpoint((path) => ({
    status: 200,
    body: JSON.stringify(
      path.startsWith("/codex/models")
        ? {
            models: [
              { slug: "gpt-5", display_name: "GPT-5", visibility: "list" },
              { slug: "internal", display_name: "Internal", visibility: "hide" },
            ],
          }
        : { accounts: [{ id: "ws-1", name: "Acme" }] },
    ),
  }));
  try {
    const idToken = syntheticJwt({
      email: "you@acme.test",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "ws-1",
        chatgpt_plan_type: "business",
        chatgpt_user_id: "user-1",
      },
    });
    const found = await details(company.addresses, {
      login: { access: "a", idToken },
      identity: {},
    });
    expect(found).toEqual({
      plan: "Business",
      planKnown: true,
      identity: { accountId: "user-1/ws-1", email: "you@acme.test", organization: "Acme", workspace: "ws-1" },
      models: [{ id: "gpt-5", name: "GPT-5" }],
    });
  } finally {
    await company.stop();
  }
});
