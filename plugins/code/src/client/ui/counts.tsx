import type { JSX } from "@solidjs/web";

/** "4 files", "1 file". */
export function filesLabel(count: number): string {
  return `${count.toLocaleString("en")} ${count === 1 ? "file" : "files"}`;
}

/** "+86". */
export function plus(count: number): string {
  return `+${count.toLocaleString("en")}`;
}

/** "−21": a minus sign rather than a hyphen, as on the Paper page. */
export function minus(count: number): string {
  return `−${count.toLocaleString("en")}`;
}

/**
 * "+86 −21" in the added and removed colours. A zero is a quiet "0", as in
 * Paper's file rows ("+58 0").
 */
export function Counts(props: { added: number; removed: number }): JSX.Element {
  return (
    <>
      <span class={["font-mono text-data", props.added ? "text-added" : "text-ink-3"]}>
        {props.added ? plus(props.added) : "0"}
      </span>
      <span class={["font-mono text-data", props.removed ? "text-removed" : "text-ink-3"]}>
        {props.removed ? minus(props.removed) : "0"}
      </span>
    </>
  );
}
