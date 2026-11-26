# Agent Proxy

This plugin owns a person's AI subscriptions, the provider accounts in them,
their logins and the sign-in that makes them. It knows nothing about threads.
The inbound proxy sends Claude requests under a subscription the calling
plugin put in the set for that turn.

## Exports

The functions below are exported from `src/server/api.ts` and are plugin-only (`plugin:agent-proxy/server`): no
window calls them directly, and none returns a login. Each answers for the
calling member only, so another member of a shared server never sees or
changes someone else's subscriptions. Every id is checked to be of the right
table; a malformed id, an id of another table, or another member's gets
`fail("NotFound")` and changes nothing.

| Function             | Kind     | Arguments                                                               | Result                                                                                           |
| -------------------- | -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `listSubscriptions`  | query    | none                                                                    | `{ subscriptions: SubscriptionView[], signIns: SignInView[] }`                                   |
| `startSignIn`        | action   | `{ company: "anthropic" \| "openai", method: "subscription", repair? }` | `SignInView` (the link to open), or `fail("NotFound")` (also when `repair` is another company's) |
| `finishSignIn`       | action   | `{ id, pasted }`: the address the browser ended on, or code             | `SubscriptionView`, or a failure with `data.message`                                             |
| `cancelSignIn`       | mutation | `{ id }`                                                                | `null`, or `fail("NotFound")`                                                                    |
| `setLabel`           | mutation | `{ id, label }`                                                         | `null`, or `fail("NotFound" \| "TooLong")`                                                       |
| `setEnabled`         | mutation | `{ id, enabled }`                                                       | `null`, or `fail("NotFound")`                                                                    |
| `renewLogins`        | action   | none                                                                    | `{ renewed, signedOut, waiting }`                                                                |
| `addAccount`         | action   | `{ id }` of a subscription                                              | `SignInView` with `addTo`, or `fail("NotFound")`                                                 |
| `signInAccount`      | action   | `{ id }` of an account                                                  | `SignInView` with `repairAccount`, or `fail("NotFound")`                                         |
| `signOutAccount`     | mutation | `{ id }` of an account                                                  | `null`, or `fail("NotFound")`                                                                    |
| `checkAgain`         | action   | `{ id }` of a subscription                                              | `SubscriptionView`, or `fail("Unreachable" \| "SignedOut")`                                      |
| `removeSubscription` | mutation | `{ id }` of a subscription                                              | `null`, or `fail("NotFound")`                                                                    |
| `registerSet`        | mutation | `{ subscriptions: string[], set?: string }`                             | `{ set }`; supply an existing set id to replace its ordered list                                 |
| `turnKey`            | action   | `{ set }`                                                               | `{ address, key }` for one turn                                                                  |
| `endTurnKey`         | mutation | `{ key }`                                                               | `null`; makes the key stop accepting requests                                                    |

`finishSignIn` failures that keep the sign-in waiting: `Unreadable`,
`WrongSignIn`, `Refused` (the company did not accept the code or refused the
sign-in; paste again or open the page again for a new code), `Unreachable`, `OtherAccount` (a repair signed
in as another account), `OtherPlan` and `OtherCompany` (an added account on
another plan or of another company) and `Busy` (another finish of it is running). Ones that
end it: `AlreadyAdded`, `Gone`, `Expired`, `Cancelled`, `NotFound`.

## Subscription proxy

Set `TOKAMAK_PUBLIC_URL` to the server origin reachable from both CLIs.
`turnKey({ set, lease, company })` issues a company-bound key for that set.
For Claude, the address remains `<origin>/plugins/agent-proxy/<set>`;
the launcher supplies it as `ANTHROPIC_BASE_URL` and the key as
`ANTHROPIC_AUTH_TOKEN`. For Codex, the address adds `/openai`; the launcher
sets a Responses provider whose bearer is the turn key. The upstream is
`https://chatgpt.com/backend-api/codex/responses` with the selected login's
bearer and `chatgpt-account-id`. See [the route and header allowlists](../../design/agent-proxy.md#subscription-proxy).

Both routes stream the response, preserve query and request body, and abort
the upstream on downstream disconnect. Each request tries the first usable
account of its company in set order and renews logins that are about to
expire. A rejected login gets one renewal and replay; a refused renewal
signs the account out and the replay can use the next account. HTTP 429
holds the account out of subsequent requests until reset. A successful
forward updates the subscription's last use.

Call `endTurnKey` when the turn ends. The database stores only the key
hash. Keys expire after 15 minutes without activity and no later than eight
hours after issue. A key with a lease keeps its subscription snapshot if the
set is deleted; a key without a lease requires the set to exist.

## Several accounts, signing out, checking again, removing

A subscription can hold several provider accounts of one company, such as two
logins of one team plan (`src/server/manage.ts`). `addAccount` starts the same
sign-in with a target subscription (`addTo`); `finishSignIn` then adds the
account to it. It is refused (`AlreadyAdded`, the sign-in ends) when the
account is already signed in under this subscription or is under another of
the member's subscriptions, and (`OtherPlan`, the sign-in keeps waiting) when
the company reports another plan for it: the subscription is one plan, so that
account is added as a subscription of its own. An account of this
subscription that was signed out is signed in again in place.

**Reads** (`src/server/reads.ts`), one rule for a new subscription, a repair,
another account and `checkAgain`: a read that failed never overwrites one that
worked. The plan is stored only when the company's answer carried a plan field (`Details.planKnown`); until
then it is empty, the plan is unknown, and an unknown plan fits any account
(the first known read fills it in). Each account keeps the models its own read
returned (stored only when the read returned some); the subscription's
`models` is the union of its accounts' lists, recomputed whenever one changes,
and signing an account out does not shrink it. The per-account lists stay
internal, for the proxy (TKM-263) to skip an account that lacks a model.

`SubscriptionView.status` is `ok` while at least one account is signed in (the
proxy can still use the subscription) and `signed-out` only when every account
is; each entry of `accounts` has its own `id`, `status` and `reason`.

`signOutAccount` deletes the account's login here and marks it "Signed out"
(the login is not revoked at the company); the row stays. `signInAccount` starts a
sign-in that names that one account (`repairAccount`): finishing it as any
other account is refused with `OtherAccount` and it keeps waiting. A
`startSignIn` with `repair` and no account named takes only an account of the
subscription that is signed out, and refuses one that is signed in.
`setEnabled(false)` keeps every login and keeps renewing them; the proxy
(TKM-263) will skip a subscription that is off and an account that is signed
out when it chooses one. `checkAgain` takes a fresh login of each signed-in
account (`logins:fresh`, with its renewal rules) and reads the plan, the email
and organisation, and the models again, through the subscription's own
company module; when the company answered nothing the result is `Unreachable`
and nothing changes. `removeSubscription` deletes the
subscription, its accounts, their logins and any sign-in waiting to repair it
or add to it, in one transaction. Anything that held it is the caller's to
update: the caller updates whatever held it. A
renewal that the company answers after the login was deleted (signed out or
removed meanwhile) keeps nothing, and `logins:fresh` returns null.

Every one of these goes through the subscription's company
(`companies[subscription.company]`, found with `internal.manage.companyOf` or
`internal.manage.accounts`): "Add account" and an account's "Sign in" open that
company's sign-in page, and `signins:begin` refuses a target of another
company; "Check again" reads with that company's `details`, from the access
token and the account's stored workspace. `tests/manage-companies.test.ts`
checks the fake's request log: a ChatGPT login never reaches an Anthropic
address, nor a Claude login an OpenAI one.

## Sign-in

One flow for every company. Each company is one module with the same small
interface, `SignInCompany` in `src/server/company.ts`: `link` (the sign-in
page), `readPasted` (what the person pasted, as a code and its state),
`exchange` (code to login), `renew` (a new login for a refresh token, and
which answers mean "sign in again") and `details` (plan, account, models).
`companies.ts` maps `anthropic` to `claude.ts` and `openai` to `openai.ts`;
`signins.ts`, `logins.ts` and `manage.ts` name no company.

The server does the whole sign-in over the network: `startSignIn` makes a
PKCE verifier and `state`, keeps both in the `signIns` table and returns only
the link.

- **Claude** (`claude.ts`), as CLIProxyAPI does
  (`internal/auth/claude/anthropic_auth.go`): Claude Code's client id, scopes
  and `http://localhost:54545/callback` redirect, `code=true`; a JSON exchange
  that carries `state`; plan, email and organisation from `/api/oauth/profile`
  and models from `/v1/models`. The paste may be the address (state as a
  parameter, after the code, or in the fragment), a `code#state`, or a bare
  code.
- **ChatGPT** (`openai.ts`), from Codex 0.170.0's login crate: Codex's client
  id, `id_token_add_organizations`, `codex_cli_simplified_flow` and
  `originator=codex_cli_rs`, returning to `http://localhost:1455/auth/callback`;
  a form exchange without `state`. The ID token's claims give the email, the
  plan (`chatgpt_plan_type`, else the workspace's `plan_type` from
  `/wham/accounts/check`, shown with Codex's names; with neither, no plan) and
  the workspace (`chatgpt_account_id`). The workspace id is stored on the
  account and returned by `logins:fresh` as `workspace`, for the
  `chatgpt-account-id` header; the ID token itself is never stored, since it
  can be traded for an API key and nothing needs it after sign-in. An account
  is the person within the
  workspace (`chatgpt_user_id/chatgpt_account_id`), so two people of one
  Business workspace are two accounts. Models come from
  `<ChatGPT backend>/codex/models?client_version=0.170.0` and the workspace's
  name from `/wham/accounts/check`, both with `chatgpt-account-id`. The paste
  is read as CLIProxyAPI reads a callback (with or without `http://`, or only
  its query); a bare code is refused, since ChatGPT's page never shows one and
  its state could not be checked. The state is compared before the code or an
  `error` is read, as Codex does, so another sign-in's return is
  `WrongSignIn`; this sign-in's error return is `Refused` with Codex's words
  ("Codex is not enabled for your workspace…" for a missing entitlement) and
  the sign-in keeps waiting.

  Differences from Codex 0.170.0: the scope is CLIProxyAPI's
  `openid profile email offline_access`, without Codex's
  `api.connectors.read api.connectors.invoke` (these logins only carry Codex
  turns, and the connector scopes would widen what a leaked token can do; one
  constant, `SCOPE`); the return host is `localhost` (Codex 0.170 sends
  `127.0.0.1`); no listener of its own and no fallback port 1457; no API-key
  exchange after sign-in; no workspace-restriction or workspace-switch
  parameters; renewal waits 20 s (Codex 45 s), always says `proactive_expiry`
  and runs only when asked (no 8-day scheduled renewal); a minimal user agent;
  expiry from the access token's `exp`, else `expires_in`, else one hour; only
  models marked "list", no ETag cache; the account key is person plus
  workspace.

A failed code exchange (timed out, 5xx, 429, unreadable answer) may have used
the code, so for both companies it asks for a new one: "Open the sign-in page
again and paste the new address."

The server listens on neither return address. The desktop app does, while
the Profiles page is open and a sign-in waits (TKM-295, `design/shell.md`),
and passes the address to `finishSignIn` as the paste field would; without it, after signing in the browser ends on a page that
fails to load, and the person copies the whole address from the address bar
and pastes it (`design/agent-proxy.md`, "Known limits").

A plan is only stored when the company's answer named it (`Details.planKnown`:
Claude's profile carried `organization_type` or a `has_claude_*` field;
ChatGPT's ID token carried `chatgpt_plan_type`). Otherwise it is stored empty,
never "Free" by guess, and a repair with a known plan fills it in.

`finishSignIn` claims the sign-in row first, so a second paste while one is
being exchanged gets `Busy` and changes nothing. It exchanges the code, reads
the company's details, and stores the login in `logins` in the same
transaction that ends the sign-in. A cancel that lands while the company
answers wins, and nothing is stored. A sign-in nobody finishes
within 15 minutes is listed as `expired`, cannot finish, and is deleted by the
next start, cancel or finish. Server actions have no `crypto.subtle`, so
`pkce.ts` computes the S256 challenge itself.

## Renewal

`logins:fresh` (internal) is the one way to a usable login: it renews the
login when it runs out within five minutes, and the proxy calls it before
every request. Renewal is claimed on the login row, so one call at a time
sends a refresh token to the company; a caller that loses the claim uses the
stored login while it still works, or waits for the active renewal to finish.
Only a definite refusal signs out: for Claude HTTP 400 or 401 from the token
endpoint; for ChatGPT, as Codex decides it, a 401, a 400 `invalid_grant`, or
the codes `refresh_token_expired`, `refresh_token_reused` or
`refresh_token_invalidated` (a ChatGPT renewal is JSON with
`refresh_reason: "proactive_expiry"`, and keeps the old refresh token when
none comes back). A refusal deletes the login and turns the account
"Signed out"; `startSignIn` with `repair` then
signs the same subscription in again in place. A 429 waits for its
`Retry-After`; 403, 5xx, network errors and unreadable answers wait one
minute, doubling up to 30 minutes, and the account stays signed in. A plugin's
server code has no timer that may use the network (`maintenance` is a
mutation), so `renewLogins` runs only while a screen that shows subscriptions
is open. The internal functions the proxy calls take the member as
`owner`, since a proxy request has a turn key and no member behind it.

## Tables

`subscriptions`, `accounts` (one login at the company, by its account id,
with ChatGPT's workspace id and the known quota reset), `sets` (ordered
subscription ids), `turnKeys` (hash, set, expiration and whether it ended),
`logins` (access and refresh token, expiry, renewal claim and next try) and
`signIns` (verifier, `state`, link, an optional subscription to repair, a
finish claim). Every row has the `owner` member
id. Logins sit in ordinary tables: there is no secret store yet (TKM-292), so
whoever can read the server's database can read them. No function logs them.

## Addresses

`src/server/addresses.ts` is the only source of production addresses. Call
`await companyAddresses(ctx)` from a server action. The OpenAI API base is the
ChatGPT backend root: append `/codex/responses`, `/codex/models`, or
`/wham/usage`. An administrator can set `TOKAMAK_AGENT_PROXY_ADDRESSES` on the
server or in the installation's `.env.local`. Its JSON must have exactly two
provider keys, `anthropic` and `openai`, each with `authorize`, `token`, and
`api` HTTP(S) URLs. Unset uses defaults; malformed JSON or URLs fail the action
without exposing the value. The window cannot set the variable. Normal builds
grant fetch only to the five real provider hosts, including on redirects.

The native integration test builds a disposable copy with a test-only action
and `net:127.0.0.1`, starts a workspace server on a free port, and verifies a
server action reaches the fake using its installation `.env.local`. The
shipped artifact has neither the action nor the loopback grant. The sign-in
test (`tests/sign-in.test.ts`) installs chat, ai, basic-auth, agent-proxy and
ai-profiles on a real shared server the same way and drives the Profiles
screen's functions against the fake (`tests/chatgpt-sign-in.test.ts` does the
same for ChatGPT), once for each server build it finds
(`target/debug` and the cloud build in `target/cloud/debug`). Build the native
harness once to exercise these tests:

```sh
CARGO_BUILD_JOBS=2 cargo build --locked -p server -p tokamak-plugin-host
CARGO_BUILD_JOBS=2 cargo build --locked --no-default-features -p server -p tokamak-plugin-host --target-dir target/cloud
moon run agent-proxy:test
```

Set `TOKAMAK_TEST_SERVER_BIN` and `TOKAMAK_PLUGIN_HOST` to use other builds.
If the native binaries are absent the native test prints a skip reason.

An existing store: rows written on the TKM-261 base, or on any one ticket
branch as merged (TKM-262, 264, 265, 295), still fit this schema, since fields
were only added or widened; a store made on an early TKM-262 build (`e9578ba9`
up to `7dd2057a`, logins with an `idToken`) does not, and must be recreated.

## Write an offline test

Use the same Vitest runner as the other plugins. From this directory run
`proto run bun -- run test`; from the repository root use
`moon run agent-proxy:test`.

```ts
const fake = await startFakeCompanies({ delayMs: 10 });
try {
  const account = fake.addAccount("anthropic", "acme");
  fake.script(account.id, [
    { kind: "partial-limit", resetAt: Math.floor(Date.now() / 1000) + 60 },
    { kind: "normal" },
  ]);
  const upstream = fake.addresses.anthropic;
  const response = await fetch(upstream.api + "/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", stream: true }),
  });
  // Read the text delta, then the limit event; inspect fake.requests afterward.
  console.log(await response.text());
} finally {
  await fake.stop();
}
```

- `address` is a loopback origin on an OS assigned port; `addresses` has separate
  Anthropic and OpenAI routes. Both also accept an optional
  `/plugins/agent-proxy/<set>` prefix.
- `addAccount(company, id, { signIn, strict, plan, workspace })` registers
  synthetic credentials. For OpenAI, `plan` is the ID token's
  `chatgpt_plan_type` (default `plus`; `null` leaves the claim out) and
  `workspace` the name
  `/wham/accounts/check` gives (none for a personal account).
  Choose the next authorize account with `fake.nextSignIn(id)`. Set the
  account's `signIn` to `success`, `reject-code`, `expired`, `refuse-renewal`,
  `unavailable` (HTTP 503 from the token endpoint) or `limited` (HTTP 429,
  `Retry-After: 120`). `tokenDelayMs` slows its token answers. Successful JSON
  renewal rotates both tokens; a strict account that sends a used refresh
  token again has its whole login revoked, as companies that rotate do.
- Strict mode is the default. Authorization checks the client ID, redirect,
  and S256 challenge (and, for OpenAI, `offline_access` in the scope); exchange checks the matching verifier, redirect, client
  ID, and Anthropic's body `state`. Codex validates `state` in the callback
  before sending its form exchange, so its token body does not contain it.
  The fake redirects to the callback with `code` and `state` in the query; a
  Claude exchange sends them as separate JSON fields. A Claude
  Bearer turn requires `anthropic-beta: oauth-2025-04-20`; a Codex turn requires
  the matching `chatgpt-account-id`. Use `{ strict: false }` for a synthetic
  API-key client that does not use subscription headers.
- `script(id, answers)` replaces that account's queue. A turn consumes one
  answer and defaults to `normal` when the queue is empty. The other kinds are
  `signed-out`, `overloaded`, `limit`, and `partial-limit`. Reset times are Unix
  seconds. For Anthropic `limit`, choose `scope: "account"` (default) or
  `"model"`. A partial limit sends the error after a text delta with no reset
  headers on the HTTP 200. `signed-out` applies to one turn; pair it with
  `account.signIn = "refuse-renewal"` to make that turn's renewal fail.
  Models, plan and roles reads do not consume the queue.
- `requests` records the method, path and query, headers, raw body text, parsed JSON or form
  (otherwise raw body), and the matched account. The in-memory log contains
  synthetic credentials; CLI test output masks credentials and session IDs.
- `replay(fixture)` queues recorded replies in order by method and provider
  path. It preserves status and cleaned headers and sends one SSE frame at a
  time. Other routes still use the scripted fake.

The CLI probes use disposable homes, synthetic credentials, and a loopback
blocking proxy. It prints every attempted outbound host and never forwards.
The two API key probes use Claude's `--bare`, `ANTHROPIC_BASE_URL` and
`ANTHROPIC_API_KEY`, or `codex exec` with `OPENAI_API_KEY` and a custom
Responses provider. The proxy suite also runs Claude with `--bare` and
`ANTHROPIC_AUTH_TOKEN` through a real Tokamak proxy to fake Claude.

## What the layer 2 tests do not show

- The [Claude plugin launch](../claude/src/server/turn.ts) has no `--bare`.
  Without it, hooks, configured MCP servers, `CLAUDE.md`, and keychain lookup
  can participate, subject to launch options and settings. A private
  `CLAUDE_CONFIG_DIR` alone does not establish keychain isolation. The probe
  keeps `--bare`; it does not determine whether `ANTHROPIC_AUTH_TOKEN` or
  `ANTHROPIC_API_KEY` takes precedence over a person's existing OAuth login.
- The [Codex plugin launch](../codex/src/server/rpc.ts) runs `codex app-server`.
  In ChatGPT-login mode Codex reads its own `auth.json`, including an ID
  token, and can renew the login itself, using
  `CODEX_REFRESH_TOKEN_URL_OVERRIDE` when set. The built-in OpenAI provider
  retains Codex backend routes when the base URL is unset or ends in
  `/backend-api/codex` (after trimming trailing slashes). The ChatGPT probe
  uses synthetic file auth and keeps that suffix on `openai_base_url`;
  `chatgpt_base_url` ends in `/backend-api`. Workspace routing on this version
  requires HTTPS, so the probe creates a temporary loopback certificate
  trusted only by its Codex child via `CODEX_CA_CERTIFICATE`. This proves the
  prefixed account and catalog routes and an SSE turn after a WebSocket
  handshake fallback. It does not test live login, credential precedence,
  a real refresh, or a WebSocket turn.

## Record a fixture as the account owner

From the repository root, run one of:

```sh
proto run bun -- plugins/agent-proxy/tests/fake-companies/record.ts anthropic /private/claude-fixture.json
proto run bun -- plugins/agent-proxy/tests/fake-companies/record.ts openai /private/codex-fixture.json
```

Open the printed sign-in link and consent in your browser. Paste the full
address the browser ends on (for Claude, `localhost:54545/callback?…`; for
Codex, `localhost:1455/auth/callback?…`) from the address bar. The redirect
need not load a local page. The script exchanges the
callback, makes one short streamed turn, and writes only the cleaned fixture
to a new file. The login stays in memory and is never printed or written.
Use an account authorized for the requested model; set `TOKAMAK_RECORD_MODEL`
to choose a different model. This workflow has not
been run against real providers here.

The cleaner replaces credential and identity fields, creates a synthetic ID
token with a minimal allowlisted claim set, replaces private path segments
and message text, and retains rate-limit headers and error codes. Review the
entire file before committing it. If a provider introduces a new private
field, update the cleaner or supply explicit replacements through
`createRecorder().save(path, replacements)`. Tests cover cleaning and replay
with a hand-made exchange.

## Shape sources

- Anthropic: CLIProxyAPI's
  [`internal/auth/claude/anthropic_auth.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/claude/anthropic_auth.go)
  gives the authorize, exchange, renewal and profile endpoints and fields.
  [`claude_executor_request.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/claude_executor_request.go)
  gives the Bearer and `anthropic-beta: oauth-2025-04-20` subscription request
  shape. The fake requires it for strict Bearer turns.
  [`helps/claude_ratelimit.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/helps/claude_ratelimit.go)
  distinguishes account windows from model/overage limits.
  [Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
  and [Models](https://platform.claude.com/docs/en/api/models/list) give the
  text SSE events and model list envelope.
- OpenAI: Codex 0.170.0
  [`login/src/server.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/login/src/server.rs)
  gives the authorize and token exchange;
  [`login/src/auth/manager.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/login/src/auth/manager.rs)
  gives renewal and [`login/src/token_data.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/login/src/token_data.rs)
  gives the ID token claims.
  [`model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/model-provider-info/src/lib.rs)
  gives the ChatGPT Codex API base;
  [`backend-client/src/client.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/backend-client/src/client.rs)
  gives the account header, and
  [`backend-client/src/client/rate_limit_resets.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/backend-client/src/client/rate_limit_resets.rs)
  gives the usage path.
  [`codex-api/src/endpoint/models.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/codex-api/src/endpoint/models.rs)
  and [`protocol/src/openai_models.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/protocol/src/openai_models.rs)
  give the model catalog shape.
  [Responses streaming](https://developers.openai.com/api/reference/resources/responses/streaming-events)
  gives the text SSE events.

  [`codex-api/src/api_bridge.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/codex-api/src/api_bridge.rs)
  gives the 429 reset and plan fields and the 503 overload code. The app-server
  [workspace routing code](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs)
  specifies the discovery fields and HTTPS requirement.

**Unconfirmed until recorded:** the real browser consent and redirect
sequence, provider-specific OAuth rejection messages, any extra values beyond
the published plan/profile/roles fields, and the live midstream limit and
sign-out wire events. The normal turn events are exercised by the local CLIs;
the documented request headers, renewal encodings, and 429/503 discriminators
come from the public source above.
