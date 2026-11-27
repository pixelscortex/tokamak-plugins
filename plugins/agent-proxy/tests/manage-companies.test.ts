import { createApi, type FunctionReference, type TokamakClient } from "@tokamak/sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startFakeCompanies } from "./fake-companies";
import { builds, type Workspace, startWorkspace } from "./workspace";

// Managing a subscription goes through its own company's sign-in module
// (`companies.ts`), never Claude's by default: "Check again" reads with the
// company's details, "Add account" and an account's "Sign in" open the
// company's own sign-in page. The proof is the fake's request log: a ChatGPT
// login never reaches an Anthropic address, a Claude login never reaches an
// OpenAI one, and each subscription's sign-in links point at its company.
// Runs once per server build that is built.

type Account = { id: string; email?: string; status: string };
type Subscription = { id: string; company: string; plan: string; status: string; accounts: Account[] };
type SignIn = { id: string; company: string; link: string };
type Failed = { failed: true; kind: string; data: { message: string } };
type Company = "anthropic" | "openai";
type Ref<K extends "query" | "mutation" | "action", A, R> = FunctionReference<K, A, R>;
const api = createApi<{
  subscriptions: {
    list: Ref<"query", Record<string, never>, { subscriptions: Subscription[]; signIns: SignIn[] }>;
    startSignIn: Ref<"action", { company: Company; method: "subscription" }, SignIn | Failed>;
    finishSignIn: Ref<"action", { id: string; pasted: string }, Subscription | Failed>;
  };
  manage: {
    addAccount: Ref<"action", { id: string }, SignIn | Failed>;
    signInAccount: Ref<"action", { id: string }, SignIn | Failed>;
    signOut: Ref<"mutation", { id: string }, null | Failed>;
    checkAgain: Ref<"action", { id: string }, Subscription | Failed>;
  };
}>("ai-profiles", [
  "subscriptions:list",
  "subscriptions:startSignIn",
  "subscriptions:finishSignIn",
  "manage:addAccount",
  "manage:signInAccount",
  "manage:signOut",
  "manage:checkAgain",
]);

const available = builds();
// Without a server build the suites below register nothing, and Vitest fails a file with no tests.
if (!available.length) test.skip("needs the Runner or Server build", () => {});
if (!available.length) console.log("Skipping: build the server and tokamak-plugin-host to run these tests");

describe.skipIf(!available.length).each(available)("$name, managing either company", (build) => {
  let fake: Awaited<ReturnType<typeof startFakeCompanies>>;
  let workspace: Workspace;
  let client: TokamakClient;

  beforeAll(async () => {
    fake = await startFakeCompanies({ delayMs: 1 });
    workspace = await startWorkspace(build, fake.addresses);
    client = await workspace.owner();
  }, 300_000);
  afterAll(async () => {
    await workspace?.stop();
    await fake?.stop();
  });

  const ok = <T>(value: T | Failed): T => {
    if (value && typeof value === "object" && "failed" in value) throw new Error(value.data.message);
    return value as T;
  };
  /** The person's browser: open the link (which must be `company`'s page), sign in, end on the return. */
  async function signInOnPage(signIn: SignIn, company: Company, account: string) {
    const link = new URL(signIn.link);
    expect(link.origin + link.pathname).toBe(fake.addresses[company].authorize);
    fake.nextSignIn(account);
    const page = await fetch(signIn.link, { redirect: "manual" });
    return page.headers.get("location")!;
  }
  const finish = async (signIn: SignIn, company: Company, account: string) =>
    ok(
      await client.action(api.subscriptions.finishSignIn, {
        id: signIn.id,
        pasted: await signInOnPage(signIn, company, account),
      }),
    );

  /** Every request the fake got with this account's login, by the company whose address it went to. */
  function loginRequests(account: string, from = 0) {
    const token = (request: { headers: Record<string, string> }) =>
      request.headers.authorization?.replace(/^Bearer /i, "") ?? request.headers["x-api-key"];
    return fake.requests
      .slice(from)
      .filter((request) => token(request)?.startsWith(`fake-${account}-`))
      .map((request) => (request.path.startsWith("/openai/") ? "openai" : "anthropic"));
  }
  function authorizePages(account: string) {
    return fake.requests
      .filter((request) => request.account === account && request.path.includes("/oauth/authorize"))
      .map((request) => (request.path.startsWith("/openai/") ? "openai" : "anthropic"));
  }

  for (const [company, other, first, second] of [
    ["openai", "anthropic", "gpt-one", "gpt-two"],
    ["anthropic", "openai", "claude-one", "claude-two"],
  ] as const) {
    test(`a ${company} subscription is checked, added to and signed in again only through ${company}`, async () => {
      fake.addAccount(company, first);
      fake.addAccount(company, second);
      const started = ok(
        await client.action(api.subscriptions.startSignIn, { company, method: "subscription" }),
      );
      const subscription = await finish(started, company, first);

      // "Check again": the subscription's own company reads plan, accounts and models. Its own
      // reads are the requests after this mark that carry the login: at least the two details
      // reads (profile and models for Claude, models and accounts check for ChatGPT), all of them
      // at this company's addresses.
      const mark = fake.requests.length;
      expect(ok(await client.action(api.manage.checkAgain, { id: subscription.id }))).toMatchObject({
        company,
        status: "ok",
      });
      const checked = loginRequests(first, mark);
      expect(checked.length).toBeGreaterThanOrEqual(2);
      expect(new Set(checked)).toEqual(new Set([company]));

      // "Add account": the company's own sign-in page, and the second account joins.
      const another = ok(await client.action(api.manage.addAccount, { id: subscription.id }));
      expect(another.company).toBe(company);
      const two = await finish(another, company, second);
      expect(two.accounts).toHaveLength(2);

      // One account's "Sign in" after signing it out: the company's page again.
      const account = two.accounts.find((item) => item.email === `${second}@example.test`)!;
      await client.mutation(api.manage.signOut, { id: account.id });
      const again = ok(await client.action(api.manage.signInAccount, { id: account.id }));
      expect(again.company).toBe(company);
      await finish(again, company, second);

      // The request log: the logins went only to this company's addresses, and every
      // sign-in page opened was this company's.
      for (const id of [first, second]) {
        expect(loginRequests(id).length).toBeGreaterThan(0);
        expect(loginRequests(id)).not.toContain(other);
        expect(authorizePages(id)).not.toContain(other);
      }
    });
  }
});
