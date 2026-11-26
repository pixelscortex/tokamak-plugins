import { For } from "solid-js";
import type { JSX } from "@solidjs/web";
import { agents } from "../lib/agents";
import { agentIcon } from "../lib/icons";
import { MAX_ICON_LENGTH } from "../../shared/icon";

interface Mark {
  readonly viewBox: string;
  readonly paths: readonly { d: string; fillRule?: Rule; clipRule?: Rule }[];
}

type Rule = "evenodd" | "nonzero";
const rule = (value: string | null): Rule | undefined =>
  value === "evenodd" || value === "nonzero" ? value : undefined;

/** The stand-in mark: an asterisk, for an agent that gave none. */
const NEUTRAL: Mark = { viewBox: "0 0 24 24", paths: [{ d: agentIcon }] };

/** Marks parsed so far, by their SVG text; a window sees a handful, so the oldest go past this many. */
const CACHED = 32;
const parsed = new Map<string, Mark | null>();

/**
 * The outlines of an agent plugin's SVG mark. Only the root's viewBox and the
 * paths' `d` and fill rules are kept, so a mark cannot bring markup, scripts
 * or colours of its own into the window; the paths are painted in currentColor.
 */
function parse(svg: string): Mark | null {
  if (svg.length > MAX_ICON_LENGTH) return null;
  let mark = parsed.get(svg);
  if (mark !== undefined) return mark;
  mark = null;
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  if (root.localName === "svg" && root.namespaceURI === "http://www.w3.org/2000/svg") {
    const paths = [...root.querySelectorAll("path")].flatMap((path) => {
      const d = path.getAttribute("d");
      if (!d) return [];
      const fillRule = rule(path.getAttribute("fill-rule") ?? root.getAttribute("fill-rule"));
      const clipRule = rule(path.getAttribute("clip-rule"));
      return [{ d, fillRule, clipRule }];
    });
    const viewBox = root.getAttribute("viewBox") ?? "";
    if (paths.length) mark = { viewBox: /^[\d\s.,-]+$/.test(viewBox) ? viewBox : "0 0 24 24", paths };
  }
  if (parsed.size >= CACHED) parsed.delete(parsed.keys().next().value!);
  parsed.set(svg, mark);
  return mark;
}

/**
 * An agent's mark (Paper draws Claude's and OpenAI's): the icon its plugin
 * registered, or the model's own when it has one, as this computer's local
 * part listed it. A neutral mark stands in for an agent that gave none or is
 * not listed here (a plain browser).
 */
export function AgentMark(props: {
  agentId: string | undefined;
  modelId?: string | undefined;
  size?: 12 | 14 | 16;
  label?: string;
  class?: string;
}): JSX.Element {
  const mark = () => {
    const agent = agents().find((entry) => entry.id === props.agentId);
    const svg = agent?.info.models.find((model) => model.id === props.modelId)?.icon ?? agent?.icon;
    return (svg ? parse(svg) : null) ?? NEUTRAL;
  };
  const size = () => props.size ?? 14;
  return (
    <svg
      data-slot="icon"
      viewBox={mark().viewBox}
      class={[
        "block shrink-0",
        size() === 12 ? "size-3" : size() === 16 ? "size-4" : "size-mark",
        props.class,
      ]}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <For each={mark().paths}>
        {(path) => (
          <path d={path.d} fill="currentColor" fill-rule={path.fillRule} clip-rule={path.clipRule} />
        )}
      </For>
    </svg>
  );
}
