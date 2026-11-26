import { createServer, type RequestListener } from "node:http";
import { createServer as createTlsServer, type ServerOptions } from "node:https";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { gzipSync, zstdDecompressSync } from "node:zlib";
import type { Addresses, Company } from "../../src/server/addresses";
import { challenge, oauth, syntheticJwt } from "./oauth";
import type { Fixture } from "./recorder";
import { codexCommand, stream, turn } from "./stream";

export type Answer =
  | { kind: "normal" | "signed-out" | "overloaded" }
  | { kind: "limit"; resetAt: number; scope?: "account" | "model"; retryAfter?: string }
  | { kind: "partial-limit"; resetAt: number; scope?: "account" | "model" }
  | { kind: "codex-command"; command: string }
  | { kind: "bare-limit"; retryAfter?: string; headers?: Record<string, string>; body?: string }
  | { kind: "unified-limit"; resetAt: number };
/**
 * How the account's token endpoint answers: `unavailable` gives HTTP 503 and
 * `limited` HTTP 429 with `Retry-After: 120`, to the code exchange and to renewals alike.
 */
export type SignIn = "success" | "reject-code" | "expired" | "refuse-renewal" | "unavailable" | "limited";

function providerPath(path: string) {
  return path.replace(/^\/backend-api(?=\/)/, "");
}

function usageWindow(seconds: number) {
  return {
    used_percent: 0,
    limit_window_seconds: seconds,
    reset_after_seconds: seconds,
    reset_at: Math.floor(Date.now() / 1000) + seconds,
  };
}

/** ChatGPT's plan for a fake account: `plus` unless set; null when the account reports none. */
const chatgptPlan = (account: { plan?: string | null }) =>
  account.plan === undefined ? "plus" : account.plan;

export async function startFakeCompanies({
  delayMs = 10,
  tls,
}: { delayMs?: number; tls?: ServerOptions } = {}) {
  const nextSignIns = new Map<Company, string>();
  const accounts = new Map<
    string,
    {
      company: Company;
      id: string;
      accessToken: string;
      refreshToken: string;
      code: string;
      signIn: SignIn;
      answers: Answer[];
      expiresAt: number;
      generation: number;
      strict: boolean;
      /** Milliseconds the token endpoint waits before it answers for this account. */
      tokenDelayMs: number;
      rejectedAccess?: { token: string; delayMs?: number };
      /**
       * The plan the company reports: Claude's `organization_type` on the
       * profile read (`claude_pro` unless set), ChatGPT's `chatgpt_plan_type`
       * in the ID token and `plan_type` in the accounts check (`plus` unless
       * set; null leaves both out).
       */
      plan?: string | null;
      /** OpenAI: the workspace's name in `/wham/accounts/check`; none for a personal account. */
      workspace?: string;
      /** The models the models read lists, instead of the one fake model. */
      models?: { id: string; name: string }[];
      /**
       * `unavailable`: the profile and models reads answer HTTP 503; `empty`: the
       * profile read answers 200 with no plan, email or organisation in it.
       */
      reads?: "ok" | "unavailable" | "empty";
      authorization?: { challenge: string; state: string; redirect: string };
    }
  >();
  const requests: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
    rawBody: string;
    account?: string;
  }[] = [];
  const disconnected: string[] = [];
  let replay: Fixture["exchanges"] = [];
  /** Refresh tokens already used, by the account they belonged to (strict accounts revoke on reuse). */
  const usedRefresh = new Map<string, string>();

  function find(company: Company, value: string | undefined, key: "accessToken" | "refreshToken" | "code") {
    return [...accounts.values()].find((account) => account.company === company && account[key] === value);
  }

  async function handle(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/plugins\/agent-proxy\/[^/]+/, "");
    const route = providerPath(path.replace(/^\/(anthropic|openai)(?=\/)/, ""));
    const company: Company =
      path.startsWith("/anthropic/") ||
      (!path.startsWith("/openai/") && /^\/(v1\/|api\/oauth\/|api\/event_logging\/)/.test(route))
        ? "anthropic"
        : "openai";
    const headers = Object.fromEntries(request.headers);
    const raw =
      headers["content-encoding"] === "zstd"
        ? zstdDecompressSync(Buffer.from(await request.arrayBuffer())).toString("utf8")
        : await request.text();
    let body: unknown = raw || undefined;
    if (raw && headers["content-type"]?.includes("application/json")) {
      try {
        body = JSON.parse(raw);
      } catch {
        /* Keep malformed traffic in the request log. */
      }
    } else if (headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    const fields = body as Record<string, string> | undefined;
    const credential = headers.authorization?.replace(/^Bearer /i, "") ?? headers["x-api-key"];
    const renewal = fields?.grant_type === "refresh_token";
    const contentType = headers["content-type"] ?? "";
    const token = route === "/v1/oauth/token" || route === "/oauth/token";
    const authorize = route === "/oauth/authorize";
    const account = token
      ? find(company, renewal ? fields?.refresh_token : fields?.code, renewal ? "refreshToken" : "code")
      : authorize
        ? (accounts.get(nextSignIns.get(company) ?? "") ??
          [...accounts.values()].find((item) => item.company === company))
        : find(company, credential, "accessToken");
    requests.push({
      method: request.method,
      path: url.pathname + url.search,
      headers,
      body,
      rawBody: raw,
      account: account?.id,
    });

    const recorded = replay[0];
    if (recorded?.request.method === request.method && providerPath(recorded.request.path) === route) {
      replay.shift();
      const { status, headers: responseHeaders, chunks } = recorded.response;
      return chunks.length
        ? stream(chunks, responseHeaders, delayMs, status)
        : new Response(null, { status, headers: responseHeaders });
    }
    if (authorize && request.method === "GET") {
      if (!account || account.company !== company) return new Response("Unknown account", { status: 400 });
      const redirect = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const pkce = url.searchParams.get("code_challenge");
      if (
        account.strict &&
        (!pkce ||
          !state ||
          redirect !== oauth[company].redirect ||
          url.searchParams.get("code_challenge_method") !== "S256" ||
          url.searchParams.get("response_type") !== "code" ||
          // A ChatGPT login without offline_access has no refresh token, so it could never be renewed.
          (company === "openai" && !url.searchParams.get("scope")?.split(" ").includes("offline_access")) ||
          url.searchParams.get("client_id") !== oauth[company].client)
      ) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      nextSignIns.delete(company);
      if (pkce && state && redirect) account.authorization = { challenge: pkce, state, redirect };
      if (!redirect) return Response.json({ code: account.code, state });
      const callback = new URL(redirect);
      callback.searchParams.set("code", account.code);
      callback.searchParams.set("state", state ?? "");
      return Response.redirect(callback, 302);
    }
    if (token && request.method === "POST") {
      const invalidGrant = () => Response.json({ error: "invalid_grant" }, { status: 400 });
      // A refresh token sent twice: as companies that rotate tokens do, the whole login is revoked.
      const reused = renewal ? accounts.get(usedRefresh.get(String(fields?.refresh_token)) ?? "") : undefined;
      if (reused?.strict) {
        reused.generation++;
        reused.accessToken = `fake-${reused.id}-revoked-${reused.generation}`;
        reused.refreshToken = `fake-${reused.id}-revoked-refresh-${reused.generation}`;
        return invalidGrant();
      }
      if (account?.tokenDelayMs) await new Promise((done) => setTimeout(done, account.tokenDelayMs));
      if (account?.signIn === "unavailable") return Response.json({ error: "unavailable" }, { status: 503 });
      if (account?.signIn === "limited")
        return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "120" } });
      if (
        !account ||
        !fields ||
        (renewal ? account.signIn === "refuse-renewal" : account.signIn === "reject-code")
      ) {
        return invalidGrant();
      }
      if (account.strict) {
        const encoding =
          company === "openai" && !renewal ? "application/x-www-form-urlencoded" : "application/json";
        if (!contentType.startsWith(encoding) || fields.client_id !== oauth[company].client)
          return invalidGrant();
        if (!renewal) {
          const auth = account.authorization;
          if (
            !auth ||
            fields.grant_type !== "authorization_code" ||
            typeof fields.code_verifier !== "string" ||
            challenge(fields.code_verifier) !== auth.challenge ||
            fields.redirect_uri !== auth.redirect ||
            (company === "anthropic" && fields.state !== auth.state)
          ) {
            return invalidGrant();
          }
          account.authorization = undefined;
        }
      }
      if (renewal) {
        usedRefresh.set(account.refreshToken, account.id);
        account.generation++;
        account.accessToken = `fake-${account.id}-access-${account.generation}`;
        account.refreshToken = `fake-${account.id}-refresh-${account.generation}`;
      }
      const expires_in = !renewal && account.signIn === "expired" ? -1 : 3600;
      account.expiresAt = Date.now() + expires_in * 1000;
      return Response.json({
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        token_type: "Bearer",
        expires_in,
        ...(company === "openai"
          ? {
              id_token: syntheticJwt({
                email: `${account.id}@example.test`,
                exp: Math.floor(account.expiresAt / 1000),
                "https://api.openai.com/auth": {
                  chatgpt_account_id: account.id,
                  ...(chatgptPlan(account) !== null && { chatgpt_plan_type: chatgptPlan(account) }),
                  chatgpt_user_id: `user-${account.id}`,
                },
              }),
            }
          : {
              account: { uuid: account.id, email_address: `${account.id}@example.test` },
              organization: { uuid: "fake-org", name: "Fake organization" },
            }),
      });
    }
    if (route === "/api/event_logging/batch") return Response.json({});
    const isTurn =
      request.method === "POST" && ["/v1/messages", "/responses", "/codex/responses"].includes(route);
    const error = (status: number, type: string, responseHeaders?: ResponseInit["headers"]) =>
      Response.json(
        { type: "error", error: { type, code: type, message: `Fake ${type}` } },
        { status, headers: responseHeaders },
      );
    if (!account || account.expiresAt <= Date.now()) return error(401, "authentication_error");
    if (isTurn && account.rejectedAccess && credential === account.rejectedAccess.token) {
      const { delayMs } = account.rejectedAccess;
      if (delayMs) await new Promise((done) => setTimeout(done, delayMs));
      return error(401, "authentication_error");
    }
    if (isTurn && account.strict) {
      if (
        company === "anthropic" &&
        headers.authorization &&
        !headers["anthropic-beta"]?.split(",").some((value) => value.trim() === "oauth-2025-04-20")
      ) {
        return error(401, "authentication_error");
      }
      if (company === "openai" && headers["chatgpt-account-id"] !== account.id) {
        return error(401, "authentication_error");
      }
    }
    const answer = isTurn ? account.answers.shift() : undefined;
    if (answer?.kind === "signed-out") return error(401, "authentication_error");
    if (route === "/v1/messages/count_tokens") return Response.json({ input_tokens: 8 });
    if (
      account.reads === "unavailable" &&
      ["/models", "/codex/models", "/v1/models", "/api/oauth/profile"].includes(route)
    )
      return error(503, "api_error");
    if (company === "anthropic" && route === "/v1/models/claude-sonnet-4-6")
      return Response.json({ id: "claude-sonnet-4-6", type: "model", display_name: "Fake Sonnet" });
    if (company === "anthropic" && route === "/v1/models" && account.models)
      return Response.json({
        data: account.models.map((model) => ({ id: model.id, type: "model", display_name: model.name })),
        has_more: false,
      });
    if (["/models", "/codex/models", "/v1/models"].includes(route))
      return Response.json(
        company === "anthropic"
          ? {
              data: [
                {
                  id: "claude-sonnet-4-6",
                  type: "model",
                  display_name: "Fake Sonnet",
                  created_at: "2026-01-01T00:00:00Z",
                },
              ],
              first_id: "claude-sonnet-4-6",
              last_id: "claude-sonnet-4-6",
              has_more: false,
            }
          : {
              models: [
                {
                  slug: "gpt-5",
                  display_name: "Fake GPT",
                  description: "Fixture model",
                  supported_reasoning_levels: [],
                  shell_type: "disabled",
                  visibility: "list",
                  supported_in_api: true,
                  priority: 0,
                  support_verbosity: false,
                  default_reasoning_summary: "none",
                  supports_parallel_tool_calls: false,
                  base_instructions: "Answer briefly.",
                  truncation_policy: { mode: "tokens", limit: 4096 },
                  context_window: 32768,
                  experimental_supported_tools: [],
                  use_responses_lite: false,
                },
              ],
            },
      );
    if (route === "/api/oauth/profile" && account.reads === "empty") return Response.json({});
    if (route === "/api/oauth/profile")
      return Response.json({
        account: { uuid: account.id, email: `${account.id}@example.test`, has_claude_pro: true },
        organization: {
          uuid: "fake-org",
          name: "Fake organization",
          organization_type: account.plan ?? "claude_pro",
          rate_limit_tier: "default_claude_pro",
        },
      });
    if (route === "/api/oauth/claude_cli/roles")
      return Response.json({
        organization_role: "admin",
        workspace_role: null,
        organization_name: "Fake organization",
      });
    if (route === "/wham/settings/user") return Response.json({});
    if (route === "/codex/responses" && request.method === "GET" && headers.upgrade === "websocket") {
      // Codex treats 426 during the handshake as a request to fall back to HTTP SSE.
      return new Response(null, { status: 426 });
    }
    if (route === "/wham/accounts/check")
      return Response.json({
        accounts: [
          {
            id: account.id,
            name: account.workspace ?? null,
            plan_type: chatgptPlan(account),
            structure: account.workspace ? "workspace" : "personal",
            can_access_with_session: true,
            workspace_backend_origin: "NO_CONSTRAINT",
            account_routing_override: "NO_CONSTRAINT",
          },
        ],
        account_ordering: [account.id],
        default_account_id: account.id,
      });
    if (route === "/wham/usage")
      return Response.json({
        account_id: account.id,
        plan_type: "plus",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: usageWindow(5 * 3600),
          secondary_window: usageWindow(7 * 24 * 3600),
        },
      });
    if (!isTurn) return error(404, "not_found_error");
    if (answer?.kind === "overloaded")
      return company === "anthropic" ? error(529, "overloaded_error") : error(503, "server_is_overloaded");
    if (answer?.kind === "limit") {
      const reset = String(answer.resetAt);
      const headers = {
        "retry-after":
          answer.retryAfter ?? String(Math.max(0, answer.resetAt - Math.floor(Date.now() / 1000))),
      };
      if (company === "openai")
        return Response.json(
          {
            error: {
              type: "usage_limit_reached",
              resets_at: answer.resetAt,
              plan_type: "plus",
              message: "Fake limit",
            },
          },
          { status: 429, headers: { ...headers, "x-codex-primary-used-percent": "100" } },
        );
      const status = answer.scope === "model" ? "allowed" : "rejected";
      return error(429, "rate_limit_error", {
        ...headers,
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-5h-status": status,
        "anthropic-ratelimit-unified-7d-status": "allowed",
        ...(status === "rejected"
          ? {
              "anthropic-ratelimit-unified-reset": reset,
              "anthropic-ratelimit-unified-5h-reset": reset,
            }
          : { "anthropic-ratelimit-unified-overage-status": "rejected" }),
      });
    }
    if (answer?.kind === "bare-limit") {
      const headers = { ...answer.headers, ...(answer.retryAfter && { "retry-after": answer.retryAfter }) };
      return answer.body === undefined
        ? error(429, "rate_limit_error", headers)
        : stream([answer.body], { "content-type": "application/json", ...headers }, delayMs, 429);
    }
    const responseHeaders: Record<string, string> = { "content-type": "text/event-stream" };
    if (url.searchParams.has("cookies")) {
      responseHeaders["set-cookie"] = "upstream-session=fake";
      responseHeaders["set-cookie2"] = "upstream-session2=fake";
    }
    if (answer?.kind === "unified-limit") {
      responseHeaders["anthropic-ratelimit-unified-status"] = "rejected";
      responseHeaders["anthropic-ratelimit-unified-reset"] = String(answer.resetAt);
    }
    const chunks =
      answer?.kind === "codex-command"
        ? codexCommand(fields?.model ?? "fake", answer.command)
        : turn(company, fields?.model ?? "fake", answer?.kind === "partial-limit");
    if (isTurn && url.searchParams.has("gzip")) {
      const zipped = gzipSync(chunks.join(""));
      responseHeaders["content-encoding"] = "gzip";
      responseHeaders["content-length"] = String(zipped.length);
      return stream([zipped.subarray(0, 32), zipped.subarray(32)], responseHeaders, delayMs);
    }
    return stream(chunks, responseHeaders, delayMs);
  }

  const listener: RequestListener = async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const response = await handle(
        new Request(new URL(incoming.url ?? "/", address), {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          body: body.length ? body : undefined,
        }),
      );
      outgoing.once("close", () => {
        if (!outgoing.writableFinished) disconnected.push(incoming.url ?? "/");
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body)
        await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), outgoing);
      else outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  };
  const server = tls ? createTlsServer(tls, listener) : createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Fake company listener has no port");
  const address = `${tls ? "https" : "http"}://127.0.0.1:${bound.port}`;
  const addresses: Addresses = {
    anthropic: {
      api: `${address}/anthropic`,
      authorize: `${address}/anthropic/oauth/authorize`,
      token: `${address}/anthropic/v1/oauth/token`,
    },
    openai: {
      api: `${address}/openai/backend-api`,
      authorize: `${address}/openai/oauth/authorize`,
      token: `${address}/openai/oauth/token`,
    },
  };
  return {
    address,
    addresses,
    requests,
    disconnected,
    addAccount(
      company: Company,
      id: string,
      {
        signIn = "success",
        strict = true,
        plan,
        workspace,
      }: { signIn?: SignIn; strict?: boolean; plan?: string | null; workspace?: string } = {},
    ) {
      if (accounts.has(id)) throw new Error(`Duplicate fake account: ${id}`);
      const account = {
        company,
        id,
        signIn,
        strict,
        code: `fake-${id}-code`,
        accessToken: `fake-${id}-access`,
        refreshToken: `fake-${id}-refresh`,
        generation: 0,
        tokenDelayMs: 0,
        rejectedAccess: undefined as { token: string; delayMs?: number } | undefined,
        plan: plan as string | null | undefined,
        ...(workspace !== undefined && { workspace }),
        expiresAt: Infinity,
        answers: [] as Answer[],
        models: undefined as { id: string; name: string }[] | undefined,
        reads: "ok" as "ok" | "unavailable" | "empty",
      };
      accounts.set(id, account);
      return account;
    },
    nextSignIn(id: string) {
      const target = accounts.get(id);
      if (!target) throw new Error(`Unknown fake account: ${id}`);
      nextSignIns.set(target.company, id);
    },
    script(account: string, answers: Answer[]) {
      const target = accounts.get(account);
      if (!target) throw new Error(`Unknown fake account: ${account}`);
      target.answers = [...answers];
    },
    replay(fixture: Fixture) {
      replay = [...fixture.exchanges];
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
