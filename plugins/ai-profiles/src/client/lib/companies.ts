import type { Company } from "./api";

/**
 * What the add-subscription dialog says for each company (Paper "2 · Add a
 * subscription"). The steps themselves are one flow for every company; only
 * these words differ. The sign-in, its link and what may be pasted are
 * agent-proxy's, one module per company.
 */
export interface CompanyWords {
  /** The company row and the method step's title. */
  readonly name: string;
  /** The subscription method and the plans under it. */
  readonly method: string;
  readonly plans: string;
  /** Where an API key would come from, under the disabled "API key" row. */
  readonly keys: string;
  /** "Sign in to Claude": the sign-in step's title. */
  readonly signIn: string;
  /**
   * Where the company's page sends the browser after sign-in, without its
   * query: the one place this is written. agent-proxy's company module sends
   * the same address in its link; `returnPort` and `returnPath` below are
   * derived from it for anything that listens there.
   */
  readonly returnAddress: string;
}

export const COMPANIES: readonly Company[] = ["anthropic", "openai"];

export const wordsOf: Record<Company, CompanyWords> = {
  anthropic: {
    name: "Anthropic",
    method: "Claude subscription",
    plans: "Pro · Max · Team · Enterprise",
    keys: "From the Anthropic console",
    signIn: "Sign in to Claude",
    returnAddress: "http://localhost:54545/callback",
  },
  openai: {
    name: "OpenAI",
    method: "ChatGPT subscription",
    plans: "Plus · Pro · Business · Enterprise",
    keys: "From the OpenAI platform",
    signIn: "Sign in to ChatGPT",
    returnAddress: "http://localhost:1455/auth/callback",
  },
};

/** The port the company's return address is on: 54545 for Claude, 1455 for ChatGPT. */
export const returnPort = (company: Company) => Number(new URL(wordsOf[company].returnAddress).port);

/** The path of the company's return address: `/callback`, `/auth/callback`. */
export const returnPath = (company: Company) => new URL(wordsOf[company].returnAddress).pathname;

/** The paste field's example: the return address as the browser shows it after sign-in. */
export const pasteExample = (company: Company) => `${wordsOf[company].returnAddress}?code=…`;
