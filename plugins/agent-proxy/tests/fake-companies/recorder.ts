import { writeFile } from "node:fs/promises";
import { syntheticJwt } from "./oauth";

export interface Fixture {
  exchanges: {
    request: { method: string; path: string; headers: Record<string, string>; body: string };
    response: { status: number; headers: Record<string, string>; chunks: string[] };
  }[];
}

const secretField =
  /(?:^(?:access_token|refresh_token|code_verifier|code_challenge|state|client_secret|email(?:_?address)?|uuid|id|prompt_cache_key)$|_(?:id|uuid)$)/i;
const messageField =
  /(?:^(?:text|delta|input|content|instructions|system|prompt|message|title|detail|error_description)$|name$)/i;

export function cleanFixture(fixture: Fixture, replacements: Record<string, string> = {}): Fixture {
  const values = new Map(Object.entries(replacements).filter(([value]) => value.length > 0));
  function placeholder(value: string, label: string) {
    if (!value) return value;
    if (!values.has(value)) values.set(value, `fake-${label}-${values.size + 1}`);
    return values.get(value)!;
  }
  function replacePrivateText(value: string) {
    for (const [original, replacement] of Object.entries(replacements)) {
      if (original) value = value.replaceAll(original, () => replacement);
    }
    return value.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "fixture@example.test");
  }
  function cleanJwt(token: string) {
    let account: unknown;
    let plan: unknown;
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
      account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
      plan = claims["https://api.openai.com/auth"]?.chatgpt_plan_type;
    } catch {
      // No opaque or unknown claims get copied.
    }
    return syntheticJwt({
      email: "fixture@example.test",
      exp: 4102444800,
      "https://api.openai.com/auth": {
        chatgpt_account_id: typeof account === "string" ? placeholder(account, "account_id") : "fake-account",
        chatgpt_plan_type: ["free", "plus", "pro", "team", "business", "enterprise", "edu"].includes(
          String(plan),
        )
          ? plan
          : "plus",
      },
    });
  }
  function clean(value: unknown, key = "", secretCode = false): unknown {
    if (/^(?:client_)?metadata$/i.test(key)) return typeof value === "string" ? "[fixture metadata]" : {};
    if (typeof value === "string") {
      if (key === "id_token") return cleanJwt(value);
      if (secretField.test(key) || (secretCode && key === "code")) return placeholder(value, key);
      if (messageField.test(key)) return "[sample text]";
      return values.get(value) ?? replacePrivateText(value);
    }
    if (Array.isArray(value)) return value.map((entry) => clean(entry, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, clean(v, k, secretCode && key === "")]),
      );
    return value;
  }
  const routes = new Set(
    "api oauth authorize token callback auth v1 backend-api codex responses messages count_tokens models profile claude_cli roles wham usage accounts organizations workspaces check profiles me".split(
      " ",
    ),
  );
  function cleanPath(path: string) {
    return new URL(path, "http://127.0.0.1").pathname
      .split("/")
      .map((part) => (!part || routes.has(part) ? part : placeholder(decodeURIComponent(part), "path_id")))
      .join("/");
  }
  function cleanBody(raw: string, encoding = "", tokenRequest = false) {
    if (!raw) return "";
    if (encoding.includes("text/event-stream")) {
      // Network chunks can split JSON, line breaks and UTF-8 anywhere.
      return raw
        .split(/\r?\n\r?\n/)
        .filter(Boolean)
        .map(
          (frame) =>
            frame
              .split(/\r?\n/)
              .flatMap((line) => {
                if (line.startsWith("event:")) return [line];
                if (!line.startsWith("data:")) return [];
                const data = line.slice(5).trim();
                return [`data: ${data === "[DONE]" ? data : JSON.stringify(clean(JSON.parse(data)))}`];
              })
              .join("\n") + "\n\n",
        );
    }
    if (encoding.includes("application/x-www-form-urlencoded")) {
      const safe = clean(Object.fromEntries(new URLSearchParams(raw)), "", tokenRequest) as Record<
        string,
        string
      >;
      return new URLSearchParams(safe).toString();
    }
    if (!encoding.includes("json")) return "[omitted non-JSON body]";
    return JSON.stringify(clean(JSON.parse(raw), "", tokenRequest));
  }
  function safeHeaders(headers: Record<string, string>) {
    const safe: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (name === "authorization" || name === "x-api-key" || name === "chatgpt-account-id") {
        const bearer = /^Bearer /i.test(value);
        safe[name] = (bearer ? "Bearer " : "") + placeholder(bearer ? value.slice(7) : value, "credential");
      } else if (name === "location") {
        const url = new URL(value, "http://127.0.0.1");
        const fields = ["code", "state", "error"].flatMap((key) => {
          const value = url.searchParams.get(key);
          return value === null ? [] : [[key, String(clean(value, key, true))]];
        });
        safe[name] = `/callback?${new URLSearchParams(fields)}`;
      } else if (
        /^(?:content-type|anthropic-beta|anthropic-version|retry-after|anthropic-ratelimit-[a-z0-9_-]+|x-codex-(?:(?:[a-z0-9-]+-)?(?:primary|secondary)-(?:used-percent|window-minutes|reset-at|reset-after-seconds)|active-limit|rate-limit-reached-type|credits-(?:balance|has-credits|unlimited)|plan-type))$/.test(
          name,
        )
      ) {
        safe[name] = replacePrivateText(value);
      }
    }
    return safe;
  }
  return {
    exchanges: fixture.exchanges.map(({ request, response }) => {
      const path = cleanPath(request.path);
      const requestBody = cleanBody(
        request.body,
        request.headers["content-type"],
        path.endsWith("/oauth/token"),
      );
      const responseBody = cleanBody(response.chunks.join(""), response.headers["content-type"]);
      return {
        request: {
          method: request.method,
          path,
          headers: safeHeaders(request.headers),
          body: String(requestBody),
        },
        response: {
          status: response.status,
          headers: safeHeaders(response.headers),
          chunks: Array.isArray(responseBody) ? responseBody : responseBody ? [responseBody] : [],
        },
      };
    }),
  };
}

// An owner wraps their own HTTP client. Keep the unredacted exchange in memory
// and write only after all replies (including streams) have ended.
export function createRecorder(transport: typeof fetch = fetch) {
  const fixture: Fixture = { exchanges: [] };
  const pending: Promise<void>[] = [];
  return {
    async fetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
      const request = new Request(input, init);
      const body = await request.clone().text();
      const url = new URL(request.url);
      const exchange: Fixture["exchanges"][number] = {
        request: {
          method: request.method,
          path: url.pathname + url.search,
          headers: Object.fromEntries(request.headers),
          body,
        },
        response: { status: 0, headers: {}, chunks: [] },
      };
      const response = await transport(request, { redirect: "manual" });
      exchange.response.status = response.status;
      exchange.response.headers = Object.fromEntries(response.headers);
      fixture.exchanges.push(exchange);
      const capture = response
        .clone()
        .text()
        .then((text) => {
          exchange.response.chunks = text ? [text] : [];
        });
      // A truncated response makes save fail without an unhandled rejection.
      void capture.catch(() => {});
      pending.push(capture);
      return response;
    },
    async save(path: string, replacements?: Record<string, string>) {
      await Promise.all(pending);
      await writeFile(path, JSON.stringify(cleanFixture(fixture, replacements), null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    },
  };
}
