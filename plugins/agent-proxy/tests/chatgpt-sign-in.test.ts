import { createApi, type FunctionReference, type TokamakClient } from "@tokamak/sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startFakeCompanies } from "./fake-companies";
import { builds, type Workspace, startWorkspace } from "./workspace";

// Adding a ChatGPT subscription, as the Profiles screen does it: through the
// functions `ai-profiles` gives its window, on a real server, against the
// fake OpenAI sign-in (strict: client id, redirect, PKCE, a form exchange and
// a JSON renewal, as Codex sends them). The Claude flow's own cases are in
// sign-in.test.ts; these check that the same flow holds for ChatGPT and that
// the two companies sit side by side. Runs once per server build that is built.

type Subscription = {
  id: string;
  company: "anthropic" | "openai";
  label: string;
  plan: string;
  status: "ok" | "signed-out";
  reason?: string;
  accounts: { id: string; email?: string; organization?: string; status: string }[];
  models: { id: string; name: string }[];
};
type SignIn = { id: string; company: string; link: string; repair?: string; expired: boolean };
type Failed = { failed: true; kind: string; data: { message: string } };
type Company = "anthropic" | "openai";
type Ref<K extends "query" | "mutation" | "action", A, R> = FunctionReference<K, A, R>;
const api = createApi<{
  subscriptions: {
    list: Ref<"query", Record<string, never>, { subscriptions: Subscription[]; signIns: SignIn[] }>;
    startSignIn: Ref<
      "action",
      { company: Company; method: "subscription"; repair?: string },
      SignIn | Failed
    >;
    finishSignIn: Ref<"action", { id: string; pasted: string }, Subscription | Failed>;
    cancelSignIn: Ref<"mutation", { id: string }, null | Failed>;
    renew: Ref<"action", Record<string, never>, { renewed: number; signedOut: number; waiting: number }>;
  };
  manage: { signOut: Ref<"mutation", { id: string }, null | Failed> };
}>("ai-profiles", [
  "subscriptions:list",
  "subscriptions:startSignIn",
  "subscriptions:finishSignIn",
  "subscriptions:cancelSignIn",
  "subscriptions:renew",
  "manage:signOut",
]);

/** A failure a person can read: one line, no stack trace, no source path. */
const plain = (kind: string) => ({
  failed: true,
  kind,
  data: { message: expect.stringMatching(/^[^\n/]*$/) },
});
type Fake = Awaited<ReturnType<typeof startFakeCompanies>>;
const tokenCalls = (fake: Fake, account: string, grant: string) =>
  fake.requests.filter(
    (request) =>
      request.account === account &&
      (request.body as { grant_type?: string } | undefined)?.grant_type === grant,
  );

const available = builds();
// Without a server build the suites below register nothing, and Vitest fails a file with no tests.
if (!available.length) test.skip("needs the Runner or Server build", () => {});
if (!available.length)
  console.log("Skipping: build the server and tokamak-plugin-host to run the sign-in tests");

describe.skipIf(!available.length).each(available)("$name, ChatGPT", (build) => {
  let fake: Fake;
  let workspace: Workspace;
  /** Every answer the window got, to look for logins in afterwards. */
  const seen: unknown[] = [];

  beforeAll(async () => {
    fake = await startFakeCompanies({ delayMs: 1 });
    workspace = await startWorkspace(build, fake.addresses);
  }, 300_000);
  afterAll(async () => {
    await workspace?.stop();
    await fake?.stop();
  });

  async function call<A, R>(
    client: TokamakClient,
    kind: "query" | "mutation" | "action",
    ref: Ref<typeof kind, A, R>,
    args: A,
  ) {
    const result = await (client[kind] as (ref: unknown, args: A) => Promise<R>).call(client, ref, args);
    seen.push(result);
    return result;
  }
  const list = (client: TokamakClient) => call(client, "query", api.subscriptions.list, {});
  async function start(client: TokamakClient, company: Company = "openai", repair?: string) {
    const started = await call(client, "action", api.subscriptions.startSignIn, {
      company,
      method: "subscription",
      ...(repair && { repair }),
    });
    if ("failed" in started) throw new Error(started.data.message);
    return started;
  }
  /** What the person's browser does: open the link, sign in, end on the callback address. */
  async function signInOnPage(link: string, account: string) {
    fake.nextSignIn(account);
    const page = await fetch(link, { redirect: "manual" });
    expect(page.status).toBe(302);
    return page.headers.get("location")!;
  }
  const finish = (client: TokamakClient, id: string, pasted: string) =>
    call(client, "action", api.subscriptions.finishSignIn, { id, pasted });
  async function add(client: TokamakClient, account: string) {
    const { id, link } = await start(client);
    const added = await finish(client, id, await signInOnPage(link, account));
    if ("failed" in added) throw new Error(added.data.message);
    return added;
  }

  test("the link is Codex's: client id, scopes, PKCE, state, the extra parameters and the port 1455 return", async () => {
    const client = await workspace.owner();
    const { link, company } = await start(client);
    expect(company).toBe("openai");
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe(fake.addresses.openai.authorize);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      redirect_uri: "http://localhost:1455/auth/callback",
      code_challenge_method: "S256",
      // CLIProxyAPI's narrower scope, not Codex's connector scopes (see openai.ts SCOPE).
      scope: "openid profile email offline_access",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    });
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
  });

  test("a pasted callback address adds the subscription with its plan, email, workspace and models", async () => {
    fake.addAccount("openai", "acme", { plan: "business", workspace: "Acme" });
    const client = await workspace.owner();
    const added = await add(client, "acme");
    expect(added).toMatchObject({
      company: "openai",
      plan: "Business",
      status: "ok",
      accounts: [{ email: "acme@example.test", organization: "Acme", status: "ok" }],
      models: [{ id: "gpt-5", name: "Fake GPT" }],
    });
    // The exchange was a form without `state` (the fake checked the verifier and
    // redirect); the model list was asked for the workspace in the login.
    const [exchanged] = tokenCalls(fake, "acme", "authorization_code");
    expect(exchanged?.headers["content-type"]).toMatch(/^application\/x-www-form-urlencoded/);
    expect(exchanged?.body).not.toHaveProperty("state");
    const models = fake.requests.find((request) =>
      request.path.startsWith("/openai/backend-api/codex/models"),
    );
    expect(models?.path).toContain("client_version=");
    expect(models?.headers["chatgpt-account-id"]).toBe("acme");
    expect((await list(client)).signIns).toEqual([]);
  });

  test("a wrong or partial paste keeps the sign-in waiting; cancel and failures leave nothing", async () => {
    const client = await workspace.owner();
    const before = (await list(client)).subscriptions.length;
    const account = fake.addAccount("openai", "careful", { signIn: "reject-code" });
    const waiting = await start(client);
    const callback = await signInOnPage(waiting.link, "careful");
    // ChatGPT shows no code to copy: a bare code has no state and is not read.
    expect(await finish(client, waiting.id, account.code)).toMatchObject(plain("Unreadable"));
    expect(await finish(client, waiting.id, callback.replace(/state=[^&]+/, "state=another"))).toMatchObject(
      plain("WrongSignIn"),
    );
    // An error return is checked by its state first, as Codex does: another sign-in's error is
    // "another sign-in", and this one's says what ChatGPT refused while the sign-in keeps waiting.
    const state = new URL(callback).searchParams.get("state");
    const refusal =
      "http://localhost:1455/auth/callback?error=access_denied&error_description=missing_codex_entitlement";
    expect(await finish(client, waiting.id, `${refusal}&state=another`)).toMatchObject(plain("WrongSignIn"));
    expect(await finish(client, waiting.id, `${refusal}&state=${state}`)).toMatchObject({
      ...plain("Refused"),
      data: { message: expect.stringMatching(/^Codex is not enabled for your workspace/) },
    });
    expect(await finish(client, waiting.id, callback)).toMatchObject({
      ...plain("Refused"),
      data: { message: expect.stringMatching(/ChatGPT did not accept that code/) },
    });
    account.signIn = "unavailable";
    expect(await finish(client, waiting.id, callback)).toMatchObject({
      ...plain("Unreachable"),
      // The exchange may have used the code: a new one is asked for.
      data: { message: expect.stringMatching(/HTTP 503\). Open the sign-in page again/) },
    });
    expect((await list(client)).signIns.map((signIn) => signIn.id)).toEqual([waiting.id]);
    expect((await list(client)).subscriptions).toHaveLength(before);
    // Cancelled: nothing is added, and the same address no longer finishes anything.
    await call(client, "mutation", api.subscriptions.cancelSignIn, { id: waiting.id });
    account.signIn = "success";
    expect(await finish(client, waiting.id, callback)).toMatchObject(plain("Cancelled"));
    expect(await list(client)).toMatchObject({ signIns: [], subscriptions: { length: before } });
  });

  test("an expiring login is renewed; one ChatGPT will not renew turns Signed out and is repaired in place", async () => {
    const account = fake.addAccount("openai", "renewing", { signIn: "expired" });
    const client = await workspace.owner();
    const added = await add(client, "renewing");
    expect(await call(client, "action", api.subscriptions.renew, {})).toEqual({
      renewed: 1,
      signedOut: 0,
      waiting: 0,
    });
    const [renewal] = tokenCalls(fake, "renewing", "refresh_token");
    expect(renewal?.headers["content-type"]).toMatch(/^application\/json/);
    expect(renewal?.body).toMatchObject({
      refresh_token: "fake-renewing-refresh",
      refresh_reason: "proactive_expiry",
    });

    // Signed out here, then signed in again with a login that expires, which ChatGPT then
    // refuses to renew. (A repair takes only a signed-out account, TKM-265.)
    await call(client, "mutation", api.manage.signOut, { id: added.accounts[0]!.id });
    account.signIn = "expired";
    const again = await start(client, "openai", added.id);
    expect(await finish(client, again.id, await signInOnPage(again.link, "renewing"))).toMatchObject({
      id: added.id,
      status: "ok",
    });
    account.signIn = "refuse-renewal";
    expect(await call(client, "action", api.subscriptions.renew, {})).toEqual({
      renewed: 0,
      signedOut: 1,
      waiting: 0,
    });
    expect((await list(client)).subscriptions.find((item) => item.id === added.id)).toMatchObject({
      status: "signed-out",
      reason: "ChatGPT would not renew the login. Sign in again.",
    });

    // A ChatGPT subscription is not repaired through Claude's sign-in.
    expect(
      await call(client, "action", api.subscriptions.startSignIn, {
        company: "anthropic",
        method: "subscription",
        repair: added.id,
      }),
    ).toMatchObject(plain("NotFound"));
    // "Sign in" on the card: the same subscription, signed in again.
    account.signIn = "success";
    const repair = await start(client, "openai", added.id);
    expect(await finish(client, repair.id, await signInOnPage(repair.link, "renewing"))).toMatchObject({
      id: added.id,
      status: "ok",
    });
    expect((await list(client)).subscriptions.filter((item) => item.id === added.id)).toHaveLength(1);
  });

  test("a plan ChatGPT does not name stays unknown, and a repair as another workspace names that workspace", async () => {
    fake.addAccount("openai", "unnamed", { plan: null, workspace: "Acme" });
    const client = await workspace.owner();
    const added = await add(client, "unnamed");
    // Unknown, not "Free": the card shows "ChatGPT" without a plan word.
    expect(added).toMatchObject({
      plan: "",
      accounts: [{ email: "unnamed@example.test", organization: "Acme" }],
    });

    // The same email in another workspace is another account: said with the workspace's name.
    fake.addAccount("openai", "elsewhere", { workspace: "Beta" });
    const repair = await start(client, "openai", added.id);
    expect(await finish(client, repair.id, await signInOnPage(repair.link, "elsewhere"))).toMatchObject({
      ...plain("OtherAccount"),
      data: { message: expect.stringContaining("elsewhere@example.test in Beta") },
    });
    await call(client, "mutation", api.subscriptions.cancelSignIn, { id: repair.id });
  });

  test("a Claude and a ChatGPT subscription sit side by side, and another member sees neither", async () => {
    fake.addAccount("anthropic", "claude-personal");
    fake.addAccount("openai", "chatgpt-personal");
    const owner = await workspace.owner();
    const claude = await start(owner, "anthropic");
    await finish(owner, claude.id, await signInOnPage(claude.link, "claude-personal"));
    await add(owner, "chatgpt-personal");
    const mine = await list(owner);
    expect(
      mine.subscriptions.filter((item) => item.accounts[0]?.email?.endsWith("-personal@example.test")),
    ).toEqual([
      expect.objectContaining({ company: "anthropic", plan: "Pro" }),
      expect.objectContaining({ company: "openai", plan: "Plus" }),
    ]);

    const waiting = await start(owner);
    const other = await workspace.member("alex");
    expect(await list(other)).toEqual({ subscriptions: [], signIns: [] });
    expect(await finish(other, waiting.id, "code=x&state=y")).toMatchObject({
      failed: true,
      kind: "Cancelled",
    });
    await call(other, "mutation", api.subscriptions.cancelSignIn, { id: waiting.id });
    expect((await list(owner)).signIns.map((signIn) => signIn.id)).toEqual([waiting.id]);
    await call(owner, "mutation", api.subscriptions.cancelSignIn, { id: waiting.id });
  });

  test("no login (access, refresh or ID token, nor a verifier) reaches the window or the server's output", () => {
    const secrets = fake.requests.flatMap(({ body }) => {
      const fields = body as Record<string, unknown> | undefined;
      // The authorization code too: with the verifier it was a login.
      return [fields?.code_verifier, fields?.refresh_token, fields?.code];
    });
    // Every token the fake handed out to these accounts, before and after one renewal.
    for (const id of ["acme", "renewing", "chatgpt-personal", "claude-personal", "unnamed"])
      secrets.push(`fake-${id}-access`, `fake-${id}-refresh`, `fake-${id}-access-1`, `fake-${id}-refresh-1`);
    const values = secrets.filter((value): value is string => typeof value === "string");
    expect(values.length).toBeGreaterThan(10);
    const answers = JSON.stringify(seen);
    const output = workspace.output();
    for (const secret of values) {
      expect(answers).not.toContain(secret);
      expect(output).not.toContain(secret);
    }
    // An ID token is base64url JSON parts joined by dots; none appears anywhere.
    expect(answers).not.toMatch(/eyJ[\w-]+\.eyJ[\w-]+\./);
    expect(output).not.toMatch(/eyJ[\w-]+\.eyJ[\w-]+\./);
  });
});
