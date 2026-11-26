import { v } from "@tokamak/sdk";

export const textPart = v.object({ type: v.literal("text"), text: v.string() });

// Accept the non-text parts in existing transcripts. New turns keep their
// steps, plans and permission questions in ai, outside the chat message.
const toolCompletion = {
  status: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
  result: v.optional(v.any()),
  summary: v.optional(v.string()),
  model: v.optional(v.string()),
  view: v.optional(v.string()),
  error: v.optional(v.string()),
};

export const toolPart = v.object({
  type: v.literal("tool"),
  callId: v.string(),
  plugin: v.string(),
  toolName: v.string(),
  args: v.any(),
  ...toolCompletion,
});
export const planPart = v.object({
  type: v.literal("plan"),
  entries: v.array(v.object({ content: v.string(), status: v.string(), priority: v.string() })),
});
// Count UTF-8 bytes without requiring Web APIs in mutations.
export function jsonBytes(value: unknown): number {
  let bytes = 0;
  for (const character of JSON.stringify(value) ?? "null") {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const permissionPart = v.object({
  type: v.literal("permission"),
  requestId: v.string(),
  callId: v.string(),
  title: v.string(),
  options: v.array(v.object({ optionId: v.string(), name: v.string(), kind: v.string() })),
  status: v.union(v.literal("pending"), v.literal("answered"), v.literal("expired"), v.literal("cancelled")),
  optionId: v.optional(v.string()),
});
