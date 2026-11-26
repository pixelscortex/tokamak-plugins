# Claude

The Claude agent for `ai`. It draws no UI and publishes no parts. What a
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

| Target                                    | What                                                                                           | File                                                                         | Paper artboard (test agent in its place)                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ai agent row, reply header, thread detail | Name "Claude" and its mark (LobeHub's Claude icon, single-colour paths)                        | `plugins/claude/src/server/agent.ts`, `src/server/icons/claude.svg`          | every `AI ·` artboard                                                         |
| ai Model picker                           | Claude's models by the names people know (no alias labels); "Default" when Claude lists none   | `src/server/agent.ts`                                                        | the model ("work") on every `AI ·` agent row; menu not drawn yet              |
| ai Level picker                           | Each model's effort levels, as Claude reports them                                             | `src/server/agent.ts`                                                        | not drawn yet (the test agent has no levels)                                  |
| ai Speed picker                           | Standard and Fast, only when Claude reports fast mode                                          | `src/server/agent.ts`                                                        | not drawn yet (the test agent has no speeds)                                  |
| ai agent row line                         | "Claude isn't installed." / "Claude is signed out. Sign in, then come back." / the update line | `src/server/agent.ts` (info), lines in `plugins/ai/src/client/lib/agents.ts` | not drawn yet                                                                 |
| ai reply                                  | Thinking summaries, tool steps, tasks, usage; permission questions on Ask first                | `src/server/events.ts`, `src/server/permissions.ts`                          | `AI · reply running`, `reply finished`, `reply opened`, `permission question` |

## If you change X, check Y

- The icon file: ai keeps only the viewBox and path outlines and paints them
  in the text colour (`plugins/ai/src/client/ui/agent-mark.tsx`). Colours,
  gradients or non-path shapes in the SVG are dropped.
- Model names: ai trims a leading "Claude " from a model's name
  (`modelLabel`), so "Claude Opus 5.5" shows as "Opus 5.5".
- Offering a picker list (speeds, efforts) makes that picker appear in the
  agent row; an empty list hides it. The row's width changes with it.

## Primitives used

None.

## Open questions

- Claude's free-text questions are not shown: they are outside the four
  answers ai's permission card offers (plugin README).
