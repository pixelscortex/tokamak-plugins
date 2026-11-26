import { createSignal, onCleanup } from "solid-js";

/** A thread's age on the right of its row: now, 5m, 3h, 2d, 1w. */
export function age(time: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  return `${Math.floor(minutes / 10080)}w`;
}

/** A message's time in its header, 24-hour: 09:12. */
export function timeOfDay(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The current time, refreshed each minute so ages move on their own. */
export function useNow(): () => number {
  const [now, setNow] = createSignal(Date.now(), { ownedWrite: true });
  const timer = setInterval(() => setNow(Date.now()), 60_000);
  onCleanup(() => clearInterval(timer));
  return now;
}
