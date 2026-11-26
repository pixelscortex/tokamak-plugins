import type { DatabaseReader, DatabaseWriter, Id, Infer } from "@tokamak/sdk";
import type { Model, Turn } from "./_functions";
import { append, line, TEXT_BYTES } from "./limits";
import type { stepReport } from "./schema";

/** A turn's step rows, written by `turns:write` as the agent reports them. */

/** Adds a step at the end of the turn, or replaces the step with the same key. */
export async function putStep(
  db: DatabaseWriter<Model>,
  turnId: Id<"turns">,
  report: Infer<typeof stepReport>,
) {
  const step = {
    ...report,
    title: line(report.title),
    ...(report.detail !== undefined && { detail: line(report.detail) }),
    ...(report.text !== undefined && { text: append("", report.text, TEXT_BYTES) }),
  };
  const known = await db
    .query("steps")
    .withIndex("by_turnId_key", (q) => q.eq("turnId", turnId).eq("key", step.key))
    .first();
  if (known) {
    // Replace, not patch: a field the latest report leaves out (a cleared detail) goes away too.
    await db.replace(known._id, { ...step, turnId, n: known.n });
    return;
  }
  const last = await db
    .query("steps")
    .withIndex("by_turnId_n", (q) => q.eq("turnId", turnId))
    .order("desc")
    .first();
  await db.insert("steps", { ...step, turnId, n: last ? last.n + 1 : 0 });
}

/** The closed actions line's facts, kept on the turn: how many tool steps, and the latest one still running. */
export async function summary(
  db: DatabaseReader<Model>,
  turnId: Id<"turns">,
): Promise<Pick<Turn, "actions" | "current">> {
  const all = await db
    .query("steps")
    .withIndex("by_turnId_n", (q) => q.eq("turnId", turnId))
    .collect();
  const running = [...all].reverse().find((step) => step.state === "running");
  return {
    actions: all.filter((step) => step.type === "tool").length,
    current: running && {
      type: running.type,
      ...(running.kind !== undefined && { kind: running.kind }),
      ...(running.name !== undefined && { name: running.name }),
      title: running.title,
      startedAt: running.startedAt,
    },
  };
}
