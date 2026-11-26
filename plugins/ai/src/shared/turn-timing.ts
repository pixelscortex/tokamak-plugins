export const FORCE_STOP_MS = 10_000;
/** How often the sender’s Runner tells the server that a turn it runs is still alive. */
export const BEAT_MS = 10_000;
/**
 * After this long without a sign of life the server ends the turn as
 * interrupted and frees its thread: the app that ran it has quit or crashed.
 * A slow agent in an open app keeps sending signs, so it is never interrupted.
 */
export const SILENCE_MS = 45_000;
/** The reason an interrupted turn shows: "Interrupted · Tokamak was closed". */
export const CLOSED = "Tokamak was closed";

export const RELOADED = "AI was reloaded while the turn was running.";
