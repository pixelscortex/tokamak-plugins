import type {} from "@tokamak/sdk/web";
import type { Company } from "./addresses";
import { claude } from "./claude";
import type { SignInCompany } from "./company";
import { openai } from "./openai";

/** Each company's sign-in by the name stored in `subscriptions.company` and `signIns.company`. */
export const companies: Record<Company, SignInCompany> = { anthropic: claude, openai };
