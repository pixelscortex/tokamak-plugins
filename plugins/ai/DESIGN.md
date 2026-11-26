# AI

Puts agents into chat threads. It has no screen of its own: everything it
draws goes into chat's parts. Agents (`claude`, `codex`) give it only data
(name, mark, models, reports) through the `agent` contract.
Paper page: `App 1:1 · AI plugin`: chat's open thread as the base, then each
screen as the app draws it with every plugin on (code's branch chip, layout
control and change card show too). Nothing is drawn on top of the artboards;
the table under "What it adds to others" says which artboard shows each part.

## Screens

All of these are chat screens with ai's parts in them. The client draws them
when the caller has a Runner. Caller actions discover agents, run turns and handle controls.
When a Send has a folder and a resolved agent but its turn start returns `noMachine`,
the status line on the right of the composer’s agent row says “Connect a machine to run this.”
Plain chat Send does not show this line.

| Screen                                                                                         | Source                                                              | Paper artboard              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------- |
| Base: chat's open thread without this plugin (a copy of `Chat · open thread`)                  | `plugins/chat`                                                      | `Base · Chat · open thread` |
| New thread: agent heading when an agent is available, agent row                                | `plugins/ai/src/client/api.tsx`, `ui/agent-row.tsx`                 | `AI · new thread`           |
| Agent picker open: one popover above the new thread's composer                                 | `ui/agent-picker.tsx`                                               | `AI · picker open`          |
| Reply while the turn runs: work line with the step and clock, Stop, thread status              | `ui/reply-work.tsx`, `ui/turn-controls.tsx`, `ui/thread-status.tsx` | `AI · reply running`        |
| Reply after the turn: reply header, "Worked · 5 actions", helper row, text, tasks, plan, usage | `ui/reply-header.tsx`, `ui/reply-work.tsx`, `ui/reply-cards.tsx`    | `AI · reply finished`       |
| Thinking and the actions line opened                                                           | `ui/reply-work.tsx`                                                 | `AI · reply opened`         |
| Reply with steers: each follow-up drawn where it arrived in the text, as the person's message  | `ui/turn-steers.tsx`, `lib/steers.ts`                               | `AI · reply steered`        |
| Permission question on the composer (Ask first)                                                | `ui/permission-card.tsx`                                            | `AI · permission question`  |

Not drawn yet: the thread list after several turns (its status icons show on the other artboards), the agent row's lines ("Codex isn't installed.", signed out,
"Only Sam can run the agent here"), the picker over an open thread or with a second agent, a
pending steer, queued messages, the expired question line, "Force stop".

### The agent picker

The agent row holds one picker, drawn by the owner in the Paper file "Tokamak — Directions"
(artboard "6 · Thread · picker open"; the extra column is supplied by [AI Profiles](../ai-profiles/DESIGN.md)).

- **Closed chip** (`PickerChip`): the agent's mark, then the model and its effort,
  "work" or "Opus 5.5 · High", then ⇅. It is the standard ghost `Menu.Trigger` (32 tall,
  fills while open). A missing or signed-out agent shows only its name; the row's line says why.
  Screen readers read "Agent: Claude · Opus 5.5 · High".
- **Popover**: opens 8 px above the composer tray, aligned to its start (the anchor is the
  agent row's parent). It is the standard `Menu.Content` card (padding 4, radius 12).
- **Columns** (`PickerColumns`, one element, side by side, 4 apart):
  - "Agent and model" (at least 344 wide): each agent's mark and name as a quiet title
    (28 tall), then its models as radio items (32 tall), indented past the mark. Picking
    another agent's model switches agent and takes this device's last picks for it.
    An agent that offers no model (signed out, not installed) is one item with its name.
  - "Effort" (152 wide): the picked model's levels; left out when it has none.
- **Bar** under the columns (40 tall, tray tone, radius 8): Speed and Mode (with the quiet
  word "Mode") when the agent offers them, the access level (Full access, Ask first), and on
  the right "Runs on" with this computer's name. Each is a row of radio items. Left out while
  the agent cannot answer.
- Every option is a menu radio item, so the popover stays open while several change; each
  pick is stored at once (`choices:set`, or the new thread's window state) as before.
- A long model list scrolls inside the columns; the bar stays in view.

The caller action `agents:list` takes an optional `threadId` for an open
thread, or `draft: true` for the new-thread composer. The picker refreshes its
scoped options when it opens or an addition calls `refreshCatalog`. Calls
without either scope still feed discovery, reply marks, and the thread list.
A scoped exclusion leaves the current agent selected, labels it "Not
available", and holds Send. A plugin that is gone still says it isn't installed.

An out-of-date model, level, speed or mode falls back to the first offered one
(`shared/offered.ts`). With launch settings the CLI validates the choices;
AI does not use the ordinary personal catalog for the launch probe.

A launch hook can supply environment variables and CLI arguments. It can also
supply one OpenAI-compatible Responses provider as `provider: { baseUrl, keyEnv,
key }`. Codex builds the provider arguments and keeps the key out of command
environments. If two plugins set the same variable or both set a provider, the
error names both plugins. If a hook tries to replace a flag or config key
Tokamak owns, the reply names the plugin and the setting. These checks run
before the agent CLI starts.

Launched turns use the project's settings and a private CLI home on the
Runner. A thread resumes its previous agent session only when the same
plugins contributed launch settings with the same stable identities; changing a
per-turn key does not change the home. The launch request supplies an agent id,
a fresh launch id, and the requested model when one was chosen. Calling
`point(ctx, "ended", { launchId })` in a finalizer gives additions the same
launch id on completion, setup failure, or stop without exposing credentials.
Deleting the thread from the Runner removes its local homes. The same setup
messages cover missing or outdated CLIs, and turn errors hide launch values.
An older desktop or Runner that cannot run turn hooks gets an update message
in the thread. These states use the existing error surfaces and are not drawn on
the Paper page.

## Parts it offers

The compiler generates a typed `find` function in `plugin:ai/client` for its JSX elements,
including the picker and the agent row. See
`plugins/ai/src/client/_generated/components.d.ts` for the generated search types.
Agent plugins supply data through `plugin:ai/contracts`.

The picker publishes `ai.find("chipExtras")` for closed-chip
content and `ai.find("extraColumns")` for extra radio columns. The
composer exposes `ai.find("statusExtras")` for extra notices; the working thread
detail exposes `ai.find("detailExtras")` beside its model. AI Profiles
fills these parts when installed.

## What it adds to others

All actions are in `plugins/ai/src/client/api.ts`.

| Target (chat part)        | Action                               | What is drawn                                                                                                                            | File                                      | Paper artboard                                                                |
| ------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| `chat.find("box")`        | after                                | Agent row: the agent picker's chip (mark, model · effort, ⇅); a line on the right ("esc to stop"). Its popover opens above the tray      | `ui/agent-row.tsx`, `ui/agent-picker.tsx` | every `AI ·` artboard; open in `AI · picker open`                             |
| `chat.find("top")`        | prepend, while a question waits      | Permission card: lock, "Fake agent wants to run", the command in mono, Approve / Always allow this session / Decline / Cancel (keys 1–4) | `ui/permission-card.tsx`                  | `AI · permission question`                                                    |
| `chat.find("SendButton")` | layer, while this window's turn runs | Stop (then Force stop after 10 s)                                                                                                        | `ui/turn-controls.tsx`                    | `AI · reply running`, `AI · permission question`                              |
| `chat.find("heading")`    | layer                                | "What should Fake agent work on?" (the agent's name); otherwise chat draws its own heading                                               | `api.tsx` (keeps chat’s heading)          | `AI · new thread`                                                             |
| `chat.find("header")`     | layer, agent replies                 | Agent mark and the model ("work" for the test agent), no time                                                                            | `ui/reply-header.tsx`                     | `AI · reply running`, `reply finished`, `reply opened`, `permission question` |
| `chat.find("body")`       | before, agent replies                | Thinking (quiet, folded), the actions line (folded, 32 px on the hover tone, at least 360 wide), one row per helper agent                | `ui/reply-work.tsx`                       | `AI · reply running`, `reply finished`; opened in `AI · reply opened`         |
| `chat.find("body")`       | after, agent replies                 | Tasks card, plan card, usage line (left out when the agent counted 0 in and 0 out)                                                       | `ui/reply-cards.tsx`                      | `AI · reply running` (tasks), `reply finished`, `reply opened`                |
| `chat.find("body")`       | layer, agent replies with steers     | The text cut where each steer arrived; between the parts "↳ Steer" (quiet label), then the person's author line and text                 | `ui/turn-steers.tsx`                      | `AI · reply steered`                                                          |
| `chat.find("status")`     | prepend                              | Status icon: running, needs you (amber lock), done, failed                                                                               | `ui/thread-status.tsx`                    | `AI · reply running`, `reply finished`, `reply opened`, `permission question` |
| `chat.find("detail")`     | append, while running or waiting     | Agent mark, model in mono, folder                                                                                                        | `ui/thread-status.tsx`                    | `AI · reply running`, `AI · permission question`                              |
| `chat.find("detail")`     | after, while helpers run             | Half rows, one per helper agent                                                                                                          | `ui/thread-status.tsx`                    | `AI · reply running`                                                          |

Where a steer goes: when it is recorded, the server keeps the length of the
reply's stored text (`turns.steerOffsets`, parallel to `steers`). The reply
splits its text there, trims the blank line around the split, and never
splits inside a code fence (a steer sent inside one moves after the fence's
closing line). A steer still on its way to the agent shows at the end of the
text so far. Turns stored before offsets draw their steers after the text,
in the same look. Replies without steers keep chat's own body.

It also turns chat's Send off with `holdSend` while the thread's agent is
missing or signed out, and listens to `onSent` / `onDraftSubmit`.

## If you change X, check Y

- The agent row's height (`h-8`) or its missing start padding: chat's
  composer tray (gap 4, 4 px edge) must still frame it; the chip's edge sits
  on the box edge above it.
- `PickerChip` (the ghost `Menu.Trigger`): Button's `md` size owns its height,
  padding and text; changing Button's ghost look changes the chip.
- The popover's anchor is the agent row's parent, chat's composer tray: if chat
  moves `chat.find("box")`'s siblings out of the tray, the popover moves with them.
- Picker extras, catalog scope, Send warnings and thread detail: check the
  [AI Profiles](../ai-profiles/DESIGN.md) additions. Reply and thread marks still use
  unscoped discovery; Chat's `detail` part holds the working and idle details.
- The picker's items are `Menu.RadioItem`s and its card is `Menu.Content`: their
  look (32 rows, the check, padding 4, radius 12) is `@tokamak/ui`'s menu.
- The column widths (`--container-models` 344, `--container-effort` 152 in
  `src/client/styles.css`) set the popover's width; the bar can make it wider.
- The permission card padding (`py-1 ps-3 pe-1`): chat's `chat.find("top")`
  gap and the box below it.
- The reply header (`h-5`, mark 14 px, model in `text-data`): chat's
  `chat.find("header")` height; the user's header uses the same 20 px line.
- Work lines and cards (`max-w-read` 560, `min-w-fold` 360): chat's message
  column (760) and `code`'s change card, which spans the full column.
- The steered body (`ui/turn-steers.tsx`) repeats chat's body text style
  (`text-read`, `whitespace-pre-wrap`, `max-w-read`) and chat's author line
  (avatar 18, name in `text-label text-ink-3`, `h-5`); change those in chat
  and change them here. Its pieces sit 16 apart (`gap-4`), and a steer
  has `py-2` more on each side (24 between it and the agent's text).
- `ReplyCards` relies on chat's `Message` gap (8) plus its own `pt-2` for the
  16 px between text and card; changing either changes the other.
- Status icon size (16) and the detail line: chat's `ThreadRow` lead lane
  (`w-4`) and its double-row height.
- `AgentMark` (paths only, painted in currentColor): the marks `claude` and
  `codex` ship must stay single-colour paths.

## Primitives used

`Avatar` (steers), `Button`, `Collapsible` (Thinking uses its `quiet` trigger), `Icon`, `icons`, `Kbd`, `Menu` (the picker: `Trigger`, `Content`, `RadioGroup`, `RadioItem`), `rowVariants`,
`StatusIcon`, `Tooltip`; its own `AgentMark` and `Spinning`.

## Open questions

- The owner's drawing shows Speed as segments on a darker track and Mode, access and
  "Runs on" as small dropdowns. `@tokamak/ui` has no segmented control or submenu for a
  menu, and its menu items own their look, so the bar uses plain radio items side by side
  (the check marks the pick) and "Runs on" names the caller’s computer. Turn actions use caller placement.
- The drawing marks the picked row with a fill and medium text; the menu's radio item marks
  it with its check only.
- The popover is wider than drawn (about 686 against 512) because the bar's radio items
  are wider than the drawn dropdowns, and a long model list can reach the top of the window.
- The per-thread scope argument on `agents:list` is pending owner confirmation.
  Picker choices on launched turns are still validated by the CLI.
- The closed chip shows the model and effort only; speed, mode and the access level are
  read in the popover.
- The agent rows on every `AI ·` artboard and the whole `AI · picker open` artboard were
  taken again from `feature/tkm-259` (TKM-259); the rest of those artboards is still the
  earlier copy. The picker's "Runs on" shows "This Mac" in Paper, not the test computer's name.
- The Paper copy uses the test agent ("Fake agent", models named after
  replays such as "work"). Real agents show their own names and models.
