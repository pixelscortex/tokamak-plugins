import { createHash, randomBytes } from "node:crypto";
import type { Company } from "../../src/server/addresses";

export const oauth = {
  anthropic: {
    client: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirect: "http://localhost:54545/callback",
    scope:
      "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  },
  openai: {
    client: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirect: "http://localhost:1455/auth/callback",
    // CLIProxyAPI's scope, as agent-proxy asks for it (Codex adds the two connector scopes).
    scope: "openid profile email offline_access",
  },
} as const;

export const challenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export function signInLink(company: Company, authorize: string) {
  const { client, redirect, scope } = oauth[company];
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const link = new URL(authorize);
  link.search = new URLSearchParams({
    client_id: client,
    redirect_uri: redirect,
    scope,
    response_type: "code",
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
    state,
    ...(company === "anthropic"
      ? { code: "true" }
      : {
          codex_cli_simplified_flow: "true",
          id_token_add_organizations: "true",
          originator: "codex_cli_rs",
        }),
  }).toString();
  return { link, verifier, state };
}

export function exchangeBody(
  company: Company,
  pasted: string,
  flow: ReturnType<typeof signInLink>,
): RequestInit {
  let code: string | null = pasted;
  let state: string | null = flow.state;
  if (/^https?:\/\//.test(pasted)) {
    const callback = new URL(pasted);
    code = callback.searchParams.get("code");
    state = callback.searchParams.get("state");
  } else if (company === "anthropic" && pasted.includes("#")) {
    [code, state] = pasted.split("#", 2);
  }
  if (!code || state !== flow.state || (company === "openai" && !/^https?:\/\//.test(pasted))) {
    throw new Error("Invalid callback or OAuth state");
  }
  const fields = {
    grant_type: "authorization_code",
    code,
    redirect_uri: oauth[company].redirect,
    client_id: oauth[company].client,
    code_verifier: flow.verifier,
  };
  return company === "anthropic"
    ? {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...fields, state }),
      }
    : { method: "POST", body: new URLSearchParams(fields) };
}

export function syntheticJwt(claims: object) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.synthetic`;
}
