import { isFailure, type TokamakClient } from "@tokamak/sdk";
import { BEAT_MS } from "../../shared/turn-timing";
import { api } from "./agents";
import { windowAction } from "./window-actions";

/** Allow time for the old window's calls to close and its last beat to go stale. */
const TRIES = 4;

/**
 * Once this window can reach its Runner, release stale turns from closed
 * windows on this device instead of waiting for the server's 45-second limit.
 * Fresh heartbeats keep other windows' turns alive.
 */
export async function releaseOrphanedTurns(client: TokamakClient): Promise<void> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const turns = await windowAction(client, api.working.list, {});
    if (isFailure(turns)) return;
    const running = turns.map((turn) => turn.turnId);
    const pending = await client.mutation(api.liveness.release, { running });
    // A reconnect can still see calls from the old window while its socket is closing.
    if (pending === 0 && running.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, BEAT_MS));
  }
}
