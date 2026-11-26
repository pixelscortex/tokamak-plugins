import type { Id } from "@tokamak/sdk";
import { state } from "@tokamak/sdk/client";
import type { Folder } from "./api";

/** Drafts of the new, unsent thread live under this key. */
export const NEW_THREAD = "new";

/**
 * The thread on screen; undefined is the new thread. Not kept across restarts,
 * so opening the app always lands on a new thread.
 */
export const openThread = state<Id<"threads"> | undefined>(undefined);

/** Unsent text per thread, so switching threads never loses what was typed. */
export const drafts = state<Readonly<Record<string, string>>>({});

/** Where the new thread will work once it is sent; "No folder" until one is picked. */
export const newFolder = state<Folder>({ kind: "own" });

/** A folder picked with "Choose a folder…", offered first until it becomes a recent one. */
export const chosenFolder = state<string | undefined>(undefined);

/** The error line above the composer, shared by the new thread and an open one. */
export const error = state<string | undefined>(undefined);

export function draftOf(key: string): string {
  return drafts()[key] ?? "";
}

export function setDraft(key: string, text: string): void {
  drafts.set((all) => ({ ...all, [key]: text }));
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
