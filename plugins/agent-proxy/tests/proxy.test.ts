import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createApi, type FunctionReference, type TokamakClient } from "@tokamak/sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { blockingProxy, cliEnvironment, empty, run } from "./cli-sandbox";
import { startFakeCompanies } from "./fake-companies";
import { turn } from "./fake-companies/stream";
import { builds, startWorkspace, type Workspace } from "./workspace";

type Ref<K extends "action" | "mutation" | "query", A, R> = FunctionReference<K, A, R>;
type Company = "anthropic" | "openai";
type Set = { set: string };
type Key = { key: string };
type Address = Key & { address: string };
type Id = { id: string };
type Subscription = Id & { accounts: Id[]; lastUsedAt?: number; status: string };
type Failure = { failed: true; kind: string };
const api = createApi<{
  turns: {
    register: Ref<"mutation", { set?: string; subscriptions: string[] }, Set | Failure>;
    key: Ref<"action", Set & { company?: Company }, Address | Failure>;
    remove: Ref<"mutation", Set, null | Failure>;
    end: Ref<"mutation", Key, null>;
  };
}>("turn-caller", ["turns:register", "turns:key", "turns:end", "turns:remove"]);
const profiles = createApi<{
  subscriptions: {
    startSignIn: Ref<"action", { company: Company; method: "subscription" }, Id & { link: string }>;
    finishSignIn: Ref<"action", Id & { pasted: string }, Subscription>;
    setEnabled: Ref<"mutation", Id & { enabled: boolean }, null>;
    list: Ref<"query", Record<string, never>, { subscriptions: Subscription[] }>;
  };
  manage: { signOut: Ref<"mutation", Id, null> };
}>("ai-profiles", [
  "subscriptions:startSignIn",
  "subscriptions:finishSignIn",
  "subscriptions:setEnabled",
  "subscriptions:list",
  "manage:signOut",
]);

const model = "claude-sonnet-4-6";
const body = `{ "model": "${model}",\n  "stream": true, "messages": [{"role":"user","content":"héllo"}] }\n`;
const stream = (address: Address, path = "/v1/messages", apiKey = false, signal?: AbortSignal) =>
  fetch(address.address + path, {
    method: "POST",
    body,
    signal,
    headers: {
      [apiKey ? "x-api-key" : "authorization"]: apiKey ? address.key : `Bearer ${address.key}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219",
      "x-stainless-lang": "js",
      "x-claude-test": "unchanged",
      cookie: "private=local",
      forwarded: "for=192.0.2.42",
      "x-forwarded-for": "192.0.2.42",
      "x-forwarded-host": "private.example.test",
      "x-real-ip": "192.0.2.42",
      "cf-connecting-ip": "192.0.2.42",
      "true-client-ip": "192.0.2.42",
      "x-test-header": "unrelated",
    },
  });
const rejected = async (response: Response, status: number, message: string) => {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { message } });
};

const available = builds();
// Without a server build the suites below register nothing, and Vitest fails a file with no tests.
if (!available.length) test.skip("needs the Runner or Server build", () => {});
if (!available.length) console.log("Skipping: build both server binaries and plugin hosts to test the proxy");

describe.skipIf(!available.length).each(available)("Subscription proxy on the $name", (build) => {
  let fake: Awaited<ReturnType<typeof startFakeCompanies>>;
  let workspace: Workspace;
  let client: TokamakClient;
  const secrets: string[] = [];

  beforeAll(async () => {
    fake = await startFakeCompanies({ delayMs: 70 });
    workspace = await startWorkspace(build, fake.addresses, { turnCaller: true });
    client = await workspace.owner();
  }, 300_000);

  afterAll(async () => {
    const output = workspace?.output() ?? "";
    await workspace?.stop();
    await fake?.stop();
    for (const secret of secrets) expect(output.includes(secret)).toBe(false);
  });

  async function signIn(id: string, expired = false, as = client, company: Company = "anthropic") {
    const account = fake.addAccount(company, id, { signIn: expired ? "expired" : "success" });
    secrets.push(account.accessToken, account.refreshToken);
    const start = await as.action(profiles.subscriptions.startSignIn, {
      company,
      method: "subscription",
    });
    fake.nextSignIn(id);
    const page = await fetch(start.link, { redirect: "manual" });
    const subscription = await as.action(profiles.subscriptions.finishSignIn, {
      id: start.id,
      pasted: page.headers.get("location")!,
    });
    expect(subscription.id).toBeDefined();
    return { account, subscription };
  }

  async function register(subscriptions: string[]) {
    const result = await client.mutation(api.turns.register, { subscriptions });
    if ("failed" in result) throw new Error(result.kind);
    return result;
  }

  async function key(set: Set, company?: Company) {
    const result = await client.action(api.turns.key, { ...set, ...(company && { company }) });
    if ("failed" in result) throw new Error(result.kind);
    secrets.push(result.key);
    return result;
  }

  const messages = () => fake.requests.filter(({ path }) => path.startsWith("/anthropic/v1/messages"));

  const signInOpenai = (id: string, expired = false) => signIn(id, expired, client, "openai");
  const responses = () =>
    fake.requests.filter(({ path }) => path.startsWith("/openai/backend-api/codex/responses"));
  const codexModel = "gpt-5-codex";
  const codexBody = `{ "model": "${codexModel}",
 "stream": true, "input": "héllo" }
`;
  const respond = (address: Address, path = "/responses") =>
    fetch(address.address + path, {
      method: "POST",
      body: codexBody,
      headers: {
        authorization: `Bearer ${address.key}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "chatgpt-account-id": "untrusted-workspace",
        "openai-beta": "responses=test",
        originator: "tokamak",
        session_id: "old-session",
        "session-id": "session",
        "thread-id": "thread",
        "x-codex-turn-state": "turn-state",
        cookie: "private=local",
        "anthropic-version": "not-openai",
        "openai-organization": "untrusted-organization",
      },
    });

  test("strips upstream cookies for both companies", async () => {
    const claude = await signIn("cookies-claude");
    const chatgpt = await signInOpenai("cookies-chatgpt");
    const set = await register([claude.subscription.id, chatgpt.subscription.id]);
    const [codex, anthropic] = await Promise.all([
      respond(await key(set, "openai"), "/responses?cookies"),
      stream(await key(set), "/v1/messages?cookies"),
    ]);
    for (const response of [codex, anthropic]) {
      expect(response.status).toBe(200);
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(response.headers.has("set-cookie2")).toBe(false);
      expect(await response.text()).toContain("Fake ");
    }
  });

  test("uses the ChatGPT usage-limit body over Retry-After and routes the next request to the spare", async () => {
    const first = await signInOpenai("limited-openai");
    const spare = await signInOpenai("spare-openai");
    const address = await key(await register([first.subscription.id, spare.subscription.id]), "openai");
    const resetAt = Math.floor(Date.now() / 1000) + 120;
    fake.script(first.account.id, [{ kind: "limit", resetAt, retryAfter: "1" }]);
    const start = responses().length;

    const capped = await respond(address);
    expect(capped.status).toBe(429);
    expect(capped.headers.get("retry-after")).toBe("1");
    expect(await capped.text()).toBe(
      JSON.stringify({
        error: { type: "usage_limit_reached", resets_at: resetAt, plan_type: "plus", message: "Fake limit" },
      }),
    );
    const next = await respond(address);
    expect(next.status).toBe(200);
    await next.text();
    expect(
      responses()
        .slice(start)
        .map(({ account }) => account),
    ).toEqual([first.account.id, spare.account.id]);

    await client.mutation(profiles.subscriptions.setEnabled, { id: spare.subscription.id, enabled: false });
    const before = Date.now();
    const held = await respond(address);
    const after = Date.now();
    await rejected(held, 429, "ChatGPT subscriptions in this set are rate limited.");
    const retry = Number(held.headers.get("retry-after"));
    expect(retry).toBeGreaterThanOrEqual(Math.ceil((resetAt * 1000 - after) / 1000));
    expect(retry).toBeLessThanOrEqual(Math.ceil((resetAt * 1000 - before) / 1000));
    expect(responses()).toHaveLength(start + 2);
  });

  test.each<{
    name: string;
    body?: string;
    headers?: Record<string, string>;
    retryAfter?: string;
    seconds: number;
  }>([
    {
      name: "relative JSON reset",
      body: JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 20 } }),
      headers: { "x-codex-primary-reset-after-seconds": "40" },
      retryAfter: "1",
      seconds: 20,
    },
    {
      name: "secondary window for an oversized body",
      body: JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 120 } }).padEnd(65_537),
      headers: {
        "x-codex-primary-reset-after-seconds": "40",
        "x-codex-secondary-reset-after-seconds": "20",
        "x-codex-secondary-used-percent": "100",
      },
      retryAfter: "1",
      seconds: 20,
    },
    { name: "Retry-After for invalid JSON", body: "invalid", retryAfter: "20", seconds: 20 },
    { name: "default without a reset", seconds: 60 },
  ])("uses the $name when ChatGPT does not give an absolute reset", async ({ name, seconds, ...reply }) => {
    const { account, subscription } = await signInOpenai(`fallback-openai-${name.split(" ")[0]}`);
    const address = await key(await register([subscription.id]), "openai");
    fake.script(account.id, [{ kind: "bare-limit", ...reply }]);
    const first = await respond(address);
    expect(first.status).toBe(429);
    const body = await first.text();
    if (reply.body !== undefined) expect(body === reply.body).toBe(true);
    const held = await respond(address);
    await rejected(held, 429, "ChatGPT subscriptions in this set are rate limited.");
    const retry = Number(held.headers.get("retry-after"));
    expect(retry).toBeGreaterThanOrEqual(seconds - 1);
    expect(retry).toBeLessThanOrEqual(seconds);
  });

  test("streams ChatGPT SSE with the selected account while Claude uses its own account in the same set", async () => {
    const claude = await signIn("mixed-claude");
    const first = await signInOpenai("mixed-openai-first");
    const second = await signInOpenai("mixed-openai-second");
    const set = await register([claude.subscription.id, first.subscription.id, second.subscription.id]);
    const [openai, anthropic] = await Promise.all([key(set, "openai"), key(set)]);
    const path = "/responses?label=a%20b&label=%2B";
    const [codex, claudeTurn] = await Promise.all([respond(openai, path), stream(anthropic)]);
    expect([codex.status, claudeTurn.status]).toEqual([200, 200]);
    expect(codex.headers.get("content-type")).toBe("text/event-stream");
    const reader = codex.body!.getReader();
    const initial = await reader.read();
    expect(initial.done).toBe(false);
    const decoder = new TextDecoder();
    let actual = decoder.decode(initial.value, { stream: true });
    expect(actual).toContain("event: response.created");
    expect(actual).not.toContain("event: response.completed");
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      actual += decoder.decode(chunk.value, { stream: true });
    }
    expect(actual + decoder.decode()).toBe(turn("openai", codexModel, false).join(""));
    expect(await claudeTurn.text()).toContain("message_stop");
    expect(messages().at(-1)?.account).toBe(claude.account.id);
    const sent = responses().at(-1)!;
    expect(sent).toMatchObject({
      method: "POST",
      path: "/openai/backend-api/codex" + path,
      rawBody: codexBody,
      account: first.account.id,
      headers: {
        authorization: `Bearer ${first.account.accessToken}`,
        "chatgpt-account-id": first.account.id,
        "openai-beta": "responses=test",
        originator: "tokamak",
        session_id: "old-session",
        "session-id": "session",
        "thread-id": "thread",
        "x-codex-turn-state": "turn-state",
      },
    });
    for (const name of ["cookie", "anthropic-version", "openai-organization", "x-api-key"])
      expect(sent.headers).not.toHaveProperty(name);
    expect(JSON.stringify(sent)).not.toContain(openai.key);
    const { subscriptions } = await client.query(profiles.subscriptions.list, {});
    expect(subscriptions.find(({ id }) => id === first.subscription.id)?.lastUsedAt).toBeGreaterThan(0);
    expect(subscriptions.find(({ id }) => id === second.subscription.id)?.lastUsedAt).toBeUndefined();

    const baseline = fake.requests.length;
    await rejected(
      await respond({ ...openai, key: anthropic.key }),
      401,
      "Turn key belongs to a different company.",
    );
    await rejected(
      await stream({ ...anthropic, key: openai.key }),
      401,
      "Turn key belongs to a different company.",
    );
    expect((await stream(openai)).status).toBe(404);
    expect((await respond(anthropic)).status).toBe(404);
    expect(
      (await fetch(openai.address + "/responses", { headers: { authorization: `Bearer ${openai.key}` } }))
        .status,
    ).toBe(404);
    for (const route of ["/models", "/responses/compact", "/v1/models"]) {
      expect((await respond(openai, route)).status).toBe(404);
    }
    await client.mutation(api.turns.end, { key: openai.key });
    await rejected(await respond(openai), 401, "Turn key has ended.");
    const onlyClaude = await key(await register([claude.subscription.id]), "openai");
    const onlyOpenai = await key(await register([first.subscription.id]));
    await rejected(await respond(onlyClaude), 403, "No usable ChatGPT subscription in this set.");
    await rejected(await stream(onlyOpenai), 403, "No usable Claude subscription in this set.");
    expect(fake.requests).toHaveLength(baseline);
  });

  test("renews an expired ChatGPT login and only replays a 401 with the rotated or next login", async () => {
    const first = await signInOpenai("codex-expired", true);
    const second = await signInOpenai("codex-fallback");
    const address = await key(await register([first.subscription.id, second.subscription.id]), "openai");
    const before = fake.requests.length;
    const initial = await respond(address);
    expect(initial.status).toBe(200);
    await initial.text();
    const rotated = first.account.accessToken;
    secrets.push(rotated, first.account.refreshToken);
    expect(fake.requests.slice(before).map(({ path, account }) => [path, account])).toEqual([
      ["/openai/oauth/token", first.account.id],
      ["/openai/backend-api/codex/responses", first.account.id],
    ]);

    first.account.rejectedAccess = { token: rotated };
    const replacement = await respond(address);
    expect(replacement.status).toBe(200);
    await replacement.text();
    expect(
      responses()
        .slice(-2)
        .map(({ headers }) => headers.authorization),
    ).toEqual([`Bearer ${rotated}`, `Bearer ${first.account.accessToken}`]);
    secrets.push(first.account.accessToken, first.account.refreshToken);

    first.account.rejectedAccess = { token: first.account.accessToken };
    first.account.signIn = "refuse-renewal";
    const fallback = await respond(address);
    expect(fallback.status).toBe(200);
    await fallback.text();
    expect(
      responses()
        .slice(-2)
        .map(({ account, rawBody }) => [account, rawBody]),
    ).toEqual([
      [first.account.id, codexBody],
      [second.account.id, codexBody],
    ]);
    const { subscriptions } = await client.query(profiles.subscriptions.list, {});
    expect(subscriptions.find(({ id }) => id === first.subscription.id)?.status).toBe("signed-out");
  });

  test("holds out ChatGPT accounts after 429 and chooses the next eligible account", async () => {
    const first = await signInOpenai("codex-capped");
    const second = await signInOpenai("codex-spare");
    const address = await key(await register([first.subscription.id, second.subscription.id]), "openai");
    fake.script(first.account.id, [{ kind: "bare-limit", retryAfter: "37" }]);
    fake.script(second.account.id, [{ kind: "bare-limit" }]);
    const before = responses().length;
    for (let i = 0; i < 2; i++) {
      const response = await respond(address);
      expect(response.status).toBe(429);
      await response.text();
    }
    const held = await respond(address);
    await rejected(held, 429, "ChatGPT subscriptions in this set are rate limited.");
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThanOrEqual(35);
    expect(Number(held.headers.get("retry-after"))).toBeLessThanOrEqual(37);
    expect(
      responses()
        .slice(before)
        .map(({ account }) => account),
    ).toEqual([first.account.id, second.account.id]);
  });

  test("fills the first account, swaps credentials, preserves the request and streams unchanged bytes", async () => {
    const { account, subscription } = await signIn("first");
    const second = (await signIn("second")).subscription;
    const set = await register([subscription.id, second.id]);
    const address = await key(set);
    expect(address.address).toMatch(/\/plugins\/agent-proxy\/[^/]+$/);
    const path = "/v1/messages?beta=true&label=a%20b&label=%2B";
    const response = await stream(address, path, true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    const decoder = new TextDecoder();
    const initial = decoder.decode(first.value, { stream: true });
    expect(first.done).toBe(false);
    expect(initial).toContain("event: message_start");
    expect(initial).not.toContain("event: message_stop");
    let result = initial;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    expect(result + decoder.decode()).toBe(turn("anthropic", model, false).join(""));
    const request = messages().at(-1)!;
    expect(request).toMatchObject({
      method: "POST",
      path: "/anthropic" + path,
      rawBody: body,
      account: account.id,
      headers: {
        authorization: `Bearer ${account.accessToken}`,
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-stainless-lang": "js",
        "x-claude-test": "unchanged",
      },
    });
    for (const name of [
      "x-api-key",
      "cookie",
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-real-ip",
      "cf-connecting-ip",
      "true-client-ip",
      "x-test-header",
    ])
      expect(request.headers).not.toHaveProperty(name);
    expect(JSON.stringify(request)).not.toContain(address.key);
    const updated = await client.query(profiles.subscriptions.list, {});
    expect(updated.subscriptions.find(({ id }) => id === subscription.id)?.lastUsedAt).toBeGreaterThan(0);
    expect(updated.subscriptions.find(({ id }) => id === second.id)?.lastUsedAt).toBeUndefined();

    await expect(
      client.mutation(api.turns.register, { ...set, subscriptions: [second.id, subscription.id] }),
    ).resolves.toEqual(set);
    const reordered = await stream(address);
    expect(reordered.status).toBe(200);
    await reordered.text();
    expect(messages().at(-1)?.account).toBe("second");

    // Forward the encoded path as received instead of reconstructing it from decoded params.
    const encoded = await fetch(address.address + "/v1/%6Dodels?limit=1", {
      headers: { "x-api-key": address.key },
    });
    await encoded.text();
    expect(fake.requests.at(-1)).toMatchObject({
      method: "GET",
      path: "/anthropic/v1/%6Dodels?limit=1",
      account: "second",
    });
  });

  test("scopes sets and key issuance and revocation to their member; rejects other-set, ended and unknown keys", async () => {
    const { subscription } = await signIn("private");
    const member = await workspace.member("proxy-member");
    const other = await signIn("member-private", false, member);
    const a = await register([subscription.id]);
    const b = await register([]);
    const first = await key(a);
    const next = await key(a);
    const elsewhere = await key(b);
    expect(first.key).not.toBe(next.key);
    expect(first.address).toBe(next.address);

    await expect(member.action(api.turns.key, a)).resolves.toMatchObject({ failed: true, kind: "NotFound" });
    await expect(member.mutation(api.turns.register, { ...a, subscriptions: [] })).resolves.toMatchObject({
      failed: true,
      kind: "NotFound",
    });
    await expect(
      client.mutation(api.turns.register, { subscriptions: [other.subscription.id] }),
    ).resolves.toMatchObject({ failed: true, kind: "NotFound" });
    await expect(
      member.mutation(api.turns.register, { subscriptions: [subscription.id] }),
    ).resolves.toMatchObject({ failed: true, kind: "NotFound" });
    await member.mutation(api.turns.end, { key: next.key });

    const count = messages().length;
    await rejected(await fetch(first.address + "/v1/models"), 401, "Missing or invalid turn key.");
    await rejected(
      await stream({ ...elsewhere, key: first.key }),
      401,
      "Turn key belongs to a different set.",
    );
    await rejected(await stream({ ...first, key: "x".repeat(43) }), 401, "Unknown turn key.");
    await client.mutation(api.turns.end, { key: first.key });
    await rejected(await stream(first), 401, "Turn key has ended.");
    expect(messages()).toHaveLength(count);
    const response = await stream(next);
    expect(response.status).toBe(200);
    await response.text();
  });

  test("skips disabled, signed out and account-limited logins without borrowing from another set", async () => {
    const disabled = (await signIn("disabled")).subscription;
    const signedOut = (await signIn("signed-out")).subscription;
    const limited = (await signIn("limited")).subscription;
    const spare = (await signIn("spare")).subscription;
    const outside = (await signIn("outside")).subscription;
    await client.mutation(profiles.subscriptions.setEnabled, { id: disabled.id, enabled: false });
    await client.mutation(profiles.manage.signOut, { id: signedOut.accounts[0]!.id });
    const a = await key(await register([disabled.id, signedOut.id, limited.id, spare.id]));
    const b = await key(await register([outside.id]));
    fake.script("limited", [{ kind: "limit", resetAt: Math.floor(Date.now() / 1000) + 60 }]);

    const start = messages().length;
    const capped = await stream(a);
    expect(capped.status).toBe(429);
    expect(capped.headers.get("anthropic-ratelimit-unified-5h-status")).toBe("rejected");
    await capped.text();
    const [first, second] = await Promise.all([stream(a), stream(b)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    await Promise.all([first.text(), second.text()]);
    expect(
      messages()
        .slice(start)
        .map(({ account }) => account)
        .sort(),
    ).toEqual(["limited", "outside", "spare"]);

    await client.mutation(profiles.subscriptions.setEnabled, { id: spare.id, enabled: false });
    const held = await stream(a);
    await rejected(held, 429, "Claude subscriptions in this set are rate limited.");
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(messages()).toHaveLength(start + 3);
  });

  test("forwards only the four Claude API routes with their expected methods", async () => {
    const { subscription } = await signIn("routes");
    const address = await key(await register([subscription.id]));
    const count = fake.requests.length;
    for (const [method, path] of [
      ["GET", "/api/oauth/profile"],
      ["POST", "/v1/files"],
      ["POST", "/v1/models"],
      ["GET", "/v1/messages"],
      ["GET", "/v1/models/claude-sonnet-4-6/files"],
    ]) {
      const response = await fetch(address.address + path, { method, headers: { "x-api-key": address.key } });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } });
    }
    expect(fake.requests).toHaveLength(count);
    const tokens = await stream(address, "/v1/messages/count_tokens");
    expect(tokens.status).toBe(200);
    expect(await tokens.json()).toEqual({ input_tokens: 8 });
    const modelDetails = await fetch(address.address + "/v1/models/" + model, {
      headers: { "x-api-key": address.key },
    });
    expect(modelDetails.status).toBe(200);
    expect(await modelDetails.json()).toMatchObject({ id: model, type: "model" });
  });

  test("concurrent upstream 401s force one renewal and replay the original request", async () => {
    const { account, subscription } = await signIn("reject-access");
    const address = await key(await register([subscription.id]));
    const before = fake.requests.length;
    const original = account.accessToken;
    account.rejectedAccess = { token: original, delayMs: 200 };
    account.tokenDelayMs = 200;
    const path = "/v1/messages?beta=true";
    const results = await Promise.all([stream(address, path), stream(address, path)]);
    expect(results.map(({ status }) => status)).toEqual([200, 200]);
    await Promise.all(results.map((result) => result.text()));
    secrets.push(account.accessToken, account.refreshToken);
    const records = fake.requests.slice(before);
    expect(records.filter(({ path }) => path.endsWith("/v1/oauth/token"))).toHaveLength(1);
    const turns = records.filter(({ path: actual }) => actual === "/anthropic" + path);
    expect(turns.map(({ headers }) => headers.authorization)).toEqual(
      [original, original, account.accessToken, account.accessToken].map((access) => `Bearer ${access}`),
    );
    expect(turns.map(({ rawBody }) => rawBody)).toEqual([body, body, body, body]);
  });

  test("a refused renewal signs out the account and replays once on the next account", async () => {
    const first = await signIn("refused-access");
    const second = await signIn("fallback-access");
    const third = await signIn("unused-access");
    const address = await key(
      await register([first.subscription.id, second.subscription.id, third.subscription.id]),
    );
    first.account.rejectedAccess = { token: first.account.accessToken };
    first.account.signIn = "refuse-renewal";
    // The retry itself also gets a 401; it must never trigger another retry or renewal.
    second.account.rejectedAccess = { token: second.account.accessToken };
    const before = fake.requests.length;
    const response = await stream(address);
    expect(response.status).toBe(401);
    await response.text();
    const records = fake.requests.slice(before);
    expect(records.map(({ path, account }) => [path, account])).toEqual([
      ["/anthropic/v1/messages", first.account.id],
      ["/anthropic/v1/oauth/token", first.account.id],
      ["/anthropic/v1/messages", second.account.id],
    ]);
    expect(records[2]?.rawBody).toBe(body);
    const { subscriptions } = await client.query(profiles.subscriptions.list, {});
    expect(subscriptions.find(({ id }) => id === first.subscription.id)).toMatchObject({
      status: "signed-out",
      reason: "Claude would not renew the login. Sign in again.",
    });
    for (const { subscription } of [first, second])
      expect(subscriptions.find(({ id }) => id === subscription.id)?.lastUsedAt).toBeUndefined();
  });

  test("an empty set returns 403 and names Claude without contacting the company", async () => {
    const address = await key(await register([]));
    const before = fake.requests.length;
    const response = await stream(address);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "permission_error", message: "No usable Claude subscription in this set." },
    });
    expect(fake.requests).toHaveLength(before);
  });

  test("holds out bare 429s and uses the earliest reset when all accounts are held out", async () => {
    const first = await signIn("bare-limit");
    const second = await signIn("retry-after-limit");
    const address = await key(await register([first.subscription.id, second.subscription.id]));
    fake.script(first.account.id, [{ kind: "bare-limit" }]);
    fake.script(second.account.id, [{ kind: "bare-limit", retryAfter: "37" }]);
    const before = messages().length;
    for (let i = 0; i < 2; i++) {
      const response = await stream(address);
      expect(response.status).toBe(429);
      await response.text();
    }
    const capped = await stream(address);
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
    expect(Number(capped.headers.get("retry-after"))).toBeGreaterThanOrEqual(35);
    expect(Number(capped.headers.get("retry-after"))).toBeLessThanOrEqual(37);
    expect(
      messages()
        .slice(before)
        .map(({ account }) => account),
    ).toEqual([first.account.id, second.account.id]);
    const { subscriptions } = await client.query(profiles.subscriptions.list, {});
    for (const { subscription } of [first, second])
      expect(subscriptions.find(({ id }) => id === subscription.id)?.lastUsedAt).toBeUndefined();
  });

  test("honors the unified rejection and reset even without a 429 or window headers", async () => {
    const first = await signIn("unified-limit");
    const second = await signIn("unified-spare");
    const address = await key(await register([first.subscription.id, second.subscription.id]));
    fake.script(first.account.id, [{ kind: "unified-limit", resetAt: Math.floor(Date.now() / 1000) + 30 }]);
    const before = messages().length;
    for (let i = 0; i < 2; i++) {
      const response = await stream(address);
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(
      messages()
        .slice(before)
        .map(({ account }) => account),
    ).toEqual([first.account.id, second.account.id]);
  });

  test("streams upstream gzip bytes and preserves content-encoding", async () => {
    const { subscription } = await signIn("gzip");
    const address = await key(await register([subscription.id]));
    // node:http exposes wire bytes; fetch would decode the response in the test client.
    const actual = await new Promise<{ encoding?: string; bytes: Buffer }>((resolve, reject) => {
      const post = request(
        address.address + "/v1/messages?gzip",
        {
          method: "POST",
          headers: {
            "x-api-key": address.key,
            "content-type": "application/json",
            "accept-encoding": "gzip",
          },
        },
        (reply) => {
          const chunks: Buffer[] = [];
          reply.on("data", (chunk) => chunks.push(chunk));
          reply.on("error", reject);
          reply.on("end", () =>
            resolve({ encoding: reply.headers["content-encoding"], bytes: Buffer.concat(chunks) }),
          );
        },
      );
      post.on("error", reject);
      post.end(body);
    });
    expect(actual.encoding).toBe("gzip");
    expect(actual.bytes).toEqual(gzipSync(turn("anthropic", model, false).join("")));
  });

  test("only the owner may remove a set, and removal invalidates its existing keys", async () => {
    const { subscription } = await signIn("remove-set");
    const set = await register([subscription.id]);
    const address = await key(set);
    const member = await workspace.member("remove-set-member");
    await expect(member.mutation(api.turns.remove, set)).resolves.toMatchObject({
      failed: true,
      kind: "NotFound",
    });
    const before = await stream(address);
    expect(before.status).toBe(200);
    await before.text();
    await expect(client.mutation(api.turns.remove, set)).resolves.toBeNull();
    await expect(client.action(api.turns.key, set)).resolves.toMatchObject({
      failed: true,
      kind: "NotFound",
    });
    const count = fake.requests.length;
    await rejected(await stream(address), 401, "Turn key has no set.");
    expect(fake.requests).toHaveLength(count);
  });

  test("concurrent requests renew an expired login once and use the renewed token", async () => {
    const { account, subscription } = await signIn("expired", true);
    account.tokenDelayMs = 150;
    const a = await key(await register([subscription.id]));
    const b = await key(await register([subscription.id]));
    const start = messages().length;
    const responses = await Promise.all([stream(a), stream(b)]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    await Promise.all(responses.map((response) => response.text()));
    const renewals = fake.requests.filter(
      (record) =>
        record.account === account.id &&
        record.path.endsWith("/v1/oauth/token") &&
        (record.body as { grant_type: string }).grant_type === "refresh_token",
    );
    secrets.push(account.accessToken, account.refreshToken);
    expect(renewals).toHaveLength(1);
    expect(
      messages()
        .slice(start)
        .map(({ headers }) => headers.authorization),
    ).toEqual([`Bearer ${account.accessToken}`, `Bearer ${account.accessToken}`]);
  });

  test("idle keys expire after a crash, activity extends a key, and age still caps it", async () => {
    // Shorten the intervals in the installed fixture, including the write debounce.
    const idle = 3_000;
    const cap = 8_000;
    const expiring = await startWorkspace(build, fake.addresses, {
      turnCaller: true,
      patches: [
        { find: "TURN_KEY_TTL_MS = 8 * 60 * 60000", replace: `TURN_KEY_TTL_MS = ${cap}` },
        { find: "TURN_KEY_IDLE_MS = 15 * 60000", replace: `TURN_KEY_IDLE_MS = ${idle}` },
        { find: "TURN_KEY_TOUCH_MS = 60000", replace: "TURN_KEY_TOUCH_MS = 100" },
      ],
    });
    try {
      const caller = await expiring.owner();
      const { subscription } = await signIn("expiry", false, caller);
      const registered = await caller.mutation(api.turns.register, { subscriptions: [subscription.id] });
      if ("failed" in registered) throw new Error(registered.kind);
      const { set } = registered;

      async function issue() {
        const address = await caller.action(api.turns.key, { set });
        if ("failed" in address) throw new Error(address.kind);
        secrets.push(address.key);
        return address;
      }
      async function accepted(address: Address) {
        const at = Date.now();
        const response = await stream(address);
        expect(response.status).toBe(200);
        await response.text();
        return at;
      }
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const unused = await issue();
      const crashed = await issue();
      const active = await issue();
      const hardDeadline = Date.now() + cap;
      await accepted(crashed);
      const idleDeadline = Date.now() + idle;
      let lastAccepted = await accepted(active);
      async function keepActiveUntil(deadline: number) {
        while (Date.now() < deadline) {
          await wait(Math.min(500, deadline - Date.now()));
          lastAccepted = await accepted(active);
        }
      }

      await keepActiveUntil(idleDeadline);
      await rejected(await stream(unused), 401, "Turn key has expired.");
      await rejected(await stream(crashed), 401, "Turn key has expired.");
      await keepActiveUntil(hardDeadline - idle / 2);
      await wait(Math.max(0, hardDeadline - Date.now()));
      await rejected(await stream(active), 401, "Turn key has expired.");
      expect(Date.now() - lastAccepted).toBeLessThan(idle); // The hard cap, not idleness.
      for (const { key } of [unused, crashed, active]) expect(expiring.output().includes(key)).toBe(false);
    } finally {
      await expiring.stop();
    }
  }, 45_000);

  test("disconnecting the client closes the upstream stream", async () => {
    const { subscription } = await signIn("disconnect");
    const address = await key(await register([subscription.id]));
    const controller = new AbortController();
    const response = await stream(address, "/v1/messages?disconnect=1", false, controller.signal);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await expect.poll(() => fake.disconnected).toContain("/anthropic/v1/messages?disconnect=1");
  });

  test(
    "installed Claude Code completes a turn with a path-prefixed base URL and a fake bearer key",
    { timeout: 45_000 },
    async (context) => {
      const home = await mkdtemp(join(tmpdir(), "tokamak-claude-proxy-"));
      const blocked = await blockingProxy();
      try {
        const env = cliEnvironment(home, blocked.url);
        let version;
        try {
          version = await run("claude", ["--version"], home, env);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return context.skip("Claude Code is not installed");
        }
        expect(version.code).toBe(0);
        const { account, subscription } = await signIn("cli");
        const address = await key(await register([subscription.id]));
        const result = await run(
          "claude",
          ["--bare", "-p", "--tools", "", "--model", model, "--no-session-persistence", "Say hello."],
          home,
          { ...env, ANTHROPIC_BASE_URL: address.address, ANTHROPIC_AUTH_TOKEN: address.key },
        );
        console.log(`Claude Code ${version.stdout.trim()}; exit ${result.code}`);
        expect(result.code, result.stderr.replaceAll(address.key, "[turn key]").slice(0, 1000)).toBe(0);
        expect(result.stdout).toContain("Fake reply.");
        expect(messages().at(-1)).toMatchObject({
          account: account.id,
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
      } finally {
        blocked.stop();
        await empty(home);
      }
    },
  );
});
