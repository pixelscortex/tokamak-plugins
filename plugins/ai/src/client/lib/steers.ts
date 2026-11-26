import type { Turn } from "./replies";

/** One piece of a steered reply's body, in reading order. */
export type BodyPiece =
  | { readonly kind: "text"; readonly text: string }
  /** A follow-up the person sent while the agent replied; `pending` until the agent took it. */
  | { readonly kind: "steer"; readonly text: string; readonly pending: boolean };

type Steers = Pick<Turn, "steers" | "steerOffsets" | "pendingSteer">;

/** Whether a turn has a steer to draw, delivered or still on its way. */
export function hasSteers(turn: Steers | undefined): boolean {
  return Boolean(turn?.steers?.length) || turn?.pendingSteer !== undefined;
}

/**
 * Splits a reply's text at its steers: text, steer, text, ... Each delivered
 * steer sits where the reply's text ended when it was sent (`steerOffsets`);
 * a turn without offsets (its steers predate them) draws them all after the
 * text, and the pending steer always comes last. Whitespace at each split is
 * trimmed, since agents start the text after a steer on a new paragraph, and
 * empty text pieces are dropped. A steer never lands inside a code fence: one
 * sent while a fence was open moves to just after that fence's closing line.
 */
export function steeredBody(text: string, turn: Steers): BodyPiece[] {
  const steers = turn.steers ?? [];
  const offsets = turn.steerOffsets?.length === steers.length ? turn.steerOffsets : undefined;
  const pieces: BodyPiece[] = [];
  const addText = (slice: string) => {
    const trimmed = slice.trim();
    if (trimmed) pieces.push({ kind: "text", text: trimmed });
  };
  let from = 0;
  steers.forEach((steer, n) => {
    const at = offsets ? afterFence(text, Math.min(Math.max(offsets[n]!, from), text.length)) : text.length;
    addText(text.slice(from, at));
    pieces.push({ kind: "steer", text: steer, pending: false });
    from = at;
  });
  addText(text.slice(from));
  if (turn.pendingSteer !== undefined) pieces.push({ kind: "steer", text: turn.pendingSteer, pending: true });
  return pieces;
}

/** A Markdown fence line: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * `at`, or, when `at` falls inside an open code fence, the end of the line
 * that closes it (the end of the text when the fence never closes).
 */
function afterFence(text: string, at: number): number {
  let open: string | undefined;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    // Every line before this one was scanned with no fence left open: `at` is outside any fence.
    if (lineStart >= at && open === undefined) return at;
    const line = text.slice(lineStart, lineEnd);
    const fence = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (open === undefined) open = fence;
      // A closing fence is the same character, at least as long, with nothing after it.
      else if (fence[0] === open[0] && fence.length >= open.length && !line.trim().slice(fence.length)) {
        open = undefined;
        // `at` was after the opening line began, so inside the fence (or on this closing line).
        if (at <= lineEnd) return lineEnd;
      }
    }
    lineStart = lineEnd + 1;
  }
  return open === undefined ? at : text.length;
}
