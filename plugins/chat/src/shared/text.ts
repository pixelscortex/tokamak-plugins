import type { Doc } from "@tokamak/sdk";
import type { Model } from "../server/_functions";

/**
 * A message's text: its text parts, separated by blank lines. Rows written by
 * the old agent path keep other parts; only their text counts.
 */
export function textOf(message: Pick<Doc<Model, "messages">, "parts">): string {
  return message.parts.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n\n");
}
