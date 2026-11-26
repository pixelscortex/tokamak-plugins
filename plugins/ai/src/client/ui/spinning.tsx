import type { JSX } from "@solidjs/web";
import { StatusIcon } from "@tokamak/ui";

/** The running spinner in the ink of what it marks, so the live step or task reads as the live one. */
export function Spinning(props: { size?: 12 | 16 }): JSX.Element {
  return (
    <span class="flex text-ink">
      <StatusIcon status="running" size={props.size} />
    </span>
  );
}
