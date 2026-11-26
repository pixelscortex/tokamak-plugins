import { render } from "@solidjs/web";
import { afterEach, expect, test } from "vitest";
import type { Info } from "../src/contracts";
import { agents, modelLabel } from "../src/client/lib/agents";
import { AgentMark } from "../src/client/ui/agent-mark";
import { MAX_ICON_LENGTH } from "../src/shared/icon";

// An agent's mark comes from a plugin as SVG text. The window keeps only the
// outlines: whatever else the text carries never reaches the page.

const info: Info = {
  installed: true,
  signedIn: true,
  install: "",
  signIn: "",
  models: [],
  speeds: [],
  modes: [],
};
const D = "M2 2H22V22H2Z";
let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  agents.set([]);
});

function show(icon: string) {
  agents.set([{ id: "probe", name: "Probe", icon, info }]);
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <AgentMark agentId="probe" label="Probe" />, host);
  return host;
}

/** Every element and attribute under the mark, so a test sees exactly what was drawn. */
function drawn(host: HTMLElement) {
  return [...host.querySelectorAll("*")].map((element) => ({
    tag: element.localName,
    attributes: element.getAttributeNames().sort(),
  }));
}

test("a hostile icon draws only its path outlines", () => {
  const host = show(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="alert(1)" style="color:red">
      <script>alert(2)</script>
      <style>* { display: none }</style>
      <foreignObject width="24" height="24"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
      <path d="${D}" fill="red" onclick="alert(3)" style="stroke:red" fill-rule="evenodd"/>
      <image href="https://example.com/x.png"/>
    </svg>`,
  );
  expect(drawn(host)).toEqual([
    { tag: "svg", attributes: ["aria-label", "class", "data-slot", "role", "viewBox"] },
    { tag: "path", attributes: ["d", "fill", "fill-rule"] },
  ]);
  const path = host.querySelector("path")!;
  expect(path.getAttribute("d")).toBe(D);
  expect(path.getAttribute("fill")).toBe("currentColor");
  expect(host.innerHTML).not.toMatch(/script|onload|onclick|foreignObject|style=|<style|href/i);
});

test("an odd viewBox, a non-SVG document, and an icon over the size cap fall back safely", () => {
  const odd = show(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="url(x)"><path d="${D}"/></svg>`);
  expect(odd.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 24 24");
  dispose?.();

  // Not SVG: the neutral mark stands in (one path, not the given one).
  const html = show(`<html><body><path d="${D}"/></body></html>`);
  expect(html.querySelectorAll("path")).toHaveLength(1);
  expect(html.querySelector("path")!.getAttribute("d")).not.toBe(D);
  dispose?.();

  const huge = show(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${D}${" L2 2".repeat(MAX_ICON_LENGTH)}"/></svg>`,
  );
  expect(huge.querySelector("path")!.getAttribute("d")!.startsWith(D)).toBe(false);
});

test("a model reads without its agent's name, and an old stored default reads Default", () => {
  expect(modelLabel("Claude", "Claude Fable 5.2")).toBe("Fable 5.2");
  expect(modelLabel("Claude", "Opus 5.5 (default)")).toBe("Opus 5.5 (default)");
  expect(modelLabel("Claude", "Default (recommended)")).toBe("Default");
  expect(modelLabel("Codex", "gpt-6.1-sol")).toBe("gpt-6.1-sol");
  expect(modelLabel("Claude", "Claude")).toBe("Claude");
});
