import { createApi, type FunctionReference, type TokamakClient } from "@tokamak/sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startFakeCompanies } from "./fake-companies";
import { builds, type Workspace, startWorkspace } from "./workspace";

// Managing a subscription (TKM-265), as the subscription details screen and
// the card's actions do it: through the functions ai-profiles gives its
// window, on a real server, against the fake Claude. Each test reads only what
// a person sees (the list) and what reaches Claude (the fake's requests).

type Account = { id: string; email?: string; status: "ok" | "signed-out"; reason?: string };
type Subscription = {
  id: string;
  label: string;
  plan: string;
  enabled: boolean;
  status: "ok" | "signed-out";
  reason?: string;
  accounts: Account[];
  models: { id: string; name: string }[];
};
type SignIn = { id: string; link: string; repair?: string; addTo?: string };
type Failed = { failed: true; kind: string; data: { message: string } };
type Ref<K extends "query" | "mutation" | "action", A, R> = FunctionReference<K, A, R>;
type Id = { id: string };
const api = createApi<{
  subscriptions: {
    list: Ref<"query", Record<string, never>, { subscriptions: Subscription[]; signIns: SignIn[] }>;
    startSignIn: Ref<
      "action",
      { company: "anthropic"; method: "subscription"; repair?: string },
      SignIn | Failed
    >;
    finishSignIn: Ref<"action", { id: string; pasted: string }, Subscription | Failed>;
    cancelSignIn: Ref<"mutation", Id, null | Failed>;
    setLabel: Ref<"mutation", { id: string; label: string }, null | Failed>;
    setEnabled: Ref<"mutation", { id: string; enabled: boolean }, null | Failed>;
    renew: Ref<"action", Record<string, never>, { renewed: number; signedOut: number; waiting: number }>;
  };
  manage: {
    addAccount: Ref<"action", Id, SignIn | Failed>;
    signInAccount: Ref<"action", Id, SignIn | Failed>;
    signOut: Ref<"mutation", Id, null | Failed>;
    checkAgain: Ref<"action", Id, Subscription | Failed>;
    usedBy: Ref<"query", Id, unknown[]>;
    remove: Ref<"mutation", Id, null | Failed>;
  };
}>("ai-profiles", [
  "subscriptions:list",
  "subscriptions:startSignIn",
  "subscriptions:finishSignIn",
  "subscriptions:cancelSignIn",
  "subscriptions:setLabel",
  "subscriptions:setEnabled",
  "subscriptions:renew",
  "manage:addAccount",
  "manage:signInAccount",
  "manage:signOut",
  "manage:checkAgain",
  "manage:usedBy",
  "manage:remove",
]);

const plain = (kind: string) => ({
  failed: true,
  kind,
  data: { message: expect.stringMatching(/^[^\n/]*$/) },
});

const available = builds();
// Without a server build the suites below register nothing, and Vitest fails a file with no tests.
if (!available.length) test.skip("needs the Runner or Server build", () => {});
if (!available.length)
  console.log("Skipping: build the server and tokamak-plugin-host to run the subscription tests");

describe.skipIf(!available.length).each(available)("$name", (build) => {
  let fake: Awaited<ReturnType<typeof startFakeCompanies>>;
  let workspace: Workspace;
  let client: TokamakClient;
  /** Every answer the window got, to look for logins in afterwards. */
  const seen: unknown[] = [];

  beforeAll(async () => {
    fake = await startFakeCompanies({ delayMs: 1 });
    workspace = await startWorkspace(build, fake.addresses);
    client = await workspace.owner();
  }, 300_000);
  afterAll(async () => {
    await workspace?.stop();
    await fake?.stop();
  });

  async function call<A, R>(kind: "query" | "mutation" | "action", ref: Ref<typeof kind, A, R>, args: A) {
    const result = await (client[kind] as (ref: unknown, args: A) => Promise<R>).call(client, ref, args);
    seen.push(result);
    return result;
  }
  const list = () => call("query", api.subscriptions.list, {});
  const find = async (id: string) => (await list()).subscriptions.find((item) => item.id === id);
  /** What the person's browser does: open the link, sign in as `account`, end on the callback. */
  async function signInOnPage(link: string, account: string) {
    fake.nextSignIn(account);
    return (await fetch(link, { redirect: "manual" })).headers.get("location")!;
  }
  async function finishAs(signIn: SignIn | Failed, account: string) {
    if ("failed" in signIn) throw new Error(signIn.data.message);
    const pasted = await signInOnPage(signIn.link, account);
    return call("action", api.subscriptions.finishSignIn, { id: signIn.id, pasted });
  }
  const start = (repair?: string) =>
    call("action", api.subscriptions.startSignIn, {
      company: "anthropic",
      method: "subscription",
      ...(repair && { repair }),
    });
  /** A new subscription signed in as fake account `account`. */
  async function added(account: string) {
    const result = await finishAs(await start(), account);
    if ("failed" in result) throw new Error(result.data.message);
    return result;
  }
  const addAccount = (id: string) => call("action", api.manage.addAccount, { id });
  const refreshes = (account: string) =>
    fake.requests.filter(
      (request) =>
        request.account === account &&
        (request.body as { grant_type?: string } | undefined)?.grant_type === "refresh_token",
    ).length;

  test("a second account joins the subscription and both emails are listed; the same account twice, or one on another plan, is refused", async () => {
    for (const id of ["team-a", "team-b", "team-c"]) fake.addAccount("anthropic", id).plan = "claude_team";
    fake.addAccount("anthropic", "solo").plan = "claude_max";
    const team = await added("team-a");
    const other = await added("team-c");

    const second = await addAccount(team.id);
    expect(second).toMatchObject({ addTo: team.id });
    expect(await finishAs(second, "team-b")).toMatchObject({
      id: team.id,
      plan: "Team",
      status: "ok",
      accounts: [
        { email: "team-a@example.test", status: "ok" },
        { email: "team-b@example.test", status: "ok" },
      ],
    });
    expect((await find(team.id))?.accounts.map((account) => account.email)).toEqual([
      "team-a@example.test",
      "team-b@example.test",
    ]);

    // Already in this subscription, or under another one: said, and the sign-in is over.
    for (const account of ["team-b", "team-c"]) {
      const again = await addAccount(team.id);
      expect(await finishAs(again, account)).toMatchObject(plain("AlreadyAdded"));
      expect((await list()).signIns.map((signIn) => signIn.id)).not.toContain((again as SignIn).id);
    }
    // Another plan: said, and still waiting for an account on the right one.
    const max = await addAccount(team.id);
    expect(await finishAs(max, "solo")).toMatchObject({
      ...plain("OtherPlan"),
      data: { message: expect.stringMatching(/Claude Max, not Team/) },
    });
    expect((await list()).signIns.map((signIn) => signIn.id)).toContain((max as SignIn).id);
    expect(await find(team.id)).toMatchObject({ accounts: [{}, {}] });
    expect(await find(other.id)).toMatchObject({ accounts: [{ email: "team-c@example.test" }] });
  });

  test("signing out one of two keeps the subscription OK, the last leaves it Signed out, and Sign in repairs it in place", async () => {
    // The second account's login runs out at once, so a renewal would ask Claude for it.
    // (Claude then also cannot say its plan, and the subscription keeps its own.)
    fake.addAccount("anthropic", "out-b");
    fake.addAccount("anthropic", "out-a", { signIn: "expired" });
    const subscription = await added("out-b");
    expect(await finishAs(await addAccount(subscription.id), "out-a")).toMatchObject({ plan: "Pro" });
    const [b, a] = (await find(subscription.id))!.accounts;

    expect(await call("mutation", api.manage.signOut, { id: a!.id })).toBeNull();
    expect(await find(subscription.id)).toMatchObject({
      status: "ok",
      accounts: [
        { id: b!.id, status: "ok" },
        { id: a!.id, status: "signed-out", reason: expect.stringMatching(/signed this account out/) },
      ],
    });
    // Its login is gone from the server: nothing renews it, so Claude never sees its refresh token again.
    await call("action", api.subscriptions.renew, {});
    expect(refreshes("out-a")).toBe(0);

    await call("mutation", api.manage.signOut, { id: b!.id });
    expect(await find(subscription.id)).toMatchObject({ status: "signed-out", reason: expect.any(String) });

    // "Sign in" on the card: the same subscription and account row, signed in again.
    const repaired = await finishAs(await start(subscription.id), "out-a");
    expect(repaired).toMatchObject({
      id: subscription.id,
      status: "ok",
      accounts: [
        { id: b!.id, status: "signed-out" },
        { id: a!.id, status: "ok" },
      ],
    });
  });

  test("switched off a subscription keeps its logins; check again reads plan and models anew and survives Claude being down", async () => {
    const account = fake.addAccount("anthropic", "checked", { signIn: "expired" });
    const subscription = await added("checked");
    await call("mutation", api.subscriptions.setLabel, { id: subscription.id, label: "Work" });

    await call("mutation", api.subscriptions.setEnabled, { id: subscription.id, enabled: false });
    expect(await find(subscription.id)).toMatchObject({ enabled: false, status: "ok" });
    // Off is not signed out: the login is still there and is still renewed.
    await call("action", api.subscriptions.renew, {});
    expect(refreshes("checked")).toBe(1);
    await call("mutation", api.subscriptions.setEnabled, { id: subscription.id, enabled: true });
    expect(await find(subscription.id)).toMatchObject({ enabled: true, status: "ok" });

    account.plan = "claude_max";
    account.models = [{ id: "claude-opus-4-6", name: "Fake Opus" }];
    expect(await call("action", api.manage.checkAgain, { id: subscription.id })).toMatchObject({
      id: subscription.id,
      label: "Work",
      plan: "Max",
      models: [{ id: "claude-opus-4-6", name: "Fake Opus" }],
    });

    account.reads = "unavailable";
    expect(await call("action", api.manage.checkAgain, { id: subscription.id })).toMatchObject(
      plain("Unreachable"),
    );
    expect(await find(subscription.id)).toMatchObject({ plan: "Max", models: [{ id: "claude-opus-4-6" }] });
    account.reads = "ok";
  });

  test("remove deletes the subscription, its accounts and logins, and the sign-in left waiting for it", async () => {
    fake.addAccount("anthropic", "removed", { signIn: "expired" });
    const subscription = await added("removed");
    const waiting = await addAccount(subscription.id);
    expect(await call("query", api.manage.usedBy, { id: subscription.id })).toEqual([]);

    expect(await call("mutation", api.manage.remove, { id: subscription.id })).toBeNull();
    const after = await list();
    expect(after.subscriptions.map((item) => item.id)).not.toContain(subscription.id);
    expect(after.signIns.map((signIn) => signIn.id)).not.toContain((waiting as SignIn).id);
    // The login is gone (nothing to renew), the sign-in cannot finish, and the
    // account is free to be added again as a new subscription.
    await call("action", api.subscriptions.renew, {});
    expect(refreshes("removed")).toBe(0);
    expect(await finishAs(waiting, "removed")).toMatchObject({ failed: true, kind: "Cancelled" });
    expect(await added("removed")).toMatchObject({ accounts: [{ email: "removed@example.test" }] });
  });

  test("another member can do none of it, and an id of the wrong table gets a plain answer", async () => {
    fake.addAccount("anthropic", "kept");
    const subscription = await added("kept");
    const account = subscription.accounts[0]!.id;
    const before = await list();

    const other = await workspace.member("alex");
    const as = async <A, R>(kind: "query" | "mutation" | "action", ref: Ref<typeof kind, A, R>, args: A) =>
      (other[kind] as (ref: unknown, args: A) => Promise<R>).call(other, ref, args);
    expect(await as("action", api.manage.addAccount, { id: subscription.id })).toMatchObject(
      plain("NotFound"),
    );
    expect(await as("mutation", api.manage.signOut, { id: account })).toMatchObject(plain("NotFound"));
    expect(await as("action", api.manage.checkAgain, { id: subscription.id })).toMatchObject(
      plain("NotFound"),
    );
    expect(await as("mutation", api.manage.remove, { id: subscription.id })).toMatchObject(plain("NotFound"));

    const signIn = await start();
    const wrong = [
      ["addAccount", account],
      ["checkAgain", (signIn as SignIn).id],
      ["remove", account],
      ["signOut", subscription.id],
      ["signOut", "agent-proxy/logins:abc"],
      ["signOut", "nonsense"],
      ["remove", ""],
    ] as const;
    for (const [name, id] of wrong) {
      const ref = api.manage[name] as Ref<"mutation", Id, unknown>;
      const kind = name === "addAccount" || name === "checkAgain" ? "action" : "mutation";
      expect(await call(kind, ref, { id })).toMatchObject(plain("NotFound"));
    }
    const after = await list();
    expect(after.subscriptions).toEqual(before.subscriptions);
    await call("mutation", api.manage.signOut, { id: account });
    await call("mutation", api.manage.remove, { id: subscription.id });
  });

  // The one rule for reads (reads.ts): a read that failed never overwrites one
  // that worked, and the subscription's models are the union of its accounts'.
  test("a repair while Claude's reads fail keeps the plan and the models of every account", async () => {
    const opus = { id: "claude-opus-4-6", name: "Fake Opus" };
    const haiku = { id: "claude-haiku-4-5", name: "Fake Haiku" };
    const a = fake.addAccount("anthropic", "keep-a");
    const b = fake.addAccount("anthropic", "keep-b");
    for (const account of [a, b]) account.plan = "claude_team";
    a.models = [opus];
    b.models = [haiku];
    const subscription = await added("keep-a");
    await finishAs(await addAccount(subscription.id), "keep-b");
    expect(await find(subscription.id)).toMatchObject({ plan: "Team", models: [opus, haiku] });

    const second = (await find(subscription.id))!.accounts[1]!;
    await call("mutation", api.manage.signOut, { id: second.id });
    b.reads = "unavailable";
    const repaired = await finishAs(
      await call("action", api.manage.signInAccount, { id: second.id }),
      "keep-b",
    );
    expect(repaired).toMatchObject({ plan: "Team", status: "ok", models: [opus, haiku] });
    b.reads = "ok";

    // Check again with both answering: the union stays, even though the first account lacks Haiku.
    expect(await call("action", api.manage.checkAgain, { id: subscription.id })).toMatchObject({
      models: [opus, haiku],
    });
  });

  test("an account's own Sign in takes that account only, and a repair takes only a signed-out one", async () => {
    fake.addAccount("anthropic", "only-a");
    fake.addAccount("anthropic", "only-b");
    const subscription = await added("only-a");
    await finishAs(await addAccount(subscription.id), "only-b");
    const [a, b] = (await find(subscription.id))!.accounts;
    await call("mutation", api.manage.signOut, { id: a!.id });

    // "Sign in" on A, finished as B (still signed in): refused, and still waiting for A.
    const forA = await call("action", api.manage.signInAccount, { id: a!.id });
    expect(forA).toMatchObject({ repair: subscription.id, repairAccount: a!.id });
    expect(await finishAs(forA, "only-b")).toMatchObject(plain("OtherAccount"));
    expect((await list()).signIns.map((signIn) => signIn.id)).toContain((forA as SignIn).id);
    expect(await finishAs(forA, "only-a")).toMatchObject({
      accounts: [
        { id: a!.id, status: "ok" },
        { id: b!.id, status: "ok" },
      ],
    });

    // A repair of the subscription with no account named refuses one that is signed in.
    await call("mutation", api.manage.signOut, { id: a!.id });
    const repair = await start(subscription.id);
    expect(await finishAs(repair, "only-b")).toMatchObject(plain("OtherAccount"));
    await call("mutation", api.subscriptions.cancelSignIn, { id: (repair as SignIn).id });
  });

  test("a plan Claude did not give is unknown, fits any account, and the first known read fills it in", async () => {
    // A 200 with no plan in it is not "Free".
    const blank = fake.addAccount("anthropic", "blank");
    blank.reads = "empty";
    const subscription = await added("blank");
    expect(subscription).toMatchObject({ plan: "" });
    const team = fake.addAccount("anthropic", "known-team");
    team.plan = "claude_team";
    expect(await finishAs(await addAccount(subscription.id), "known-team")).toMatchObject({
      plan: "Team",
      accounts: [{ email: "blank@example.test" }, { email: "known-team@example.test" }],
    });

    // Claude down at the first read: unknown until "Check again" reads it.
    const down = fake.addAccount("anthropic", "first-down");
    down.reads = "unavailable";
    const later = await added("first-down");
    expect(later).toMatchObject({ plan: "", models: [] });
    down.reads = "ok";
    expect(await call("action", api.manage.checkAgain, { id: later.id })).toMatchObject({
      plan: "Pro",
      models: [{ id: "claude-sonnet-4-6" }],
    });
  });

  test("a renewal that Claude answers after the account was signed out, or removed, keeps nothing", async () => {
    for (const [name, end] of [
      ["race-out", "signOut"],
      ["race-gone", "remove"],
    ] as const) {
      // Earlier tests leave logins due too; renew those first, so the count below is this one's.
      await call("action", api.subscriptions.renew, {});
      const account = fake.addAccount("anthropic", name, { signIn: "expired" });
      const subscription = await added(name);
      account.tokenDelayMs = 600;
      const renewing = call("action", api.subscriptions.renew, {});
      // Claude has the refresh token; the person signs out (or removes it) meanwhile.
      while (!refreshes(name)) await new Promise((done) => setTimeout(done, 20));
      if (end === "signOut") await call("mutation", api.manage.signOut, { id: subscription.accounts[0]!.id });
      else await call("mutation", api.manage.remove, { id: subscription.id });
      expect((await renewing).renewed).toBe(0);
      account.tokenDelayMs = 0;
      // Nothing was written back: no login to renew, and the account stays as it was left.
      await call("action", api.subscriptions.renew, {});
      expect(refreshes(name)).toBe(1);
      const after = await find(subscription.id);
      if (end === "signOut") expect(after).toMatchObject({ status: "signed-out" });
      else expect(after).toBeUndefined();
    }
  });

  test("no login reaches any answer", () => {
    const secrets = fake.requests
      .flatMap(({ body }) => {
        const fields = body as Record<string, unknown> | undefined;
        return [fields?.code_verifier, fields?.refresh_token];
      })
      .concat(
        [
          "team-a",
          "team-b",
          "out-a",
          "out-b",
          "checked",
          "removed",
          "kept",
          "keep-a",
          "keep-b",
          "only-a",
          "only-b",
          "blank",
          "known-team",
          "first-down",
          "race-out",
          "race-gone",
        ].flatMap((id) => [`fake-${id}-access`, `fake-${id}-refresh`]),
      )
      .filter((value): value is string => typeof value === "string");
    const answers = JSON.stringify(seen);
    for (const secret of secrets) expect(answers).not.toContain(secret);
  });
});
