import { isFailure, type FunctionReference, type TokamakClient } from "@tokamak/sdk";

const key = Symbol.for("tokamak.ai.windowId");
const windowScope = globalThis as typeof globalThis & { [key]?: string };
const listeners = new Map<TokamakClient, Set<() => void>>();

export function onCallerAction(client: TokamakClient, listener: () => void): () => void {
  const callbacks = listeners.get(client) ?? new Set();
  listeners.set(client, callbacks);
  callbacks.add(listener);
  return () => {
    callbacks.delete(listener);
    if (!callbacks.size) listeners.delete(client);
  };
}

/** Keep all calls in this window's scope, including across a plugin reload. */
export async function windowAction<A extends { windowId: string }, R>(
  client: TokamakClient,
  action: FunctionReference<"action", A, R>,
  args: NoInfer<Omit<A, "windowId">>,
): Promise<R> {
  const windowId = (windowScope[key] ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(""));
  const result = await client.action(action, { ...args, windowId } as A);
  if (!isFailure(result)) for (const listener of listeners.get(client) ?? []) listener();
  return result;
}
