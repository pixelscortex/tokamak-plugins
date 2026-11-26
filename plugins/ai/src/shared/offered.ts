import type { Info } from "../contracts";

/**
 * `wanted` when `offered` has it, else the first offered; undefined when
 * nothing is offered.
 */
export function offeredOrFirst(offered: readonly string[], wanted: string | undefined): string | undefined {
  return wanted !== undefined && offered.includes(wanted) ? wanted : offered[0];
}

/** What a person picked for a turn, before checking it against the agent. */
export interface Picked {
  readonly model?: string;
  readonly effort?: string;
  readonly speed?: string;
  readonly mode?: string;
}

/** The model the agent offers, and each of level, speed and mode only when offered. */
export interface Offered {
  readonly model: Info["models"][number] | undefined;
  readonly effort?: string;
  readonly speed?: string;
  readonly mode?: string;
}

/**
 * `picked` as the agent offers it now: an unknown model, level, speed or mode
 * falls back to the first offered, and one the agent offers none of is left
 * out. The window shows this and `run:turn` runs it, so both always agree.
 */
export function offered(info: Info, picked: Picked): Offered {
  const model = info.models.find((entry) => entry.id === picked.model) ?? info.models[0];
  const effort = offeredOrFirst(model?.efforts ?? [], picked.effort);
  const speed = offeredOrFirst(info.speeds, picked.speed);
  const mode = offeredOrFirst(info.modes, picked.mode);
  return {
    model,
    ...(effort !== undefined && { effort }),
    ...(speed !== undefined && { speed }),
    ...(mode !== undefined && { mode }),
  };
}
