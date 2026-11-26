import {
  LOCAL_USER,
  createFunctions,
  type DatabaseReader,
  type ModelFromSchema,
  type Id,
} from "@tokamak/sdk";
import schema from "./schema";

export const { query, mutation } = createFunctions(schema);

export const DEFAULT_TITLE = "New thread";
export type Model = ModelFromSchema<typeof schema>;

/** Who started the thread, including threads saved before chat stored a creator. */
export function threadCreatorId(thread: { createdBy?: string }): string {
  return thread.createdBy ?? LOCAL_USER;
}

export async function thread(db: DatabaseReader<Model>, id: Id<"threads">) {
  const value = await db.get(id);
  if (!value) throw new Error("Thread no longer exists");
  return value;
}

export function nonempty(text: string) {
  const value = text.trim();
  if (!value) throw new Error("Text must not be empty");
  return value;
}
