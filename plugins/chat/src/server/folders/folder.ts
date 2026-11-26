import { v, type Infer } from "@tokamak/sdk";

/** A thread's folder: one the person chose, or ("No folder") an empty one of its own. */
export const folder = v.union(
  v.object({ kind: v.literal("chosen"), path: v.string() }),
  v.object({ kind: v.literal("own"), path: v.optional(v.string()) }),
);
export type Folder = Infer<typeof folder>;
