import type {} from "@tokamak/sdk/web";
import type { Addresses } from "./addresses";
import {
  SignInError,
  retryAfter,
  text,
  type Details,
  type Identity,
  type Login,
  type Pasted,
  type Renewal,
  type SignInCompany,
} from "./company";
import { challenge } from "./pkce";

export { SignInError };
export type { Identity, Login, Pasted, Renewal };

/**
 * Claude's subscription sign-in, done by the server over the network the way
 * CLIProxyAPI does it (internal/auth/claude/anthropic_auth.go, public source):
 * the same client id, scopes, authorize parameters and redirect as the
 * Claude Code CLI, a JSON token exchange that carries `state`, and a JSON
 * refresh with the narrower scope.
 *
 * The redirect is the CLI's own `http://localhost:54545/callback`. The CLI
 * listens there; the server does not, and cannot on the person's computer. So
 * after signing in, the browser ends on that address and shows a page that
 * fails to load, and the person copies the whole address from the address bar
 * and pastes it. (Claude's page that shows `code#state` belongs to its hosted
 * manual-code redirect, which this sign-in does not use; which redirect to use
 * is open for the owner. A pasted `code#state` or bare code is still read.)
 *
 * Nothing here logs or throws a login. Errors name the step and the HTTP
 * status only, never a response body.
 */

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const REDIRECT = "http://localhost:54545/callback";
const REFRESH_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
/** A new login also asks for the Console scope, as the native client does. */
const AUTHORIZE_SCOPE = `org:create_api_key ${REFRESH_SCOPE}`;
/** The subscription login works on the API only with this beta (CLIProxyAPI's request shape). */
export const OAUTH_BETA = "oauth-2025-04-20";
const TIMEOUT_MS = 20_000;

/** The headers the native client's HTTP library sends to the OAuth endpoints. */
const OAUTH_HEADERS = {
  accept: "application/json, text/plain, */*",
  "user-agent": "axios/1.15.2",
};
/** A login whose answer has no `expires_in` is taken to last this long, never "already expired". */
const ASSUMED_LIFETIME_S = 3600;

export function signInLink(addresses: Addresses, verifier: string, state: string): string {
  const link = new URL(addresses.anthropic.authorize);
  const query = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT,
    scope: AUTHORIZE_SCOPE,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
    state,
  });
  return `${link.origin}${link.pathname}?${query.toString()}`;
}

/**
 * What the person pasted: the whole address the browser ended on, or a
 * `code#state`, or the code alone. In an address the state may be a query
 * parameter, follow the code after a "#", or sit in the fragment.
 */
export function readPasted(text: string): Pasted {
  const value = text.trim();
  if (!value) return { error: "Paste the link or the code from the sign-in page." };
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { error: "That link could not be read. Paste the whole link." };
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) return { error: "The sign-in page did not give a code. Start again." };
    if (!code) return { error: "That link has no code in it. Paste the whole link." };
    // A pasted Claude code can carry its state after a "#" inside the parameter too.
    const [bare, inner] = code.split("#", 2) as [string, string | undefined];
    const fragment = url.hash.replace(/^#/, "");
    const hashed = fragment.includes("=") ? new URLSearchParams(fragment).get("state") : fragment;
    return { code: bare, state: url.searchParams.get("state") ?? inner ?? (hashed || undefined) };
  }
  const [code, state] = value.split("#", 2) as [string, string | undefined];
  if (!code || /\s/.test(code))
    return { error: "That is not a sign-in code. Paste the code as the page shows it." };
  return { code, state };
}

async function post(url: string, body: Record<string, string>, step: string): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { ...OAUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // A request that timed out may have used the code already: ask for a new one.
    throw new SignInError(
      "Unreachable",
      `Claude could not be reached (${step}). Open the sign-in page again and paste the new address.`,
    );
  }
}

type TokenAnswer = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  account?: { uuid?: unknown; email_address?: unknown };
  organization?: { uuid?: unknown; name?: unknown };
};

function login(answer: TokenAnswer, previousRefresh?: string): Login {
  const access = text(answer.access_token);
  // A renewal that sends no new refresh token keeps the old one (CLIProxyAPI does the same).
  const refresh = text(answer.refresh_token) ?? previousRefresh;
  const seconds = typeof answer.expires_in === "number" ? answer.expires_in : ASSUMED_LIFETIME_S;
  if (!access || !refresh) throw new SignInError("Refused", "Claude answered without a login. Start again.");
  return { access, refresh, expiresAt: Date.now() + seconds * 1000 };
}

/** Trades the pasted code for a login, with the verifier only the server holds. */
export async function exchange(
  addresses: Addresses,
  pasted: { code: string; state: string },
  verifier: string,
): Promise<{ login: Login; identity: Partial<Identity> }> {
  const response = await post(
    addresses.anthropic.token,
    {
      grant_type: "authorization_code",
      code: pasted.code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state: pasted.state,
    },
    "sign-in",
  );
  if (!response.ok) {
    await response.body?.cancel();
    const busy = response.status >= 500 || response.status === 429;
    throw new SignInError(
      busy ? "Unreachable" : "Refused",
      busy
        ? `Claude could not finish the sign-in (HTTP ${response.status}). Open the sign-in page again and paste the new address.`
        : "Claude did not accept that code. Paste the whole address again, or open the sign-in page again for a new code.",
    );
  }
  let answer: TokenAnswer;
  try {
    answer = (await response.json()) as TokenAnswer;
  } catch {
    throw new SignInError(
      "Unreachable",
      "Claude's answer could not be read. Open the sign-in page again and paste the new address.",
    );
  }
  return {
    login: login(answer),
    identity: {
      accountId: text(answer.account?.uuid),
      email: text(answer.account?.email_address),
      organization: text(answer.organization?.name),
    },
  };
}

/** Asks Claude for a new login with `refresh`; only 400 and 401 count as a refusal. */
export async function renew(addresses: Addresses, refresh: string): Promise<Renewal> {
  let response: Response;
  try {
    response = await post(
      addresses.anthropic.token,
      { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refresh, scope: REFRESH_SCOPE },
      "renewal",
    );
  } catch {
    return { kind: "later" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 400 || response.status === 401) return { kind: "refused" };
    const afterMs = response.status === 429 ? retryAfter(response) : undefined;
    return afterMs === undefined ? { kind: "later" } : { kind: "later", afterMs };
  }
  try {
    return { kind: "renewed", login: login((await response.json()) as TokenAnswer, refresh) };
  } catch {
    return { kind: "later" };
  }
}

async function get(url: string, access: string, headers: Record<string, string> = {}) {
  try {
    const response = await fetch(url, {
      headers: { ...OAUTH_HEADERS, authorization: `Bearer ${access}`, ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return (await response.json()) as Record<string, unknown>;
    await response.body?.cancel();
  } catch {
    // The account details and the model list are advisory: the sign-in does not fail on them.
  }
  return undefined;
}

const PLANS: Record<string, string> = {
  claude_max: "Max",
  claude_pro: "Pro",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
};

/**
 * The plan in a profile answer. Known only when the answer carried a plan
 * field (`organization_type` or a `has_claude_*` flag): a 200 without them
 * says nothing about the plan, and "Free" would be a guess.
 */
function planOf(
  answer:
    | {
        account?: { has_claude_max?: unknown; has_claude_pro?: unknown };
        organization?: { organization_type?: unknown };
      }
    | undefined,
): { plan: string; planKnown: boolean } {
  const type = text(answer?.organization?.organization_type);
  const max = answer?.account?.has_claude_max;
  const pro = answer?.account?.has_claude_pro;
  const planKnown = type !== undefined || typeof max === "boolean" || typeof pro === "boolean";
  if (!planKnown) return { plan: "", planKnown };
  return { plan: (type && PLANS[type]) ?? (max === true ? "Max" : pro === true ? "Pro" : "Free"), planKnown };
}

/** The plan, email and organisation Claude reports for the login (`/api/oauth/profile`). */
export async function accountDetails(
  addresses: Addresses,
  access: string,
): Promise<{ plan: string; planKnown: boolean; identity: Partial<Identity> }> {
  const answer = (await get(`${addresses.anthropic.api}/api/oauth/profile`, access)) as
    | {
        account?: { uuid?: unknown; email?: unknown; has_claude_max?: unknown; has_claude_pro?: unknown };
        organization?: { name?: unknown; organization_type?: unknown };
      }
    | undefined;
  return {
    ...planOf(answer),
    identity: {
      accountId: text(answer?.account?.uuid),
      email: text(answer?.account?.email),
      organization: text(answer?.organization?.name),
    },
  };
}

/** The models this login may use, by the names Claude gives them. */
export async function models(addresses: Addresses, access: string): Promise<{ id: string; name: string }[]> {
  const answer = await get(`${addresses.anthropic.api}/v1/models?limit=100`, access, {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": OAUTH_BETA,
  });
  const data = Array.isArray(answer?.data) ? (answer.data as { id?: unknown; display_name?: unknown }[]) : [];
  return data.flatMap((model) => {
    const id = text(model.id);
    return id ? [{ id, name: text(model.display_name) ?? id }] : [];
  });
}

/** Claude's sign-in, as the rest of the plugin uses every company's. */
export const claude: SignInCompany = {
  name: "Claude",
  link: signInLink,
  readPasted,
  exchange,
  renew,
  async details(addresses, { login }): Promise<Details> {
    const [about, found] = await Promise.all([
      accountDetails(addresses, login.access),
      models(addresses, login.access),
    ]);
    return { ...about, models: found };
  },
};
