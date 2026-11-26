import type {} from "@tokamak/sdk/web";
import type { Addresses } from "./addresses";
import {
  SignInError,
  retryAfter,
  text,
  type Details,
  type Identity,
  type ReadWith,
  type Login,
  type Pasted,
  type Renewal,
  type SignInCompany,
} from "./company";
import { challenge } from "./pkce";

/**
 * ChatGPT's subscription sign-in, done by the server over the network the way
 * Codex 0.170.0's login crate does it (public source, codex-rs/login):
 *
 * - The link (`server.rs` `build_authorize_url`, `oauth/authorization.rs`):
 *   Codex's client id, CLIProxyAPI's narrower scope (see `SCOPE`), PKCE S256,
 *   `state`, and the extra
 *   parameters `id_token_add_organizations`, `codex_cli_simplified_flow` and
 *   `originator=codex_cli_rs`, returning to `http://localhost:1455/auth/callback`
 *   as CLIProxyAPI does (Codex 0.170 uses `127.0.0.1`; see `REDIRECT`).
 * - The return (`oauth/authorization.rs` `CallbackParameters::validate`): the
 *   state is checked before the code or an error is read. `readPasted` hands
 *   back the state with either, and `signins:finishSignIn` compares it first,
 *   so another sign-in's return (code or error) is "another sign-in". An error
 *   is worded as Codex's `oauth_callback_error_message` (`server.rs`). ChatGPT
 *   may append `.onboarding_entrypoint=life_sciences` to the state; that is
 *   accepted.
 * - The exchange (`oauth/client.rs`): a form body without `state`.
 * - Renewal (`auth/manager.rs` `request_chatgpt_token_refresh`): a JSON body
 *   with `refresh_reason`. A 401, a 400 `invalid_grant`, or the codes
 *   `refresh_token_expired`, `refresh_token_reused` or
 *   `refresh_token_invalidated` mean "sign in again"; anything else is "try
 *   later". A renewal that sends no new refresh or ID token keeps the old one.
 * - The ID token's claims (`token_data.rs`): the email (or the profile
 *   claim's), and under `https://api.openai.com/auth` the plan, the user and
 *   the workspace (`chatgpt_account_id`). The workspace id is kept on the
 *   account; the ID token itself is never stored (it can be traded for an API
 *   key, and nothing needs it after sign-in).
 * - The models (`codex-api/src/endpoint/models.rs`): `GET
 *   <ChatGPT backend>/codex/models?client_version=…` with the
 *   `chatgpt-account-id` header; the workspace's name from `/wham/accounts/check`
 *   (`backend-client/src/client.rs`), as Codex's app server reads it.
 *
 * Nothing listens on the return address: Codex does, on its own computer,
 * and this server cannot open a port (see README). After signing in, the
 * browser ends on a page that fails to load, and the person pastes its address.
 */

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/**
 * Codex's return address up to 0.150 and CLIProxyAPI's; Codex 0.170 sends
 * `127.0.0.1` instead (its PR #47927). `localhost` keeps one host for both
 * companies' returns, as Claude's is `localhost:54545`.
 */
export const REDIRECT = "http://localhost:1455/auth/callback";
/**
 * CLIProxyAPI's scope (internal/auth/codex/openai_auth.go). Codex 0.170 also
 * asks for `api.connectors.read api.connectors.invoke`
 * (`server.rs` `build_authorize_url`); these logins only carry Codex turns
 * through the proxy, and the connector scopes would only widen what a leaked
 * token can do. Append them here to ask for Codex's exact scope.
 */
export const SCOPE = "openid profile email offline_access";
const ORIGINATOR = "codex_cli_rs";
/** The Codex version these details come from; the models endpoint filters by it. */
export const CLIENT_VERSION = "0.170.0";
/** What a sign-in that may have used its code says: a new code is needed. */
const OPEN_AGAIN = "Open the sign-in page again and paste the new address.";
/** What ChatGPT may append to the state for an onboarding entry point. */
const STATE_SUFFIX = ".onboarding_entrypoint=life_sciences";
const TIMEOUT_MS = 20_000;
/** Codex waits 45 s for a renewal; one renewal claim holds 30 s, so stay below it. */
const RENEW_TIMEOUT_MS = 20_000;
/** A login with neither `exp` nor `expires_in` is taken to last this long, never "already expired". */
const ASSUMED_LIFETIME_S = 3600;
/** The headers Codex's default client sends: its originator, and a user agent that starts with it. */
const HEADERS = { originator: ORIGINATOR, "user-agent": `${ORIGINATOR}/${CLIENT_VERSION}` };
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";
/** Errors after which Codex asks the person to sign in again, whatever the status. */
const SIGN_IN_AGAIN = ["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"];

/** Codex's display names (`protocol/src/auth.rs` `KnownPlan::display_name`). */
const PLANS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro (More)",
  prolite: "Pro",
  promax: "Pro (Max)",
  team: "Team",
  self_serve_business_prolite: "Self Serve Business ProLite",
  self_serve_business_usage_based: "Self Serve Business Usage Based",
  business: "Business",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise (Automation)",
  enterprise_cbp_usage_based: "Enterprise CBP Usage Based",
  enterprise: "Enterprise",
  hc: "Enterprise",
  education: "Edu",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
  sci: "Academic Researchers",
  sci_plus: "Academic Researchers Plus",
};

export function signInLink(addresses: Addresses, verifier: string, state: string): string {
  const link = new URL(addresses.openai.authorize);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
    state,
    scope: SCOPE,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: ORIGINATOR,
  });
  return `${link.origin}${link.pathname}?${query.toString()}`;
}

/**
 * The address the browser ended on, read as CLIProxyAPI reads a pasted
 * callback (internal/misc/oauth.go `ParseOAuthCallback`): with or without
 * `http://`, or only its query; the code and state from the query or the
 * fragment, or a `code#state`. Unlike Claude's page, ChatGPT never shows a
 * code to copy, so a bare code is refused: without its state the server could
 * not tell it is this sign-in's, and Codex never exchanges a code whose state
 * it has not checked.
 */
export function readPasted(pasted: string): Pasted {
  const value = pasted.trim();
  if (!value) return { error: "Paste the address your browser ended on." };
  const candidate = asAddress(value);
  if (!candidate) return { error: "That is not the address the sign-in ended on. Paste the whole address." };
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { error: "That address could not be read. Paste the whole address." };
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const field = (name: string) =>
    url.searchParams.get(name)?.trim() || fragment.get(name)?.trim() || undefined;
  let code = field("code");
  let raw = field("state");
  if (code && !raw && code.includes("#")) [code, raw] = code.split("#", 2) as [string, string];
  const description = field("error_description");
  const error = field("error") ?? description;
  if (!raw)
    return {
      error: error
        ? "That address has no state in it, so it cannot be told apart from another sign-in's. Paste the whole address."
        : "That address has no state in it. Paste the whole address.",
    };
  const state = raw.endsWith(STATE_SUFFIX) ? raw.slice(0, -STATE_SUFFIX.length) : raw;
  if (error) return { refused: callbackError(error, description), state };
  if (!code) return { error: "That address has no code in it. Paste the whole address." };
  return { code, state };
}

/** A pasted value as a full address: with `http://` added, or only a query put on one. */
function asAddress(value: string): string | undefined {
  if (value.includes("://")) return value;
  if (value.startsWith("?")) return `http://localhost${value}`;
  if (/[/?#:]/.test(value)) return `http://${value}`;
  return value.includes("=") ? `http://localhost/?${value}` : undefined;
}

/**
 * Codex's words for an error return (`server.rs` `oauth_callback_error_message`
 * and `is_missing_codex_entitlement_error`). The sign-in keeps waiting, so
 * the person is sent back to the page, not told to start again. The code is
 * shown as a short token only: it is the company's text in an address anyone
 * could make.
 */
function callbackError(code: string, description: string | undefined): string {
  if (code === "access_denied" && description?.toLowerCase().includes("missing_codex_entitlement"))
    return "Codex is not enabled for your workspace. Ask your workspace administrator to enable it.";
  const shown = code.replace(/[^\w.-]/g, "").slice(0, 64) || "unknown";
  return `ChatGPT refused the sign-in (${shown}). Open the sign-in page again.`;
}

type Claims = {
  exp?: unknown;
  email?: unknown;
  [PROFILE_CLAIM]?: { email?: unknown };
  [AUTH_CLAIM]?: {
    chatgpt_plan_type?: unknown;
    chatgpt_user_id?: unknown;
    user_id?: unknown;
    chatgpt_account_id?: unknown;
  };
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url to bytes. Server actions have no `atob`. Throws on a foreign character. */
function fromBase64url(value: string): Uint8Array {
  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;
  for (const char of value.replace(/=+$/, "")) {
    const n = ALPHABET.indexOf(char);
    if (n < 0) throw new Error("Not base64url");
    buffer = (buffer << 6) | n;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** A JWT's claims, unverified, as Codex reads them; undefined when it is not a JWT. */
export function claimsOf(jwt: string | undefined): Claims | undefined {
  const parts = jwt?.split(".");
  if (!parts || parts.length !== 3 || parts.some((part) => !part)) return undefined;
  try {
    const claims: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1]!)));
    return typeof claims === "object" && claims !== null ? (claims as Claims) : undefined;
  } catch {
    return undefined;
  }
}

type TokenAnswer = {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
};

/** When the access token runs out: its own `exp` as Codex reads it, else `expires_in`. */
function expiry(access: string, expiresIn: unknown): number {
  const exp = claimsOf(access)?.exp;
  if (typeof exp === "number") return exp * 1000;
  return Date.now() + (typeof expiresIn === "number" ? expiresIn : ASSUMED_LIFETIME_S) * 1000;
}

/**
 * The login in a token answer. A renewal may leave out the refresh token: the
 * old one is passed in, as Codex keeps it.
 */
function login(answer: TokenAnswer, previousRefresh?: string): Login {
  const access = text(answer.access_token);
  const refresh = text(answer.refresh_token) ?? previousRefresh;
  const idToken = text(answer.id_token);
  if (!access || !refresh) throw new SignInError("Refused", "ChatGPT answered without a login. Start again.");
  return { access, refresh, ...(idToken && { idToken }), expiresAt: expiry(access, answer.expires_in) };
}

async function post(url: string, body: BodyInit, type: string, timeout: number): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { ...HEADERS, accept: "application/json", "content-type": type },
    body,
    signal: AbortSignal.timeout(timeout),
  });
}

export async function exchange(
  addresses: Addresses,
  pasted: { code: string; state: string },
  verifier: string,
): Promise<{ login: Login; identity: Partial<Identity> }> {
  let response: Response;
  try {
    response = await post(
      addresses.openai.token,
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: pasted.code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
      "application/x-www-form-urlencoded",
      TIMEOUT_MS,
    );
  } catch {
    // A request that timed out may have used the code already: ask for a new one.
    throw new SignInError("Unreachable", `ChatGPT could not be reached (sign-in). ${OPEN_AGAIN}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const busy = response.status >= 500 || response.status === 429;
    throw new SignInError(
      busy ? "Unreachable" : "Refused",
      busy
        ? `ChatGPT could not finish the sign-in (HTTP ${response.status}). ${OPEN_AGAIN}`
        : "ChatGPT did not accept that code. Open the sign-in page again, sign in, and paste the new address.",
    );
  }
  let answer: TokenAnswer;
  try {
    answer = (await response.json()) as TokenAnswer;
  } catch {
    throw new SignInError("Unreachable", `ChatGPT's answer could not be read. ${OPEN_AGAIN}`);
  }
  const signedIn = login(answer);
  // The ID token names the workspace; without it no backend request can be made.
  if (!signedIn.idToken) throw new SignInError("Refused", "ChatGPT answered without a login. Start again.");
  return { login: signedIn, identity: identityOf(signedIn.idToken) };
}

/**
 * The account from the ID token. Its id is the person within the workspace:
 * one workspace (a Business plan) holds many people, so the workspace id
 * alone would make a teammate's login look like the same account.
 */
function identityOf(idToken: string | undefined): Partial<Identity> {
  const claims = claimsOf(idToken);
  const auth = claims?.[AUTH_CLAIM];
  const email = text(claims?.email) ?? text(claims?.[PROFILE_CLAIM]?.email);
  const workspace = text(auth?.chatgpt_account_id);
  const person = text(auth?.chatgpt_user_id) ?? text(auth?.user_id) ?? email;
  return {
    ...(workspace && person && { accountId: `${person}/${workspace}` }),
    ...(email && { email }),
    ...(workspace && { workspace }),
  };
}

/** The error code of a refused token request, as Codex reads it (`oauth/error.rs`); none when unreadable. */
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    const nested = (body.error as { code?: unknown } | undefined)?.code;
    return (text(body.error) ?? text(nested) ?? text(body.code))?.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Codex's "sign in again": a 401, a 400 `invalid_grant`, or one of its refresh-token codes at any status. */
const refuses = (status: number, code: string | undefined) =>
  status === 401 ||
  (status === 400 && code === "invalid_grant") ||
  (code !== undefined && SIGN_IN_AGAIN.includes(code));

export async function renew(addresses: Addresses, refresh: string): Promise<Renewal> {
  let response: Response;
  try {
    response = await post(
      addresses.openai.token,
      JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refresh,
        refresh_reason: "proactive_expiry",
      }),
      "application/json",
      RENEW_TIMEOUT_MS,
    );
  } catch {
    return { kind: "later" };
  }
  if (!response.ok) {
    if (refuses(response.status, await errorCode(response))) return { kind: "refused" };
    const afterMs = response.status === 429 ? retryAfter(response) : undefined;
    return afterMs === undefined ? { kind: "later" } : { kind: "later", afterMs };
  }
  try {
    // A new ID token is not kept: the workspace stays on the account row.
    return { kind: "renewed", login: login((await response.json()) as TokenAnswer, refresh) };
  } catch {
    return { kind: "later" };
  }
}

async function get(url: string, access: string, workspace: string) {
  try {
    const response = await fetch(url, {
      headers: {
        ...HEADERS,
        accept: "application/json",
        authorization: `Bearer ${access}`,
        "chatgpt-account-id": workspace,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return (await response.json()) as Record<string, unknown>;
    await response.body?.cancel();
  } catch {
    // The workspace name and the model list are advisory: the sign-in does not fail on them.
  }
  return undefined;
}

/** Codex's name for a raw plan type, or the raw type capitalised when Codex has none. */
const planName = (raw: string) => PLANS[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1);

/**
 * The workspace entries of `/wham/accounts/check`, in either of the two forms
 * Codex reads (`backend-client/src/types.rs`): a list of entries, or a map by
 * account id with `account_ordering`.
 */
function workspaces(
  answer: Record<string, unknown> | undefined,
): { id?: unknown; name?: unknown; plan_type?: unknown }[] {
  const accounts = answer?.accounts;
  if (Array.isArray(accounts)) return accounts as { id?: unknown }[];
  if (typeof accounts !== "object" || accounts === null) return [];
  return Object.values(accounts as Record<string, { account?: Record<string, unknown> }>).flatMap((entry) =>
    entry?.account ? [{ ...entry.account, id: entry.account.account_id }] : [],
  );
}

/**
 * Reads at sign-in from the ID token, and later from a stored login with the
 * account's workspace id (the ID token is not stored). The plan is the ID
 * token's `chatgpt_plan_type`, else the workspace's `plan_type` from
 * `/wham/accounts/check` ("current subscription … independent of token
 * claims" in Codex); with neither, it is unknown.
 */
export async function details(addresses: Addresses, { login, identity: known }: ReadWith): Promise<Details> {
  const claimed = text(claimsOf(login.idToken)?.[AUTH_CLAIM]?.chatgpt_plan_type)?.toLowerCase();
  const identity = { ...known, ...identityOf(login.idToken) };
  const workspace = identity.workspace;
  if (!workspace)
    return { plan: claimed ? planName(claimed) : "", planKnown: claimed !== undefined, identity, models: [] };
  const [catalog, accounts] = await Promise.all([
    get(`${addresses.openai.api}/codex/models?client_version=${CLIENT_VERSION}`, login.access, workspace),
    get(`${addresses.openai.api}/wham/accounts/check`, login.access, workspace),
  ]);
  const list = Array.isArray(catalog?.models)
    ? (catalog.models as { slug?: unknown; display_name?: unknown; visibility?: unknown }[])
    : [];
  // Codex's picker lists the models marked "list"; hidden ones are for its own use.
  const models = list.flatMap((model) => {
    const id = text(model.slug);
    return id && (model.visibility === undefined || model.visibility === "list")
      ? [{ id, name: text(model.display_name) ?? id }]
      : [];
  });
  const entry = workspaces(accounts).find((account) => account.id === workspace);
  const organization = text(entry?.name);
  const raw = claimed ?? text(entry?.plan_type)?.toLowerCase();
  return {
    plan: raw ? planName(raw) : "",
    planKnown: raw !== undefined,
    identity: { ...identity, ...(organization && { organization }) },
    models,
  };
}

/** ChatGPT's sign-in, as the rest of the plugin uses every company's. */
export const openai: SignInCompany = {
  name: "ChatGPT",
  link: signInLink,
  readPasted,
  exchange,
  renew,
  details,
};
