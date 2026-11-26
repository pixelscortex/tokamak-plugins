import { contract, type Id } from "@tokamak/sdk";

/** What `threadDeletedServer` providers get: the thread being deleted. */
export interface DeletedServerThread {
  readonly threadId: string;
}

export interface ThreadDeletedServer {
  after(thread: DeletedServerThread): Promise<void>;
}

/** What `threadDeletedLocal` providers get, on the client that deleted the thread. */
export interface DeletedThread {
  readonly threadId: Id<"threads">;
  /** The stored path, if this thread had a folder. */
  readonly folder?: string;
}

export interface ThreadDeletedLocal {
  after(thread: DeletedThread): Promise<void>;
}

/** Deletes related server data in the same mutation as the thread. */
export const threadDeletedServer = contract<ThreadDeletedServer>("threadDeletedServer");

/** Runs on the client that deleted a thread, once the server has accepted the delete. */
export const threadDeletedLocal = contract<ThreadDeletedLocal>("threadDeletedLocal", {
  on: "caller",
  dataMethods: true,
});
