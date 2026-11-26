import { createApi, type FunctionReference } from "@tokamak/sdk";
import type { SignInView, SubscriptionView } from "plugin:agent-proxy/server";
import { api } from "../../server/_generated/api";

export { api };
export type Subscription = SubscriptionView;
export type SignIn = SignInView;
export type Company = Subscription["company"];

/**
 * ai's own list of agents on this computer, for their marks: a company's logo
 * is the mark of its agent plugin (Claude for Anthropic, Codex for OpenAI).
 * This unscoped caller action keeps company marks separate from picker choices.
 */
export const ai = createApi<{
  agents: {
    list: FunctionReference<"action", { windowId: string }, readonly { id: string; icon?: string }[]>;
  };
}>("ai", ["agents:list"]);

/** The agent plugin whose mark stands for each company. */
export const agentOf: Record<Company, string> = { anthropic: "claude", openai: "codex" };

/** "Claude Pro": the product a company sells its subscription as, then the plan. */
export const productOf: Record<Company, string> = { anthropic: "Claude", openai: "ChatGPT" };
