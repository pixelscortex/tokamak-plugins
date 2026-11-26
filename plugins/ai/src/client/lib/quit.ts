import { isFailure } from "@tokamak/sdk";
import { onQuit } from "@tokamak/sdk/client";
import { api, connectedClient } from "./agents";
import { windowAction } from "./window-actions";

/** "Claude is still working in 1 thread", "Claude and Codex are still working in 3 threads". */
type Work = { readonly threadId: string; readonly agent: string };
function workingLine(turns: readonly Work[], queued: readonly Work[]): string {
  const agents = [...new Set((turns.length ? turns : queued).map((turn) => turn.agent))];
  const threads = new Set(turns.map((turn) => turn.threadId)).size;
  const who = agents.length === 1 ? agents[0] : `${agents.slice(0, -1).join(", ")} and ${agents.at(-1)}`;
  const active = `${agents.length === 1 ? "is" : "are"} still working in ${threads} thread${threads === 1 ? "" : "s"}`;
  const waiting = `${agents.length === 1 ? "has" : "have"} ${queued.length} queued message${queued.length === 1 ? "" : "s"}`;
  return `${who} ${turns.length ? active : waiting}${turns.length && queued.length ? ` and ${waiting}` : ""}`;
}

/**
 * Asks first when the person quits the app while turns run on this computer.
 * Stop and quit first stops this window starting queued turns (a stopped turn
 * frees its thread for the next one), then stops every turn and waits for it.
 */
export function guardQuit(pauseQueue: () => void): () => void {
  return onQuit(async () => {
    const client = connectedClient();
    if (!client) return undefined;
    const [turns, queued] = await Promise.all([
      windowAction(client, api.working.list, {}),
      client.query(api.turns.queuedForDevice, {}),
    ]);
    if (isFailure(turns)) return undefined;
    if (turns.length === 0 && queued.length === 0) return undefined;
    return {
      message: workingLine(turns, queued),
      stop: async () => {
        pauseQueue();
        await windowAction(client, api.working.stopAll, {});
      },
    };
  });
}
