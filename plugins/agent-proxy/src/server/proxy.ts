import { httpAction, type HttpActionContext, type Id } from "@tokamak/sdk";
import type {} from "@tokamak/sdk/web";
import { internal } from "./_generated/internal";
import { companyAddresses, type Company } from "./addresses";
import { OAUTH_BETA } from "./claude";
import { retryAfter } from "./company";
import { turnKeyHash } from "./sets";

const error = (status: number, type: string, message: string, headers?: HeadersInit) =>
  Response.json({ type: "error", error: { type, message } }, { status, headers });

function requestKey(headers: Headers) {
  const apiKey = headers.get("x-api-key");
  const auth = headers.get("authorization");
  const bearer = auth?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1];
  if (auth !== null && (!bearer || (apiKey !== null && apiKey !== bearer))) return null;
  const key = bearer ?? apiKey;
  return key && turnKeyHash(key);
}

const MAX_LIMIT_BODY = 64 * 1024;

async function openaiLimitBody(response: Response, now: number) {
  if (!response.body || Number(response.headers.get("content-length")) > MAX_LIMIT_BODY) return;
  const reader = response.clone().body!.getReader();
  try {
    const bytes = new Uint8Array(MAX_LIMIT_BODY);
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_LIMIT_BODY) return;
      bytes.set(value, size);
      size += value.byteLength;
    }
    const body = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))) as {
      error?: { type?: string; resets_at?: number; resets_in_seconds?: number };
    } | null;
    const limit = body?.error;
    if (limit?.type !== "usage_limit_reached") return;
    const at = typeof limit.resets_at === "number" ? limit.resets_at * 1000 : 0;
    if (Number.isFinite(at) && at > now) return at;
    if (typeof limit.resets_in_seconds === "number") return resetAfter(limit.resets_in_seconds, now);
  } catch {
    // A non-JSON or unreadable body leaves the header fallbacks in charge.
  } finally {
    // The clone's cancellation may wait for the forwarded branch to finish.
    void reader.cancel().catch(() => {});
  }
}

function resetAfter(seconds: number, now: number) {
  const at = now + seconds * 1000;
  if (Number.isFinite(at) && at > now) return at;
}

function openaiLimitHeaders(headers: Headers, now: number) {
  const windows = ["primary", "secondary"].map((name) => ({
    reset: resetAfter(Number(headers.get(`x-codex-${name}-reset-after-seconds`)), now) ?? 0,
    exhausted: Number(headers.get(`x-codex-${name}-used-percent`)) >= 100,
  }));
  const exhausted = Math.max(0, ...windows.filter(({ exhausted }) => exhausted).map(({ reset }) => reset));
  return exhausted || windows[0]!.reset || windows[1]!.reset;
}

async function accountLimit(response: Response, company: Company): Promise<number> {
  const now = Date.now();
  let rejected = response.status === 429;
  let reset = 0;
  for (const prefix of company === "openai"
    ? []
    : ["anthropic-ratelimit-unified", "anthropic-ratelimit-unified-5h", "anthropic-ratelimit-unified-7d"]) {
    if (response.headers.get(`${prefix}-status`)?.toLowerCase() !== "rejected") continue;
    rejected = true;
    const at = Number(response.headers.get(`${prefix}-reset`)) * 1000;
    if (Number.isFinite(at) && at > now) reset = Math.max(reset, at);
  }
  if (!rejected) return 0;
  if (company === "openai")
    reset = (await openaiLimitBody(response, now)) ?? openaiLimitHeaders(response.headers, now);
  const unified =
    company === "anthropic" ? Number(response.headers.get("anthropic-ratelimit-unified-reset")) * 1000 : 0;
  if (Number.isFinite(unified) && unified > now) reset = Math.max(reset, unified);
  const wait = retryAfter(response);
  return reset || now + (wait !== undefined && Number.isFinite(wait) ? Math.max(1000, wait) : 60_000);
}

function unavailable(
  { accounts, earliestReset }: { accounts: unknown[]; earliestReset: number },
  name: string,
) {
  if (!accounts.length && earliestReset)
    return error(429, "rate_limit_error", `${name} subscriptions in this set are rate limited.`, {
      "retry-after": String(Math.max(1, Math.ceil((earliestReset - Date.now()) / 1000))),
    });
  return error(403, "permission_error", `No usable ${name} subscription in this set.`);
}

function claudeHeaders(incoming: Headers, access: string) {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (
      ["content-type", "content-encoding", "accept", "user-agent", "x-app", "accept-encoding"].includes(
        name,
      ) ||
      ["anthropic-", "x-stainless-", "x-claude-"].some((prefix) => name.startsWith(prefix))
    )
      headers.set(name, value);
  }
  // Claude's subscription API uses Bearer + the OAuth beta instead of an API key.
  headers.set("authorization", `Bearer ${access}`);
  const betas = headers.get("anthropic-beta");
  if (!betas?.split(",").some((beta) => beta.trim() === OAUTH_BETA))
    headers.set("anthropic-beta", betas ? `${betas},${OAUTH_BETA}` : OAUTH_BETA);
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  return headers;
}

// HTTP Responses headers from Codex's core client and CLIProxyAPI's Codex executor.
const codexHeaders = [
  "content-type",
  "content-encoding",
  "accept",
  "accept-encoding",
  "user-agent",
  "openai-beta",
  "originator",
  "version",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-openai-subagent",
  "x-codex-installation-id",
  "x-codex-routing-hint",
  "x-codex-turn-state",
  "x-codex-turn-metadata",
  "x-codex-parent-thread-id",
  "x-codex-window-id",
  "x-codex-beta-features",
  "x-openai-internal-codex-responses-lite",
];

function openaiHeaders(incoming: Headers, access: string, workspace: string) {
  const headers = new Headers();
  for (const name of codexHeaders) {
    const value = incoming.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${access}`);
  headers.set("chatgpt-account-id", workspace);
  if (!headers.has("originator")) headers.set("originator", "codex_cli_rs");
  return headers;
}

function provider(method: string, path: string | undefined) {
  if (!path) return;
  if (method === "POST" && path === "openai/responses")
    return { company: "openai", name: "ChatGPT", upstream: "/codex/responses" } as const;
  if (allowsClaude(method, path)) return { company: "anthropic", name: "Claude" } as const;
}

function allowsClaude(method: string, path: string) {
  if (method === "POST") return path === "v1/messages" || path === "v1/messages/count_tokens";
  return method === "GET" && (path === "v1/models" || /^v1\/models\/(?!\.{1,2}$)[\w.-]+$/.test(path));
}

function targetUrl(base: string, remainder: string, requestUrl: string) {
  const query = requestUrl.indexOf("?");
  return base.replace(/\/$/, "") + remainder + (query === -1 ? "" : requestUrl.slice(query));
}

type Candidate = { id: Id<"accounts">; subscription: Id<"subscriptions"> };
type Credential = { access: string; expiresAt: number };

const discard = (response?: Response) => response?.body?.cancel();

function forward(response: Response) {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.delete("set-cookie2");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function recordForward(
  ctx: HttpActionContext,
  owner: string,
  candidate: Candidate,
  credential: Credential,
  response: Response,
  company: Company,
) {
  const account = { owner, account: candidate.id };
  const limitedUntil = await accountLimit(response, company);
  if (response.ok || limitedUntil)
    await ctx.runMutation(internal.sets.recordForward, {
      ...account,
      subscription: candidate.subscription,
      limitedUntil,
      success: response.ok,
    });
  if (response.status === 401)
    await ctx.runMutation(internal.logins.rejectAccess, { ...account, ...credential });
}

function replaced(before: Credential, after: Credential & { renewed: boolean }) {
  return after.renewed || before.access !== after.access || before.expiresAt !== after.expiresAt;
}

export const proxy = httpAction({
  path: "/:set/*",
  async handler(ctx, request) {
    const endpoint = provider(request.method, ctx.params["*"]);
    if (!endpoint) return error(404, "not_found_error", "API endpoint not found.");
    const { company, name } = endpoint;
    const hash = requestKey(request.headers);
    if (!hash) return error(401, "authentication_error", "Missing or invalid turn key.");

    let response: Response | undefined;
    try {
      const args = { set: ctx.params.set!, hash, company };
      const candidates = () => ctx.runQuery(internal.sets.candidates, args);
      const route = await candidates();
      if (!route.ok) return error(401, "authentication_error", route.error);
      const { owner } = route;
      const addresses = await companyAddresses(ctx);
      // Match decoded segments, but keep the original Claude path spelling on the wire.
      const path =
        endpoint.company === "openai" ? endpoint.upstream : ctx.path.slice(ctx.path.indexOf("/", 1));
      const url = targetUrl(addresses[company].api, path, request.url);
      // The server buffers and bounds HTTP action uploads. Keep those bytes for one retry.
      const body = request.body ? await request.arrayBuffer() : undefined;
      const lookup = (candidate: Candidate) => ({ owner, account: candidate.id });

      async function send(
        candidate: Candidate,
        { access, expiresAt, workspace }: Credential & { workspace?: string },
      ) {
        if (company === "openai" && !workspace) return null;
        // Recheck after renewal: the turn or the account may have changed meanwhile.
        const current = await candidates();
        if (!current.ok) return { error: error(401, "authentication_error", current.error) };
        if (!current.accounts.some(({ id }) => id === candidate.id)) return null;
        if (request.signal.aborted) return { error: new Response(null, { status: 499 }) };
        if (current.touch) {
          const expired = await ctx.runMutation(internal.sets.touch, args);
          if (expired) return { error: error(401, "authentication_error", expired) };
        }
        await discard(response);
        response = await fetch(url, {
          method: request.method,
          headers:
            workspace && company === "openai"
              ? openaiHeaders(request.headers, access, workspace)
              : claudeHeaders(request.headers, access),
          body,
          redirect: "manual",
          signal: request.signal,
        });
        await recordForward(ctx, owner, candidate, { access, expiresAt }, response, company);
        return { upstream: response };
      }

      async function next(accounts: Candidate[]) {
        for (const candidate of accounts) {
          const login = await ctx.runAction(internal.logins.fresh, lookup(candidate));
          if (!login) continue;
          const sent = await send(candidate, login);
          if (sent) return { ...sent, candidate, login };
        }
        return null;
      }

      async function recover(candidate: Candidate, rejected: Credential, upstream: Response) {
        // send() expired the rejected login. fresh() uses the existing claim or
        // sees the replacement another request already obtained.
        const account = lookup(candidate);
        const renewed = await ctx.runAction(internal.logins.fresh, account);
        if (renewed && replaced(rejected, renewed)) {
          const retry = await send(candidate, renewed);
          if (retry?.error) await discard(upstream);
          return retry?.error ?? retry?.upstream ?? upstream;
        }
        if (!(await ctx.runQuery(internal.logins.isSignedOut, account))) return upstream;

        const current = await candidates();
        if (!current.ok) {
          await discard(upstream);
          return error(401, "authentication_error", current.error);
        }
        const retry = await next(current.accounts.filter(({ id }) => id !== account.account));
        if (retry?.upstream) return retry.upstream;
        await discard(upstream);
        return retry?.error ?? unavailable(current, name);
      }

      const first = await next(route.accounts);
      if (!first) {
        const current = await candidates();
        return current.ok ? unavailable(current, name) : error(401, "authentication_error", current.error);
      }
      if (first.error) return first.error;
      if (first.upstream.status !== 401) return forward(first.upstream);
      return forward(await recover(first.candidate, first.login, first.upstream));
    } catch {
      await discard(response)?.catch(() => {});
      // Fetch and host errors may carry request details. Never surface those.
      return error(502, "api_error", `The ${name} request could not be forwarded.`);
    }
  },
});
