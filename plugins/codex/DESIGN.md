# Codex

The Codex agent for `ai`. It draws no UI and publishes no parts. What a
person sees of it is data it gives `ai` through the `agent` contract, drawn
by ai's parts inside chat. Its `info` and `start` caller actions discover
and run the CLI on the sender's Runner.
No Paper page of its own: its data shows on `App 1:1 · AI plugin` (the
copy uses the test agent in its place).

## Screens

None.

## Parts it offers

None.

## What it adds to others

| Target                                    | What                                                                                             | File                                                                 | Paper artboard (test agent in its place)                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ai agent row, reply header, thread detail | Name "Codex" and its mark (LobeHub's OpenAI icon, single-colour paths)                           | `plugins/codex/src/server/agent.ts`, `src/server/icons/openai.svg`   | every `AI ·` artboard                                                         |
| ai Model and Level pickers                | The model catalog (default model first) and each model's efforts                                 | `src/server/info.ts`                                                 | the model ("work") on every `AI ·` agent row; levels and menus not drawn yet  |
| ai Speed picker                           | Standard and the catalog's service tiers (`priority` is Fast), only when the catalog lists tiers | `src/server/info.ts`                                                 | not drawn yet (the test agent has no speeds)                                  |
| ai Mode picker                            | Default and Plan                                                                                 | `src/server/info.ts`                                                 | "Default" on every `AI ·` agent row; menu not drawn yet                       |
| ai agent row line                         | "Codex isn't installed." / signed out / update needed                                            | `src/server/info.ts`, lines in `plugins/ai/src/client/lib/agents.ts` | not drawn yet                                                                 |
| ai reply                                  | Tool steps, tasks, the proposed plan, helper agents, usage; approvals on Ask first               | `src/server/reports.ts`, `src/server/approvals.ts`                   | `AI · reply running`, `reply finished`, `reply opened`, `permission question` |

## If you change X, check Y

- The icon file: ai keeps only the viewBox and path outlines and paints them
  in the text colour (`plugins/ai/src/client/ui/agent-mark.tsx`).
- Codex is the agent that offers Mode; a new mode adds a menu item, a
  removed one hides the picker when none are left.
- Plan mode's proposed plan is drawn by ai's plan card (`ui/reply-cards.tsx`).

## Primitives used

None.

## Open questions

- Codex's `item/tool/requestUserInput` request is not supported yet
  (plugin README), so it has no screen.
