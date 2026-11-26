# Chat

Threads, messages, the composer and the folder a thread works in. Chat knows
nothing about agents or code; `ai` and `code` add to its parts.
Paper page: `App 1:1 · Chat plugin`.

Folder checking and resolution, and deletion with machine cleanup, use caller
actions. Without a Runner, Chat stores the chosen path as typed and deletes
threads through the server mutation.

## Screens

| Screen                                                             | Source                                                                    | Paper artboard               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------- |
| New thread: icon, "Start a conversation", folder choices, composer | `plugins/chat/src/client/pages/chat.tsx` (`NewThread`), `ui/empty.tsx`    | `Chat · new thread`          |
| Open thread: header, messages, composer                            | `pages/chat.tsx` (`OpenThread`), `ui/message.tsx`, `ui/thread-header.tsx` | `Chat · open thread`         |
| Thread menu open (Rename, Delete thread)                           | `ui/thread-header.tsx` (`ThreadMenu`)                                     | `Chat · thread menu`         |
| Thread list in the sidebar ("New thread ⌘N", then threads)         | `ui/thread-list.tsx`                                                      | shown on every chat artboard |

Not drawn yet: the composer with text in it (Send filled), the "Choose a folder" dialog, the delete dialog, a failed or
stopped reply line ("Stopped", "Failed · …"), a queued message (dashed box).

## Parts it offers

The compiler generates a typed `find` function in `plugin:chat/client`.
See `plugins/chat/src/client/_generated/components.d.ts` for all available names.
These are the searches used by the starter add-ons:

| Search                                 | File                   | What goes there                                                                                  |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `chat.find("top")`                     | `ui/composer.tsx`      | Permission card inside the top lane.                                                             |
| `chat.find("box")`                     | `ui/composer.tsx`      | Agent row after the prompt box.                                                                  |
| `chat.find("SendButton")`              | `ui/composer.tsx`      | Stop in place of Send.                                                                           |
| `chat.find("heading")`                 | `ui/empty.tsx`         | Agent heading when an agent is available; chat supplies the default.                             |
| `chat.find("header")`                  | `ui/message.tsx`       | Agent reply header in place of the author line.                                                  |
| `chat.find("body")`                    | `ui/message.tsx`       | Work lines before the text, cards after it, and a steered body in place of the text when needed. |
| `chat.find("footer")`                  | `ui/message.tsx`       | Change card and notices inside the footer.                                                       |
| `chat.find("status")`                  | `ui/thread-list.tsx`   | Status icon in the lane before the title.                                                        |
| `chat.find("detail")`                  | `ui/thread-list.tsx`   | Agent, model and optional profile code in the second line; helper rows after it.                 |
| `chat.find("title", { in: "Header" })` | `ui/thread-header.tsx` | Branch chip after the title.                                                                     |
| `chat.find("ThreadMenu")`              | `ui/thread-header.tsx` | Review toggle before the menu.                                                                   |

`code` attaches cleanup to the `Composer` render function and the review
panel mount to the `Header` render function. Their lifetimes follow those
instances even if a placement changes an element inside them.

Other hooks (not drawn): `holdSend` turns Send off in a composer, `onSent`
announces each Send, `onDraftSubmit` handles a draft before Send.

Chat fills the shell's `Region.Sidebar` (thread list) and `Region.Header`
(thread header) from `pages/chat.tsx`.

## What it adds to others

| Target                 | What                                                                      | File                        | Paper artboard                                                               |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| Shell `sidebar` region | The thread list                                                           | `pages/chat.tsx`            | every `Chat ·` artboard                                                      |
| Shell `header` region  | The open thread's header; the page title "New thread" or the thread title | `pages/chat.tsx`            | `Chat · open thread`, `Chat · thread menu`; the title on `Chat · new thread` |
| Shell rail             | Its view mark                                                             | `lib/icons.ts` (`chatIcon`) | every `Chat ·` and `Shell ·` artboard                                        |

## If you change X, check Y

- The composer tray (`nest-lg/1 surface-tray`, gap 4) or the box padding
  (`py-3 ps-2 pe-3`, plus the input's own `ps-2`): `ai` agent row (no start padding, so its first button
  sits on the box edge), `ai` permission card (`ps-3 pe-1` on the tray), `ai`
  Stop button (same size as Send). `ai`'s agent picker opens its popover 8 px above
  the tray, aligned to its start: it finds the tray as the agent row's parent, so the
  row must stay a direct child of the tray.
- The composer tray's picker and Send hold: check [AI](../ai/DESIGN.md) and
  [AI Profiles](../ai-profiles/DESIGN.md) for picked, unpicked, unavailable and no-profile
  states. The first Send stores the thread before a plugin can start a turn.
- The message column width (`max-w-thread` 760, `px-8`) or the composer
  column: `code` change card (full width of the column), `ai` work lines and
  cards (`max-w-read` 560), the new thread's composer (same column on purpose).
- `Message` spacing (`gap-2`, `pb-12`) or the header height (`h-5`): `ai`
  reply header (also `h-5`), `ai` cards (`pt-2`, relies on the 8 px gap),
  `code` change card and notices in `footer`.
- The body's text style or the author line (avatar, name): `ai` layers over the
  body of a steered reply and draws each steer as the person's message with
  the same classes (`plugins/ai/src/client/ui/turn-steers.tsx`).
- `ThreadRow` box (`min-h-8`, `px-row`, `py-1`) or the lead lane (`w-4`):
  `ai` status icon, detail line and helper rows (half rows start at the title edge). Check the
  [AI Profiles](../ai-profiles/DESIGN.md) code beside agent and model, including idle rows.
- The thread table or `threads:start`: AI Profiles uses a typed thread reference
  and a mutation hook to inherit the last profile on the first Send.
- The header layout (`gap-2`, chip after the title, `flex-1` before the menu):
  `code` branch chip (`ms-2`) and layout control. If the `Header` render
  function changes, check the review panel mount in the shell's panel region.
- The empty state heading style (`text-read font-semibold`): `ai`
  changes the text through `Original` and inherits the heading markup and style.
- Removing or renaming any part: every action on it in `ai` and `code`
  breaks at build time; update `design/ai.md` and `design/code.md`.

## Primitives used

`Button`, `Avatar`, `Chip`, `Dialog`, `Icon`, `Kbd`, `Menu`, `Row` (its
button form, `as="button"`, for "New thread" and the folder choices), `RowList`,
`rowVariants`, `ScrollArea`, `StatusIcon`, `Textarea` (dialog only; the
composer uses the bare ui-sdk textarea), the `surface-*`, `nest-*`,
`density-*` and `focus-ring` utilities.

## Open questions

- The README's component table lists `chat.find("tools")`, but no plugin fills it yet.
- `chat.find("avatar")` comes from the `<Avatar>` tag's name (a tag publishes its
  own name), not from a `part`; replacing it also needs care with the header's
  `h-5` line. No plugin acts on it yet.
