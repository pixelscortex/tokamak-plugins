# Code

Saves the Git worktree before and after each agent turn on the client that
runs it, and shows what changed. It has no screen of its own: it adds to
chat's header and messages and fills the shell's panel. Everything is read
from the caller’s Git through caller actions. Without a Runner, the change
cards, branch chip and review controls stay hidden.
Paper page: `App 1:1 · Code plugin`: chat's open thread as the base, then the
screen as the app draws it with every plugin on. Nothing is drawn on top of
the artboards; the table under "What it adds to others" says which artboard
shows each part.

## Screens

| Screen                                                                                                                                                               | Source                                                                                      | Paper artboard              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------- |
| Base: chat's open thread without this plugin (a copy of `Chat · open thread`)                                                                                        | `plugins/chat`                                                                              | `Base · Chat · open thread` |
| The review panel open beside the thread ("Turn 2", files, plain diffs), with the change cards under the replies and the branch chip and layout control in the header | `plugins/code/src/client/ui/review-panel.tsx`, `ui/change-card.tsx`, `ui/thread-header.tsx` | `Code · review panel`       |

Not drawn yet: "Started tracking · 12 files", a binary-only change, the
panel's notes ("Reading the changes…", "No turn in this thread has changed
files yet.", the 3,000-line cut), the skipped-files notice under a reply.

## Parts it offers

The compiler generates a typed `find` function in `plugin:code/client` for its JSX elements,
including the review panel. See
`plugins/code/src/client/_generated/components.d.ts` for the generated search types.

## What it adds to others

All actions are in `plugins/code/src/client/api.tsx`.

| Target                                 | Action                                          | What is drawn                                                                 | File                                                               | Paper artboard                                                                         |
| -------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `chat.find("title", { in: "Header" })` | after                                           | Branch chip (mono, branch icon), read every 3 s while visible                 | `ui/thread-header.tsx` (`BranchChip`)                              | `Code · review panel`; also every `AI · reply` artboard                                |
| `chat.find("ThreadMenu")`              | before                                          | Layout control: "Thread only" / "Review panel" on a tray, pressed half lifted | `ui/thread-header.tsx` (`ReviewToggle`)                            | `Code · review panel` ("Review panel" pressed); `AI · reply` artboards ("Thread only") |
| `chat.find("Header")`                  | attach                                          | Mounts the review panel into the shell's `Region.Panel`                       | `ui/thread-header.tsx` (`ReviewPanelMount`), `ui/review-panel.tsx` | `Code · review panel`, `Shell · frame`                                                 |
| `chat.find("footer")`                  | append, last reply of a turn that changed files | Change card: file icon, "1 file" / "3 files", +7 −11, "open in review ›"      | `ui/change-card.tsx`                                               | `Code · review panel`, `AI · reply finished`                                           |
| `chat.find("footer")`                  | append, finished agent replies                  | Notices: skipped files over 50 MB, the hook warning                           | `api.tsx` (`SnapshotNotice`)                                       | not drawn yet                                                                          |
| `chat.find("Composer")`                | attach                                          | Nothing drawn: prunes snapshot refs of deleted threads once per connection    | `api.tsx` (`SnapshotCleanup`)                                      | none                                                                                   |

Code depends on chat and optionally on ai; it reads ai's `turns:list` to find
and number a reply's turn ("Turn 2").

## If you change X, check Y

- The change card (a `Row as="button" variant="card"` in a `density-dense`
  `surface-card` box, 32 tall, full column width; the tracking-only card is a
  plain `h-8 px-2` box): chat's
  `chat.find("footer")` gap (8) and message column (760); ai's cards above it
  are narrower (`max-w-read`).
- The branch chip (`ms-2` after the title) or the layout control: chat's
  header (`gap-2`, the title truncates, the folder chip follows the title).
  Chat's own folder chip uses the same `Chip mono` look; keep them alike.
- The review panel's header (`h-12`, `ps-4 pe-2`): the shell's page header
  is also `h-12 ps-4 pe-2`, so the two lines sit level.
- Diff colours (`added`, `removed`, `diff-added`, `diff-removed`) and
  `text-code`: tokens in `packages/ui/src/theme.css`; light theme values too.
- The panel's default width (600) and minimum (320) belong to the shell
  (`app/src/shell/frame.tsx`); below 1280 px wide an open panel hides the sidebar.

## Primitives used

`Button`, `Chip`, `FileName`, `Icon`, `Row` (`as="button" variant="card"` for the change card), `ScrollArea`; `Region.Panel` from the SDK.

## Open questions

- Notices and the change card both append to `chat.find("footer")` with no
  `order`; which one comes first is not set on purpose in the code.
- Without ai there are no turns to read, so the change card and panel stay
  empty; the README says ai is optional but does not say what code shows then.
