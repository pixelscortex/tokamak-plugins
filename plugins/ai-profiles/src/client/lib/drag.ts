import { createSignal, onCleanup } from "solid-js";

/**
 * Dragging subscription cards into profiles, and rows inside a profile, with
 * pointer events: neither `@tokamak/ui` nor ui-sdk has drag and drop (ui-sdk's
 * `gesture` is for swipes and presses), and the job is small enough not to need
 * a library. Mouse and pen only: a touch on a card scrolls the page, as before.
 *
 * Where a drop lands is read from the page, not from hit areas the caller
 * keeps: a profile box carries `data-profile="<id>"`, and each of its rows
 * `data-entry="<subscription id>"`. The drop position is the number of rows
 * whose middle is above the pointer, not counting the row being carried.
 */

/** What is being carried: a subscription, from a card or from a row of a profile. */
export interface Carry {
  readonly subscription: string;
  /** The profile whose row is carried; absent for a card. */
  readonly from?: string;
}

/** Where it would land: a profile and a position in its list (0 is first used). */
export interface Over {
  readonly profile: string;
  readonly index: number;
}

/** How far the pointer moves before a press becomes a drag, so a click stays a click. */
const SLOP = 4;

/** Presses on these start no drag: the switch, buttons and links keep their own job. */
const INTERACTIVE = "button, a, input, textarea, select, [role=switch], [role=menuitem]";

export function overAt(x: number, y: number, carry: Carry): Over | undefined {
  const box = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-profile]");
  const profile = box?.dataset.profile;
  if (!box || !profile) return undefined;
  let index = 0;
  for (const row of box.querySelectorAll<HTMLElement>("[data-entry]")) {
    if (profile === carry.from && row.dataset.entry === carry.subscription) continue;
    const rect = row.getBoundingClientRect();
    if (rect.top + rect.height / 2 < y) index++;
  }
  return { profile, index };
}

export function createDrag(onDrop: (carry: Carry, over: Over) => void) {
  const [carry, setCarry] = createSignal<Carry>();
  const [over, setOver] = createSignal<Over>();
  const [point, setPoint] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 });
  let stop: (() => void) | undefined;

  function end() {
    stop?.();
    stop = undefined;
    setCarry(undefined);
    setOver(undefined);
  }
  onCleanup(end);

  /**
   * Call from a card's or a row's pointerdown; the drag starts once the
   * pointer moves. It ends, adding nothing, on Escape, on pointercancel, when
   * the window loses focus or is hidden, and on a move with no button down (a
   * release the window never saw, such as one outside it).
   */
  function start(event: PointerEvent, what: Carry) {
    if (event.button !== 0 || event.pointerType === "touch") return;
    if ((event.target as Element | null)?.closest(INTERACTIVE)) return;
    end();
    const source = event.currentTarget as Element | null;
    const origin = { x: event.clientX, y: event.clientY };
    let moving = false;
    const move = (next: PointerEvent) => {
      if (next.buttons === 0) return end();
      if (!moving) {
        if (Math.hypot(next.clientX - origin.x, next.clientY - origin.y) < SLOP) return;
        moving = true;
        setCarry(what);
        // The release then reaches this window even when it happens outside
        // it. Targets come from the pointer's position (overAt), not from the
        // element under it, so capture changes no drop.
        try {
          source?.setPointerCapture?.(event.pointerId);
        } catch {
          // A pointer that is already gone cannot be captured; the checks above still end the drag.
        }
      }
      // A drag selects no text on its way.
      next.preventDefault();
      window.getSelection()?.removeAllRanges();
      setPoint({ x: next.clientX, y: next.clientY });
      setOver(overAt(next.clientX, next.clientY, what));
    };
    const up = (next: PointerEvent) => {
      const target = moving ? overAt(next.clientX, next.clientY, what) : undefined;
      end();
      if (target) onDrop(what, target);
    };
    const key = (next: KeyboardEvent) => {
      if (next.key !== "Escape" || !moving) return;
      next.preventDefault();
      end();
    };
    const hidden = () => document.visibilityState === "hidden" && end();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", end);
    document.addEventListener("visibilitychange", hidden);
    stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", hidden);
      if (source?.hasPointerCapture?.(event.pointerId)) source.releasePointerCapture(event.pointerId);
    };
  }

  return { carry, over, point, start, cancel: end };
}

export type Drag = ReturnType<typeof createDrag>;
