import { productOf, type Subscription } from "./api";

/**
 * "Claude Pro": the card's and the connected step's title. A plan the company
 * did not name is stored empty and the title is the product alone ("ChatGPT").
 */
export const titleOf = (subscription: Pick<Subscription, "company" | "plan">) =>
  [productOf[subscription.company], subscription.plan].filter(Boolean).join(" ");

/**
 * "Claude Pro, Personal": the title and the label, the name every control of a
 * card is called by ("Remove Claude Pro, Personal"), so two cards with the
 * same title never share one.
 */
export const nameOf = (subscription: Pick<Subscription, "company" | "plan" | "label">) =>
  [titleOf(subscription), subscription.label].filter(Boolean).join(", ");

/**
 * The data line under the emails: the organisation or workspace, as the
 * company names it, and nothing for an account with neither. The plan is not
 * repeated here: it is in the title ("ChatGPT Pro").
 */
export function workspaceLine(subscription: Subscription): string {
  return subscription.accounts.find((account) => account.organization)?.organization ?? "";
}

/** How many profile codes a card shows before the rest become "+N". */
export const CODES_SHOWN = 3;

/** The codes a card shows, and how many more there are. */
export function shownCodes(codes: readonly string[]): { shown: readonly string[]; more: number } {
  const fits = codes.length <= CODES_SHOWN;
  const shown = fits ? codes : codes.slice(0, CODES_SHOWN - 1);
  return { shown, more: codes.length - shown.length };
}

/** A model as people know it: Claude's own names lead with "Claude ", which the logo already says. */
export const modelName = (name: string) => name.replace(/^Claude\s+/, "");

export const countOf = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** When a subscription last carried a turn: "now", "12m ago", "3h ago", "3d ago". */
export function lastUse(at: number | undefined, now: number): string {
  if (at === undefined) return "not used yet";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
