import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { exchangeBody, oauth, signInLink, syntheticJwt } from "./fake-companies/oauth";
import { startFakeCompanies } from "./fake-companies";
import { cleanFixture, createRecorder, type Fixture } from "./fake-companies/recorder";

test("both sign-in forms return a callback, reject bad codes, and let tests control expiration and renewal", async () => {
  const fake = await startFakeCompanies();
  try {
    for (const company of ["anthropic", "openai"] as const) {
      fake.addAccount(company, `${company}-unused`);
      const account = fake.addAccount(company, company, { signIn: "expired" });
      const urls = fake.addresses[company];
      const flow = signInLink(company, urls.authorize);
      fake.nextSignIn(account.id);
      const invalidLink = new URL(flow.link);
      invalidLink.searchParams.set("client_id", "wrong-client");
      expect((await fetch(invalidLink, { redirect: "manual" })).status).toBe(400);
      const callback = await fetch(flow.link, { redirect: "manual" });
      expect(callback.status).toBe(302);
      const location = callback.headers.get("location")!;
      const query = new URL(location).searchParams;
      expect(query.get("code")).toBe(account.code);
      const pasted = company === "anthropic" ? `${query.get("code")}#${query.get("state")}` : location;
      const exchange = () => fetch(urls.token, exchangeBody(company, pasted, flow));
      if (company === "anthropic") {
        const request = exchangeBody(company, pasted, flow);
        const fields = JSON.parse(String(request.body));
        expect(
          (await fetch(urls.token, { ...request, body: JSON.stringify({ ...fields, state: "wrong-state" }) }))
            .status,
        ).toBe(400);
      }
      const wrongVerifier = { ...flow, verifier: "wrong" };
      expect((await fetch(urls.token, exchangeBody(company, pasted, wrongVerifier))).status).toBe(400);
      account.signIn = "reject-code";
      expect((await exchange()).status).toBe(400);
      account.signIn = "expired";
      const login = (await (await exchange()).json()) as { access_token: string; refresh_token: string };
      expect(login).toMatchObject({ access_token: account.accessToken, expires_in: -1 });
      const models = () =>
        fetch(urls.api + (company === "anthropic" ? "/v1/models" : "/codex/models"), {
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
      expect((await models()).status).toBe(401);
      const renewal = {
        grant_type: "refresh_token",
        refresh_token: login.refresh_token,
        client_id: oauth[company].client,
      };
      const renew = () =>
        fetch(urls.token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(renewal),
        });
      expect((await fetch(urls.token, { method: "POST", body: new URLSearchParams(renewal) })).status).toBe(
        400,
      );
      account.signIn = "refuse-renewal";
      expect((await renew()).status).toBe(400);
      account.signIn = "success";
      expect(await (await renew()).json()).toMatchObject({ expires_in: 3600 });
      expect(account.accessToken).not.toBe(login.access_token);
      expect((await models()).status).toBe(200);
    }
  } finally {
    await fake.stop();
  }
});

test("only a turn for the selected account consumes its script, and a partial limit follows visible output", async () => {
  const fake = await startFakeCompanies();
  try {
    for (const company of ["anthropic", "openai"] as const) {
      const a = fake.addAccount(company, `${company}-a`);
      const b = fake.addAccount(company, `${company}-b`);
      const resetAt = Math.floor(Date.now() / 1000) + 120;
      fake.script(a.id, [
        { kind: "limit", resetAt },
        { kind: "partial-limit", resetAt },
        { kind: "signed-out" },
        { kind: "overloaded" },
      ]);
      const api = fake.addresses[company].api;
      const turn = (account: typeof a, strictHeaders = true) =>
        fetch(api + (company === "anthropic" ? "/v1/messages" : "/codex/responses"), {
          method: "POST",
          headers: {
            authorization: `Bearer ${account.accessToken}`,
            "content-type": "application/json",
            ...(strictHeaders &&
              (company === "anthropic"
                ? { "anthropic-beta": "oauth-2025-04-20" }
                : { "chatgpt-account-id": account.id })),
          },
          body: JSON.stringify({ model: "fixture", stream: true }),
        });
      expect(await (await turn(b)).text()).toContain(
        company === "anthropic" ? "message_stop" : "response.completed",
      );
      expect((await turn(a, false)).status).toBe(401);
      const limited = await turn(a);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      if (company === "anthropic") {
        expect(limited.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected");
        expect(limited.headers.get("anthropic-ratelimit-unified-reset")).toBe(String(resetAt));
      } else {
        expect(limited.headers.get("x-codex-primary-used-percent")).toBe("100");
        expect(await limited.json()).toMatchObject({
          error: { type: "usage_limit_reached", resets_at: resetAt, plan_type: "plus" },
        });
      }
      const partial = await turn(a);
      expect(partial.status).toBe(200);
      expect(partial.headers.get("retry-after")).toBeNull();
      const body = await partial.text();
      const delta = body.indexOf("Fake ");
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(body.indexOf("Fake limit")).toBeGreaterThan(delta);
      expect(body).not.toContain("reply.");
      expect((await turn(a)).status).toBe(401);
      const overloaded = await turn(a);
      expect(overloaded.status).toBe(company === "anthropic" ? 529 : 503);
      if (company === "openai")
        expect(await overloaded.json()).toMatchObject({ error: { code: "server_is_overloaded" } });
      else {
        fake.script(a.id, [{ kind: "limit", scope: "model", resetAt }]);
        const modelLimit = await turn(a);
        expect(modelLimit.headers.get("anthropic-ratelimit-unified-5h-status")).toBe("allowed");
        expect(modelLimit.headers.get("anthropic-ratelimit-unified-reset")).toBeNull();
      }
      expect(fake.requests.at(-1)).toMatchObject({
        account: a.id,
        headers: { authorization: `Bearer ${a.accessToken}` },
        body: { model: "fixture", stream: true },
      });
    }
  } finally {
    await fake.stop();
  }
});

test("the cleaner correlates synthetic credentials and removes identity and message text before replay", async () => {
  const fake = await startFakeCompanies();
  const dir = await mkdtemp(join(tmpdir(), "fake-company-recording-"));
  const filename = join(dir, "fixture.json");
  try {
    const jwt = syntheticJwt({
      email: "private-jwt@example.test",
      sub: "private-jwt-sub",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "private-chatgpt-account",
        chatgpt_plan_type: "plus",
      },
    });
    const login = {
      id_token: jwt,
      access_token: "sample-secret",
      account: { email_address: "example@example.test" },
      organization: { name: "Sample Organization" },
    };
    const responseText = 'event: delta\ndata: {"delta":"Sample answer"}\n\n';
    const recorder = createRecorder(async (request) =>
      new URL(String((request as Request).url)).pathname.endsWith("/token")
        ? Response.json(login, { headers: { "set-cookie": "sample-cookie" } })
        : new URL((request as Request).url).pathname.startsWith("/accounts/")
          ? Response.json(
              { error: { code: "usage_limit_reached" } },
              {
                status: 429,
                headers: {
                  "anthropic-ratelimit-unified-status": "rejected",
                  "x-codex-primary-used-percent": "100",
                },
              },
            )
          : new Response(responseText, { headers: { "content-type": "text/event-stream" } }),
    );
    await recorder.fetch("https://fixture.invalid/v1/oauth/token", {
      method: "POST",
      body: new URLSearchParams({ code: "sample-code" }),
    });
    await recorder.fetch("https://fixture.invalid/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer sample-secret", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ content: "Sample question" }] }),
    });
    await recorder.fetch("https://fixture.invalid/accounts/private-path/workspaces/a%20private%20title", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        metadata: { user_id: "private-claude-composite" },
        client_metadata: { session_id: "private-session" },
        prompt_cache_key: "private-cache",
        user_id: "private-user",
        chatgpt_user_id: "private-chatgpt-user",
        full_name: "private-full-name",
        display_name: "private-display-name",
        title: "private-workspace-title",
        organization_id: "private-org",
      }),
    });
    await recorder.save(filename);
    const saved = await readFile(filename, "utf8");
    for (const privateText of [
      "sample-secret",
      "example@example.test",
      "Sample Organization",
      "Sample answer",
      "sample-code",
      "Sample question",
      "sample-cookie",
    ])
      expect(saved).not.toContain(privateText);

    expect(saved).not.toContain("private-");
    expect(saved).not.toContain("a%20private%20title");
    expect(saved).not.toContain(jwt);
    expect(saved).toContain("usage_limit_reached");
    expect(saved).toContain("anthropic-ratelimit-unified-status");
    expect(saved).toContain("x-codex-primary-used-percent");
    const fixture = JSON.parse(saved) as Fixture;
    const cleanedJwt = JSON.parse(fixture.exchanges[0].response.chunks[0]).id_token as string;
    const decoded = Buffer.from(cleanedJwt.split(".")[1], "base64url").toString();
    expect(cleanedJwt).not.toBe(jwt);
    expect(decoded).toContain("chatgpt_account_id");
    expect(decoded).not.toContain("private-");
    const { access_token } = JSON.parse(fixture.exchanges[0].response.chunks[0]);
    expect(fixture.exchanges[1].request.headers.authorization).toBe(`Bearer ${access_token}`);
    const split: Fixture = {
      exchanges: [
        {
          ...fixture.exchanges[1],
          response: {
            ...fixture.exchanges[1].response,
            chunks: [responseText.slice(0, 25), responseText.slice(25)],
          },
        },
      ],
    };
    expect(cleanFixture(split).exchanges[0].response.chunks).toEqual([
      'event: delta\ndata: {"delta":"[sample text]"}\n\n',
    ]);
    fake.replay(fixture);
    const api = fake.addresses.anthropic.api;
    expect(await (await fetch(api + "/v1/oauth/token", { method: "POST" })).json()).toMatchObject({
      access_token,
    });
    expect(await (await fetch(api + "/v1/messages", { method: "POST" })).text()).toContain("[sample text]");
  } finally {
    await fake.stop();
    await unlink(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(dir);
  }
});

test("models, plan, and roles have the provider fields even on the bare listener", async () => {
  const fake = await startFakeCompanies();
  try {
    const claude = fake.addAccount("anthropic", "model-claude");
    const codex = fake.addAccount("openai", "model-codex");
    const get = async (route: string, token: string) => {
      const reply = await fetch(fake.address + route, { headers: { authorization: `Bearer ${token}` } });
      expect(reply.status).toBe(200);
      return reply.json();
    };
    expect(await get("/v1/models", claude.accessToken)).toMatchObject({
      first_id: "claude-sonnet-4-6",
      last_id: "claude-sonnet-4-6",
    });
    expect(await get("/api/oauth/profile", claude.accessToken)).toMatchObject({
      organization: { name: "Fake organization" },
    });
    expect(await get("/api/oauth/claude_cli/roles", claude.accessToken)).toMatchObject({
      organization_role: "admin",
    });
    expect(await get("/backend-api/codex/models", codex.accessToken)).toMatchObject({
      models: [{ slug: "gpt-5" }],
    });
    expect(await get("/backend-api/wham/usage", codex.accessToken)).toMatchObject({
      rate_limit: {
        primary_window: { limit_window_seconds: 18000 },
        secondary_window: { limit_window_seconds: 604800 },
      },
    });
  } finally {
    await fake.stop();
  }
});

test("each provider sends text and terminal events at different times", async () => {
  const fake = await startFakeCompanies({ delayMs: 35 });
  try {
    await Promise.all(
      (["anthropic", "openai"] as const).map(async (company) => {
        const account = fake.addAccount(company, company, { strict: false });
        const response = await fetch(
          fake.addresses[company].api + (company === "anthropic" ? "/v1/messages" : "/codex/responses"),
          {
            method: "POST",
            headers: { authorization: `Bearer ${account.accessToken}` },
          },
        );
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let text = "";
        let firstDelta: number | undefined;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (firstDelta === undefined && text.includes("Fake ")) firstDelta = performance.now();
        }
        expect(firstDelta).toBeDefined();
        expect(performance.now() - firstDelta!).toBeGreaterThanOrEqual(30);
        expect(text).toContain(company === "anthropic" ? "message_stop" : "response.completed");
      }),
    );
  } finally {
    await fake.stop();
  }
});
