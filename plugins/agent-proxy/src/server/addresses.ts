import type { ActionContext } from "@tokamak/sdk";
import type {} from "@tokamak/sdk/web";

export const addressesVariable = "TOKAMAK_AGENT_PROXY_ADDRESSES";

const production = {
  anthropic: {
    authorize: "https://claude.ai/oauth/authorize",
    token: "https://platform.claude.com/v1/oauth/token",
    api: "https://api.anthropic.com",
  },
  openai: {
    authorize: "https://auth.openai.com/oauth/authorize",
    token: "https://auth.openai.com/oauth/token",
    api: "https://chatgpt.com/backend-api",
  },
} as const;

export type Company = keyof typeof production;
export type Addresses = { [C in Company]: { [K in keyof (typeof production)[C]]: string } };

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function address(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || !/^https?:\/\//.test(value)) return false;
  const url = new URL(value);
  return Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
}

export async function companyAddresses(ctx: Pick<ActionContext, "env">): Promise<Addresses> {
  const override = await ctx.env(addressesVariable);
  if (override === null) return { anthropic: { ...production.anthropic }, openai: { ...production.openai } };
  try {
    const value: unknown = JSON.parse(override);
    if (
      exact(value, ["anthropic", "openai"]) &&
      [value.anthropic, value.openai].every(
        (provider) =>
          exact(provider, ["authorize", "token", "api"]) && Object.values(provider).every(address),
      )
    )
      return value as Addresses;
  } catch {
    // Do not return the value in an error visible to callers.
  }
  throw new Error(
    `Invalid ${addressesVariable}: expected authorize, token, and api HTTP URLs for both providers`,
  );
}
