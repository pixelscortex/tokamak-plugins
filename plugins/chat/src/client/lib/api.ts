import type { Doc } from "@tokamak/sdk";
import type { Model } from "../../server/_functions";

export { api } from "../../server/_generated/api";
export type { Folder } from "../../server/folders/folder";
export type Thread = Doc<Model, "threads">;
/** A stored message as windows see it (without the reply token). */
export type MessageDoc = Omit<Doc<Model, "messages">, "replyToken">;
