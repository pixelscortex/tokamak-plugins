import type { Id, CallerActionContext } from "@tokamak/sdk";
import { BEAT_MS, SILENCE_MS } from "../shared/turn-timing";
import { api } from "./_generated/api";

const seconds = SILENCE_MS / 1_000;
const ENDED_BY_SERVER = `The server heard nothing from this computer for ${seconds} seconds and ended the turn`;
const SERVER_LOST = `This computer could not reach the server for ${seconds} seconds, so it stopped the agent`;

/**
 * The sign of life of one turn, sent from the Runner that runs it: at once,
 * then every BEAT_MS until `stop`, whatever the agent is doing (writing,
 * thinking quietly, waiting for an answer). `ended(reason)` runs once, so the
 * caller stops the agent, when the server answers that the turn has already
 * ended (the computer slept past the limit, say), or when no beat has got
 * through for SILENCE_MS: by then the server ends the turn too, so an agent
 * left running would only write into a closed reply.
 */
export function keepAlive(ctx: CallerActionContext, turnId: Id<"turns">, ended: (reason: string) => void) {
  let stopped = false;
  let heard = Date.now();
  let ticked = heard;
  function end(reason: string) {
    if (stopped) return;
    stop();
    ended(reason);
  }
  const beat = () => {
    const now = Date.now();
    // A suspended Runner could not check the server while it slept.
    // Give the server a chance to answer and start a fresh outage clock.
    if (now - ticked >= SILENCE_MS) heard = now;
    ticked = now;
    if (now - heard >= SILENCE_MS) return end(SERVER_LOST);
    ctx.runMutation(api.liveness.beat, { turnId }).then(
      (alive) => {
        heard = Date.now();
        if (!alive) end(ENDED_BY_SERVER);
      },
      () => {},
    );
  };
  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  const timer = setInterval(beat, BEAT_MS);
  beat();
  return { stop };
}
