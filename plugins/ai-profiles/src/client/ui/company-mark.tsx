import { For } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isFailure, type TokamakClient } from "@tokamak/sdk";
import { state } from "@tokamak/sdk/client";
import { agentOf, ai, type Company } from "../lib/api";
import { glyphs } from "../lib/icons";

/**
 * A company's logo: the mark its agent plugin ships (`claude`'s and `codex`'s
 * icon files), which this window learns from ai's agent list. Neither agent
 * plugin knows about this one. A window without a reachable Runner shows the neutral mark.
 */

interface Mark {
  readonly viewBox: string;
  readonly paths: readonly { d: string; fillRule?: "evenodd" | "nonzero" }[];
}

const NEUTRAL: Mark = { viewBox: "0 0 24 24", paths: [{ d: glyphs.company }] };
const MAX_SVG = 16_384;

/** The agents' SVG marks by agent id, as the caller's Runner listed them. */
const marks = state<Readonly<Record<string, string>>>({});
let asked: Promise<void> | undefined;
let windowId: string | undefined;

/** Asks ai for the agents' marks once per window. */
export function loadMarks(client: TokamakClient): void {
  if (asked) return;
  windowId ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  asked = client.action(ai.agents.list, { windowId }, { on: "caller" }).then(
    (list) => {
      if (isFailure(list) || !Array.isArray(list)) {
        asked = undefined;
        return;
      }
      marks.set(Object.fromEntries(list.flatMap((agent) => (agent.icon ? [[agent.id, agent.icon]] : []))));
    },
    () => {
      asked = undefined;
    },
  );
}

const parsed = new Map<string, Mark | null>();

/**
 * Only the outlines: the root's viewBox and each path's `d` and fill rule,
 * painted in currentColor, so a mark brings no markup, script or colour of its
 * own into the window (the same rule as ai's AgentMark).
 */
function parse(svg: string): Mark | null {
  if (svg.length > MAX_SVG) return null;
  if (parsed.has(svg)) return parsed.get(svg)!;
  let mark: Mark | null = null;
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  if (root.localName === "svg" && root.namespaceURI === "http://www.w3.org/2000/svg") {
    const rule = (value: string | null) => (value === "evenodd" || value === "nonzero" ? value : undefined);
    const paths = [...root.querySelectorAll("path")].flatMap((path): Mark["paths"][number][] => {
      const d = path.getAttribute("d");
      const fillRule = rule(path.getAttribute("fill-rule") ?? root.getAttribute("fill-rule"));
      return d ? [{ d, ...(fillRule && { fillRule }) }] : [];
    });
    const viewBox = root.getAttribute("viewBox") ?? "";
    if (paths.length) mark = { viewBox: /^[\d\s.,-]+$/.test(viewBox) ? viewBox : "0 0 24 24", paths };
  }
  parsed.set(svg, mark);
  return mark;
}

export function markOf(company: Company): Mark {
  const svg = marks()[agentOf[company]];
  return (svg ? parse(svg) : null) ?? NEUTRAL;
}

/** A single-path mark's outline, for a Chip's icon. */
export function markPath(company: Company): string | undefined {
  const mark = markOf(company);
  return mark.viewBox === "0 0 24 24" && mark.paths.length === 1 ? mark.paths[0]!.d : undefined;
}

const sizes = { 12: "size-3", 14: "size-mark", 16: "size-4", 18: "size-avatar", 24: "size-6" } as const;

export function CompanyMark(props: {
  company: Company;
  size: keyof typeof sizes;
  class?: string;
}): JSX.Element {
  return (
    <svg
      data-slot="icon"
      viewBox={markOf(props.company).viewBox}
      class={["block shrink-0", sizes[props.size], props.class]}
      aria-hidden="true"
      data-mark={markOf(props.company) === NEUTRAL ? "neutral" : "agent"}
    >
      <For each={markOf(props.company).paths}>
        {(path) => <path d={path.d} fill="currentColor" fill-rule={path.fillRule} />}
      </For>
    </svg>
  );
}
