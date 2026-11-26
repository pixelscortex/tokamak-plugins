# Agent Proxy

A person's AI subscriptions, their provider accounts, logins and sign-in. It
draws no UI and publishes no parts. What a person sees of it is data it gives
`ai-profiles` through its plugin-only exports (`plugins/agent-proxy/src/server/api.ts`),
drawn by ai-profiles' Profiles screen. It never gives out a login.
No Paper page of its own: its data shows on `App 1:1 · AI profiles plugin`.

## Screens

None.

## Parts it offers

None.

## What it adds to others

| Target (ai-profiles)     | What                                                                                                                                                                                                                                                                                                                                | Export                                                               | Paper artboard                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Subscription card        | Company (`anthropic` or `openai`), plan (Claude: "Pro", "Max", "Team", "Enterprise", "Free"; ChatGPT: Codex's names, such as "Plus", "Business", "Free"; empty while the company has not named it, and never "Free" by guess), label, enabled, status, the accounts' emails and organisation or ChatGPT workspace, models, last use | `listSubscriptions`                                                  | `Profiles · subscriptions`, `Profiles · awaiting sign-in`, `Profiles · Claude and ChatGPT`                      |
| "Signed out" on the card | `status: "signed-out"` and the reason ("Claude would not renew the login. Sign in again.", or the same with "ChatGPT")                                                                                                                                                                                                              | `listSubscriptions`, `renewLogins`                                   | not drawn yet                                                                                                   |
| Awaiting sign-in card    | Each sign-in that has not ended: company, the link to open, whether it repairs a subscription, adds an account (`addTo`) or signs one account in (`repairAccount`)                                                                                                                                                                  | `listSubscriptions`                                                  | `Profiles · awaiting sign-in`                                                                                   |
| Dialog, sign-in step     | The sign-in link (the company's page with PKCE challenge and `state`)                                                                                                                                                                                                                                                               | `startSignIn`                                                        | `Profiles · add · sign-in`, `Profiles · add · sign-in, address pasted`                                          |
| Dialog, connected step   | Plan, email, organisation and models found                                                                                                                                                                                                                                                                                          | `finishSignIn`                                                       | `Profiles · add · connected`                                                                                    |
| Dialog lines             | Why a paste or a sign-in failed (`data.message` of each failure)                                                                                                                                                                                                                                                                    | `finishSignIn`                                                       | not drawn yet                                                                                                   |
| Card action row          | "Check again": plan, account details and models read anew through the subscription's own company; why it failed (`Unreachable`, `SignedOut`)                                                                                                                                                                                        | `checkAgain`                                                         | `Profiles · subscriptions`                                                                                      |
| Subscription details     | Each account's id, email, organisation, status and reason; "Add account" starts a sign-in with `addTo`; "Sign out" and "Sign in" on one account (`repairAccount`)                                                                                                                                                                   | `listSubscriptions`, `addAccount`, `signOutAccount`, `signInAccount` | `Profiles · subscription`, `Profiles · subscription · two accounts`, `Profiles · subscription · one signed out` |
| Remove confirmation      | Removes the subscription, its accounts, their logins and any sign-in waiting for it                                                                                                                                                                                                                                                 | `removeSubscription`                                                 | `Profiles · remove`                                                                                             |

## Subscription proxy

The plugin-only `registerSet` export stores an ordered list of subscriptions
owned by the calling member and returns the set id. A caller can replace the
list without changing the id. `removeSet` is plugin-only and owner-scoped;
removing a set prevents new keys and invalidates keys without a snapshot. The plugin-only `turnKey`
gives the caller a fresh company-bound key and its address on the configured
public origin. Claude keeps `/plugins/agent-proxy/<set>`; ChatGPT uses
`/plugins/agent-proxy/<set>/openai`. Keys issued before the company field
existed still serve Claude. The proxy stores only a hash and accepts the key
only for its set and company. Keys have a 15 minute idle
window from issue or the last recorded request, and expire no later than eight
hours after issue. The proxy records the first forwarded request and then at
most one per minute. AI Profiles calls `endTurnKey` when a turn ends, including
on stop or failure. It can end a key by the turn's random lease ID without
keeping or passing the raw key after launch. If a process crashes, the idle
deadline still applies.

Codex excludes the turn key from the environment of commands it runs. As with
Claude's turn token, other processes running as the same user can still read the
CLI's environment (for example, with `ps eww`). The key is short-lived and
bound to one set and company.

| Company   | Methods and paths after the returned address                                          | Upstream                                          |
| --------- | ------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Anthropic | POST `/v1/messages`, `/v1/messages/count_tokens`; GET `/v1/models`, `/v1/models/<id>` | `https://api.anthropic.com` with the same path    |
| OpenAI    | POST `/responses`                                                                     | `https://chatgpt.com/backend-api/codex/responses` |

The Codex launcher uses a custom HTTP Responses provider. The picker already
has the ChatGPT models read at sign-in or Check again, so the turn proxy
does not expose models, account, or login endpoints for OpenAI. It preserves
the query, body and streamed response. It forwards these Codex headers when
present: `content-type`, `content-encoding`, `accept`, `accept-encoding`,
`user-agent`, `openai-beta`, `originator`, `version`, `session_id`,
`session-id`, `thread-id`, `x-client-request-id`, `x-openai-subagent`,
`x-codex-installation-id`, `x-codex-routing-hint`, `x-codex-turn-state`,
`x-codex-turn-metadata`, `x-codex-parent-thread-id`, `x-codex-window-id`,
`x-codex-beta-features` and `x-openai-internal-codex-responses-lite`.
It defaults an absent originator to `codex_cli_rs`. It always replaces
Authorization and ChatGPT-Account-Id with the chosen account's access token
and stored workspace id.

Keys with a lease capture the company’s enabled subscriptions in set order.
Edits and deletion affect future leases; keys without a lease use the current
set. Both companies pick the first eligible account for their path and skip
deleted, signed-out or rate-limited accounts. The proxy renews expiring logins
before sending and records last use only on a 2xx response. A 401 forces one
renewal and allows one replay. If the company refuses renewal, the account
is signed out and the replay uses the next eligible account of that company.
A 429 is returned to the CLI and holds the account out of later requests.
For ChatGPT the holdout uses the usage-limit body's reset, then the Codex reset
headers, then Retry-After, then 60 seconds. The upstream body is forwarded
unchanged. The proxy drops Set-Cookie and Set-Cookie2 from both companies.
When every candidate is held out, the proxy returns 429 with the earliest
reset in Retry-After. A set with no usable subscription for the company
otherwise returns 403.

## If you change X, check Y

- Set or key lifetime: check [AI Profiles](../ai-profiles/DESIGN.md) launch and cleanup.
  Reordering, enabling or removing a set only changes future snapshots.
  Keep both the snapshot path and the live-set path covered.

- `SubscriptionView` or `SignInView` (`src/server/_functions.ts`): every field
  is drawn by ai-profiles' cards and dialog; the window tests there stand in for
  these shapes.
- A subscription's `status` is "ok" while at least one of its accounts is
  signed in, and "signed-out" only when every account is. The card reads the
  subscription's status ("OK", or "Signed out" with "Sign in"); the details
  read each account's own. With two accounts and one signed out, the card says
  "OK" and the details show that one "Signed out" with its own "Sign in".
- Failure kinds of an `addAccount` sign-in (`finishSignIn`): `AlreadyAdded`
  ends it, as for a new subscription; `OtherPlan` and `OtherCompany` keep it
  waiting. ai-profiles' dialog lists the ending kinds (`ENDED`).
- Failure messages in `src/server/claude.ts`, `src/server/openai.ts` and
  `src/server/signins.ts`: they are shown as written, in ai-profiles' dialog
  and its alert line.
- Plan names (`PLANS` in `claude.ts` and `openai.ts`): the card title is the
  product ("Claude", "ChatGPT") and the plan, and the line under the emails
  repeats it in lower case. A plan no read has named is stored empty
  (`reads.ts`, `planKnown`) and shown as no word at all.
- A new company: a module with the `SignInCompany` interface
  (`src/server/company.ts`), an entry in `companies.ts`, the `company` union in
  `schema.ts`, its words and return address in ai-profiles' `lib/companies.ts`,
  and its return port in the desktop listener (`design/shell.md`). Nothing
  else names a company: sign-in (`signins.ts`), renewal (`logins.ts`) and the
  subscription screens' functions (`manage.ts`: "Add account", an account's
  "Sign in", "Check again", the plan check of a second account) all go
  through `companies[subscription.company]`.
- Model names: ai-profiles drops a leading "Claude " from them, as ai does.

## Primitives used

None.

## Known limits

- **Without the desktop app the return address is pasted.** Both companies
  send the browser back to a fixed address on the person's computer: Claude
  to `http://localhost:54545/callback`, ChatGPT to
  `http://localhost:1455/auth/callback`. The server does not listen for it;
  the desktop app does, while the Profiles page is open and a sign-in waits
  (`design/shell.md`), and passes the address to `finishSignIn` as the paste
  field would. Without the desktop app (a plain browser, a Server used from
  another machine, or signing in on another device) the page fails to load and
  the person pastes its address, for both companies.
- **The tables changed shape across TKM-261, 262, 264 and 265, and there is no
  migration.** The SDK has none yet (schema migrations are deferred, and
  declared fields do not validate writes, `packages/sdk/README.md`). Since
  TKM-261: `company` may be `openai`; `accounts` gained `workspace` (ChatGPT's
  account id) and `models`; `signIns` gained `addTo` and `repairAccount`;
  `subscriptions.plan` may be empty (unknown). An early TKM-262 build stored an
  ID token on `logins`; none does now. A store made on an older branch should
  be recreated rather than reused.

- **Sign out is local.** `signOutAccount` (and `removeSubscription`) delete
  the login here; they do not revoke it at the company. A copied refresh token
  would keep working until the company retires it.
- **Any plugin that declares `agent-proxy` can sign out or remove** the
  calling member's subscriptions and accounts, as it can start their
  sign-ins; it never gets a login.
- **Renewal only when something asks.** A plugin's server code has no timer
  that may use the network, so a login is renewed only when a screen that
  lists subscriptions is open (it asks every minute) or when the
  proxy is about to use it. A login nobody asks for can run out; the next ask
  renews it if its refresh token still works.
- **Any plugin that depends on `agent-proxy` acts as the calling member.** Its
  server code can call every export for the person whose call it is handling:
  list their subscriptions and sign-ins (no logins, no verifiers), start,
  finish and cancel their sign-ins, label and switch their subscriptions, add
  an account to one, sign an account out, check one again, remove one, and
  trigger renewal. It can also register sets and issue or end keys for that
  member. It cannot reach another member's rows or read any login.
- **Logins sit in ordinary tables.** Whoever can read the server's database can
  read them (no secret store yet, TKM-292). When plugins can hook internal
  functions (Plugin API v2, decision D33), a hook on `logins:read` or
  `logins:fresh` could read logins; logins must move to a secret store, or
  out of hookable functions, before that ships.

## Open questions

- `registerSet` and `turnKey` are plugin-only. Any plugin that depends on
  agent-proxy can use them to mint keys for the calling member's own
  subscriptions only. Does the owner want to restrict which plugins can
  issue keys further?

- The Claude proxy works against fake Claude. The owner still needs to
  confirm a Claude Code turn through it on a live subscription.

- ChatGPT's return address is `http://localhost:1455/auth/callback`, as in
  CLIProxyAPI and Codex up to 0.150. Codex 0.170 sends
  `http://127.0.0.1:1455/auth/callback` instead (its PR #47927). Both reach a
  listener on the person's computer; whether OpenAI keeps accepting
  `localhost` for Codex's client id is confirmed only by the owner's real
  sign-in.
- The ChatGPT plan names are Codex's display names ("Pro (More)" for `pro`,
  "Pro" for `prolite`); whether to shorten them is the owner's call.
- The plan comes from the profile endpoint's `organization.organization_type`
  and `account.has_claude_max` / `has_claude_pro`, which CLIProxyAPI does not
  decode; the values are unconfirmed until the owner signs in with a real
  subscription.
