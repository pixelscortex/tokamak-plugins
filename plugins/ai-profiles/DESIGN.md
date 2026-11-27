# AI Profiles

The Profiles screen: a page of its own in the rail. It draws the
Subscriptions section with the add-subscription dialog (Claude and ChatGPT,
TKM-261 and TKM-262), the Profiles section with its "New profile" dialog and
dragging (TKM-264), and the subscription details and the remove confirmation
(TKM-265). The profile details come with TKM-269. In Chat, TKM-266 adds the Profile column and the
profile code beside the agent and model.
Subscriptions are `agent-proxy`'s data (`design/agent-proxy.md`); company logos
are the marks of the `claude` and `codex` agent plugins, read from ai's agent
list on this computer. On the desktop app the page also listens for the
browser's return after a sign-in (TKM-295, `design/shell.md`).
Paper page: `App 1:1 · AI profiles plugin`. Drawn from the owner's
"Flow · Profiles (proposal)" artboards `1 · Profiles · screen`, `2a` to `2d`,
`3 · Subscription · details`, `4a · Profiles · hover a profile` and
`4b · Profiles · dragging a card`.

## Screens

In flow order, as `e2e/browser/plugin-screens.spec.ts` ("profiles screens") takes
them and as the Paper page lays them out (three rows: adding Claude, adding
ChatGPT and building profiles, the details and removing).

| Screen                                                                                    | Source                                                                      | Paper artboard                             |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| Dialog, step 1: company (Anthropic and OpenAI; "More later" listed, not offered)          | `ui/add-dialog.tsx` (`CompanyStep`)                                         | `Profiles · add · company`                 |
| Dialog, step 2: method for Anthropic ("Claude subscription"; "API key", marked "Later")   | `ui/add-dialog.tsx` (`MethodStep`), words in `lib/companies.ts`             | `Profiles · add · method`                  |
| Dialog, step 3: sign-in in the desktop app, the address field shown under its own line    | `ui/add-dialog.tsx` (`SignInStep`)                                          | `Profiles · add · sign-in`                 |
| Dialog, step 3 with an address pasted                                                     | `ui/add-dialog.tsx` (`SignInStep`)                                          | `Profiles · add · sign-in, address pasted` |
| Dialog, step 4: connected, plan, email, models, label                                     | `ui/add-dialog.tsx` (`ConnectedStep`)                                       | `Profiles · add · connected`               |
| One subscription card, with its model line and action row                                 | `pages/profiles.tsx`, `ui/subscription-card.tsx`, `ui/card-actions.tsx`     | `Profiles · subscriptions`                 |
| The same with a sign-in left waiting: the "Awaiting sign-in" card                         | `ui/subscription-card.tsx` (`AwaitingCard`)                                 | `Profiles · awaiting sign-in`              |
| Dialog, step 2: method for OpenAI ("ChatGPT subscription"; "API key", marked "Later")     | `ui/add-dialog.tsx` (`MethodStep`), words in `lib/companies.ts`             | `Profiles · add · method, OpenAI`          |
| A Claude and a ChatGPT card side by side                                                  | `ui/subscription-card.tsx`                                                  | `Profiles · Claude and ChatGPT`            |
| "New profile": name and code (typed "pers", shown "PERS")                                 | `ui/profile-dialog.tsx`                                                     | `Profiles · new profile`                   |
| Two profiles holding both subscriptions; the codes on the cards                           | `ui/profiles-section.tsx`, `ui/profile-box.tsx`, `ui/card-profiles.tsx`     | `Profiles · profiles`                      |
| Pointing at a profile: the cards it does not hold dim                                     | `ui/profile-box.tsx`, `lib/builder.ts` (`dimmed`)                           | `Profiles · hover a profile`               |
| Dragging a card: the box that holds it says "added", the other rings with a slot          | `lib/drag.ts`, `ui/profile-box.tsx`, the ghost in `ui/profiles-section.tsx` | `Profiles · dragging a card`               |
| Subscription details, one account: accounts, label, models, "Used by" naming two profiles | `pages/subscription.tsx`                                                    | `Profiles · subscription`                  |
| The same with a second account added through "Add account"                                | `pages/subscription.tsx`, the dialog's sign-in step                         | `Profiles · subscription · two accounts`   |
| The same with one of the two signed out (its own "Sign in"; the card still "OK")          | `pages/subscription.tsx` (`AccountRow`)                                     | `Profiles · subscription · one signed out` |
| Remove confirmation, naming the profiles that lose it                                     | `ui/remove-dialog.tsx`                                                      | `Profiles · remove`                        |

Not drawn: no subscriptions ("No subscriptions yet…"), no profiles ("No
profiles yet. Make one, then drag subscriptions into it."), an empty box ("Drag
a subscription here"), a code refused in the dialog, a "Signed out" card with
"Sign in", a refused or wrong paste (the line under the field, the sign-in
still waiting), an ended sign-in ("Start again"), an expired one (card and
dialog), "Awaiting sign-in again" for a repair, "Awaiting another account", the
"Copied" state of Copy link, "That sign-in was cancelled in another window.", a
plain browser (neutral company marks, "Open sign-in page" as a link), the
sign-in step's desktop and browser wording, the card
actions' tooltips, an unknown plan ("plan unknown" beside Check again), a
failed "Check again" (the line under the card's buttons), a row's menu (Move
up, Move down, Remove from PERS) and the card's "Add to profile" menu. The
window tests cover each of them.

### Measured and kept

On the owner's artboards: the column is 1220 wide and centred
(`max-w-profiles`, a token in this plugin's `styles.css`), 24 from the header,
12 between rows; four cards across, 12 apart; a card is radius 12, 16 in, on
the tray tone; logo 24 with 12 to the title; emails and the plan line in data
mono; "Signed out" in warn with a ghost `sm` "Sign in". The pending card is an
edge ring with an 18 px logo on a 32 px card-tone tile. The dialog is 440 wide,
24 in, 20 between its parts; four 24 × 4 step pills 4 apart; the title is
`text-read` semibold; the address field is `Input` `md` `mono` with an `sm`
ghost "Continue" beside it, the label field `Input` `lg`.

The card (one layout for everything): title, label and switch; the emails and,
under them, the workspace line; the status; the model line ("1 model · not
used yet") followed by the codes of the profiles that use it, each a 12 px
stack icon and the code in data mono ink-3, 4 apart, 8 between codes; and last
the action row:
ghost `sm` icon-only buttons (24 × 24, 14 px icons in ink-3), 2 px apart
(`gap-hair`; under the 32 px target rule, an exception pending the owner):
Models, Check again, Details, Add to profile, Remove, each with a `Tooltip` and
a name that says which subscription, its title and label ("Remove Claude Team,
Acme"; `nameOf` in `lib/format.ts`), in a toolbar named the same way ("Claude
Team, Acme actions"). "Add to profile" is
always shown; it opens the menu that lists the profiles, those that hold the
card marked "added". A card is a drag source: a press anywhere but a button,
link, field or switch starts a drag (`lib/drag.ts`, `INTERACTIVE`).

The Profiles section, measured on `1 · Profiles · screen`, `4a` and `4b`: the
header is 40 under the cards (`pt-10`), "Profiles", the count in data mono and
the hint "Drag subscriptions into a profile. Top one is used first." in
`text-label` ink-3, 8 after the count; "New profile" is a ghost `md` with the
add icon. Boxes share the column, 12 apart; a box is radius 12, 4 in, on the
tray tone, 4 between its parts. Its head is 40 tall: the stack icon at 14 in
ink-3, the code in `text-code` (13 mono) medium ink, the name in `text-row`
ink-2, and "Fill first" in `text-label` ink-3 at the end. A row is 40 tall,
radius 8, on the card tone, 8 in at the start: the grip at 12 in ink-3, the
number in data mono ink-3, the logo at 16, the name in `text-row` medium ink,
and the label in `text-label` ink-3 at the end ("2 accounts" in its place for a
subscription with several). Pointing at a box ("4a") turns it to the card tone
with an edge ring, and every card it does not hold, the awaiting one too, goes
to 40%. Dragging ("4b"): the carried card waits at 40%, a box that holds it
goes to 40% and says "✓ added" instead of "Fill first", the box under the
pointer turns to the card tone with the strong edge ring, and a dashed
strong-edge slot, 40 tall and radius 8, shows the number the card would get;
the ghost follows the pointer, tilted 2°, on the band tone with the raised
shadow. A row dragged onto another profile is copied there and stays in its
own; inside its own profile it moves. Removing it is the row menu's job.

The subscription details, measured on `3 · Subscription · details`: the column
is 912 wide (`max-w-subscription`) and centred, 24 from the header, 32 between
the title row and the columns; the title row is 32 tall: logo, title
(`text-read` semibold) and label (`text-row` ink-3), 12 apart. The accounts
column is 536 (`w-accounts`), 48 from the right column. A section header is
24 + 8 + a 1 px edge line (33), its name `text-label` ink-3 with the count in
data mono. An account row is 12 + 36 + 12 + its edge line (61): `Avatar` 24,
the email `text-row` medium ink over its status in `text-label` ink-3 ("Signed
out" in warn), and a ghost `sm` "Sign out" or "Sign in". The right column's
sections are 32 apart and 12 inside; model chips are `Chip` `sm` with the
company mark, 8 apart; a "Used by" row is 24 tall, the profile mark 12 and code
in data mono ink-3, the name `text-row` medium, the thread count in data mono
ink-3 (the number of threads that have picked that profile).

### Decided here, not drawn (or not on the scale)

- A card's gap is 12 (drawn 14) and its height follows the tallest card in its
  row (drawn 236); icon-to-text gaps are 8 (drawn 6); the card's icon row is
  not pulled 6 px left as drawn (no negative margins), and has no 2 px top
  offset (`pt-0.5`, off the 4 px scale).
- An unknown plan is never a word: the title is the product alone ("Claude",
  "ChatGPT") on the card, in the details and in the connected step, and a
  quiet "plan unknown" sits beside Check again, which reads it.
- The line under the emails is the workspace alone (the account's organisation
  or ChatGPT workspace, as the company writes it) and is left out for a
  personal account; the plan is in the title only. The drawing writes the
  workspace in lower case ("acme · team"), with the plan after it.
- The model line and the codes, measured on `1 · Profiles · screen`: drawn as
  one line, the text then the codes, 8 apart, never wrapping. As built the
  codes follow the text on the same line while they fit, and move to a line of
  their own (4 under it) when they do not, so neither is cut; a card shows up
  to three codes, and with more, two and "+N" in data mono ink-3.
- The pending card's 6 px dot is the 12 px waiting spinner, as on the dialog's
  waiting line, and it has ghost `sm` "Continue" (reopens the dialog at its
  sign-in step) and "Cancel".
- The method rows are a double `Row` in a 4 px padded box, 56 tall (drawn 60);
  the company rows are `Row`s, so the logo is 8 from the name (drawn 12) and
  the rows touch (drawn 2 apart); the method rows have no band at rest, and
  their hover is the `Row`'s own tray tone, with a 16 px icon (drawn 18; `Icon`
  has 12, 14 and 16); model chips are `Chip` `sm` with the company mark (drawn
  on the tray tone, 6 apart); the connected logo is 24 (drawn 28). Button `sm`
  keeps radius 8 (drawn 6) and ghost `sm` text is ink-2 (drawn ink), as the
  package draws them.
- The Profiles section: the pointed box's ring is the edge (drawn at 20% ink,
  between `edge` 12% and `edge-strong` 40%); the head is 12 in (drawn 10) and
  the number column 12 wide (drawn 10); boxes sit three to a row and wrap; the
  drop slot's number is 32 in (drawn 28); the ghost is radius 12 (drawn 10) and
  as tall as its text with 4 in (drawn 44 fixed, 300 wide); a disabled
  subscription's row says "Off" where the label goes; each row ends in a ghost
  `sm` "more" button shown while the row is pointed at or focused, so a row
  ends 4 in (drawn 12); the carried card keeps its tray fill at 40% (drawn
  without fill, with a 20% ring). The "New profile" dialog is the
  add-subscription dialog's frame with two `Input` `md` fields (`mono` for the
  code) and the help "Up to 4 letters or digits. Threads show it in the
  picker."
- The details replace the Subscriptions and Profiles sections on the same page
  (window state `openSubscription`), with "Profiles / Claude Team" in the page
  header, where "Profiles" is a `bare` Button that goes back. The label is
  edited in the details, in a "Label" section above "Models" (`Input` `md`,
  saved on Enter or when the field is left). "Add account" and an account's
  "Sign in" open the add-subscription dialog at its sign-in step and close it
  when the account is in (no "Connected" step). Models and Details on the card
  both open the details; the Models tooltip lists the model names. An
  account's status line is "OK" or "Signed out · why" (drawn "OK · in use" and
  "Cooling down · resets 14:00", which need the proxy, TKM-263). The details
  logo is 24 (drawn 28).
- The remove confirmation: a `Dialog` titled "Remove Claude Team, Acme?", what
  is deleted, the profiles that lose it (or "No profile uses it."), "Cancel"
  and a destructive "Remove". Removing takes the subscription out of every
  profile in the same transaction.
- The sign-in step is one step for both companies (the same words; only the
  title and the field's example address differ, from `lib/companies.ts`).
  An account's own "Sign in" signs in that one account; signing in as another
  is refused and the dialog keeps waiting. Its words, in the layout drawn (the
  help line over "Open sign-in page" and "Copy link", then the field):
  - the desktop app listening: "Sign in in your browser. Tokamak finishes by
    itself when you are done.", and over the field "Signing in on another
    device, or it did not finish? The browser ends on a page that may not
    load. Copy its whole address and paste it here.";
  - a plain browser, or the listener busy or not available: "Sign in in your
    browser. It ends on a page that may not load. Copy its whole address and
    paste it here."
- A sign-in the page's return watch ended is said as it ended in whichever
  dialog waits on it (the details' "Add account" too): "Connected", the
  account in, or the failure's own words. "That sign-in was cancelled in
  another window." is only for one that left the list with neither.

### Profile in a thread

- New and open thread composers: a Profile column after the agent, model and effort.
  Each radio item has a grey mark and the profile code. The closed picker shows
  the code in a small chip. An enabled Claude subscription offers Claude and
  its models; an enabled ChatGPT subscription offers Codex and its models.
  A mixed profile offers both in the Agent and model column. See
  `Profiles · Codex picker` on the `App 1:1 · AI profiles plugin` page.
- With profiles and no pick, the chip says "Profile" in the warning tone, the
  composer says "Pick a profile to send.", and Send is held. If the thread's
  agent isn't offered, the picker labels it "Not available" and keeps the choice
  until an offered agent or another profile is picked. With no profiles these
  additions are absent.
- The thread list shows the saved profile code next to the agent and model,
  including when the thread is idle. The subscription details count threads
  that still reference each profile.

For the App 1:1 pages: new thread and open thread with picker open, picker closed
(selected and unpicked), open picker with an unavailable current agent, and
Chat's thread list with idle and working profile threads. The subscription
details also show the live thread count.

## Parts it offers

None for its thread UI. It fills named parts published by AI and Chat.

## What it adds to others

| Target (shell)     | What                                                                   | File                                 | Paper artboard                                                 |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| Rail, tabs, search | The Profiles page (`/p/ai-profiles`), marked with a person (user-line) | `pages/profiles.tsx`, `lib/icons.ts` | every `Profiles ·` artboard (its tab); the rail is not on them |

| Target                                                   | What                                  | Source                  |
| -------------------------------------------------------- | ------------------------------------- | ----------------------- |
| AI `ai.find("extraColumns")`                             | Profile radio column                  | `ui/thread-profile.tsx` |
| AI `ai.find("chipExtras")`                               | Code or warning chip                  | `ui/thread-profile.tsx` |
| AI `ai.find("statusExtras")`                             | Missing pick line and Send hold       | `ui/thread-profile.tsx` |
| AI `ai.find("detailExtras")`, Chat `chat.find("detail")` | Profile code in working and idle rows | `ui/thread-profile.tsx` |

It uses the shell's sign-in return commands (`sign_in_return_listen`,
`sign_in_return_cancel`, `sign_in_open_browser`, `design/shell.md`) through
`lib/desktop.ts`.

## If you change X, check Y

- Card or column sizes: four 296 px cards and three 12 px gaps make the 1220
  column (`max-w-profiles` in `src/client/styles.css`); change both together.
- The card's lines read `agent-proxy`'s `SubscriptionView` (plan, accounts,
  models, status, reason); a new status there needs a line here. The card
  shows the subscription's status, the details each account's.
- The card's action row: five 24 px buttons and the "plan unknown" hint fit a
  296 px card; another button needs that width checked. The buttons are named
  from `nameOf`, title and label ("Remove Claude Team, Acme"), and "Add to
  profile" from the builder
  ("Add Claude Pro, Personal to a profile"); the tests and the browser screens
  find them by those names.
- The details hide the Subscriptions section (`hidden`) and the Profiles
  section (not rendered) while open; a section added to the page must hide
  with them.
- Dimming reads `data-dimmed` on the cards (`SubscriptionCard`, `AwaitingCard`);
  a new kind of card in the grid needs it too, or it stays bright while a
  profile is pointed at. A drop is found from the page: boxes carry
  `data-profile`, rows `data-entry`; renaming those breaks dragging, not the
  tests of the menus.
- Profiles hold `agent-proxy` subscription ids, in one spelling
  (`subscriptionKey`). One `agent-proxy` does not list right now is hidden
  everywhere but stays stored, in place, and shows again when listed; the
  positions the window sends count shown rows only. Only
  `internal.profiles.forgetSubscription` deletes entries: `manage:remove`
  calls it through `profile-uses.ts` in the same transaction, and it throws
  rather than return a failure. Every other change to a profile's list goes
  through `save()` in `src/server/profiles.ts`.
- "Used by" counts the saved picks in `threadProfiles`; the remove dialog
  uses the same list of profiles.
  Chat's thread reference cascades on delete. Deleting a profile removes its picks,
  the saved last pick if it matched, and its proxy set in the same transaction.
- Chat's `threads:start` hook copies the caller's saved last choice into a
  new thread's row before the first Send is announced. `lastProfiles` stores
  one last choice per person, shared by drafts in all their windows. Explicit
  picks update it; other existing threads don't follow it.
- The named picker parts and `agents:list` scope are in [AI](../ai/DESIGN.md); changes
  must keep scoped options separate from the global marks and preserve an unavailable
  current agent. The warning and row layout also depend on [Chat](../chat/DESIGN.md).
- Set creation and subscription order or enable changes update the profile's
  [proxy set](../agent-proxy/DESIGN.md). A launch reads the thread pick from the call note,
  checks the requested model against the selected agent's profile catalog,
  then gets a company-bound key. Claude uses the existing launch environment;
  Codex uses a custom HTTP Responses provider and the isolated launch home. AI
  calls `point(ctx, "ended", { launchId })` to revoke the key even if starting the
  CLI failed. If the profile is deleted mid-turn, the running turn keeps its set
  snapshot. A later turn must pick a profile again if the person still has profiles.
- Uninstall removes the picker and launch hooks. Agent-proxy's set rows remain;
  abandoned keys stop working within 15 minutes without requests.
- A person has at most 32 profiles (`MAX_PROFILES`); the code rules are
  `checkCode`, for making a profile and for renaming one later (TKM-269).
- `CompanyMark` keeps only path outlines, like ai's `AgentMark`: the marks
  `claude` and `codex` ship must stay single-colour paths. A model chip shows
  the mark only when it is one path in a 24 × 24 box (Claude's is).
- The dialog's text column is `Dialog.Content`'s 440 (`max-w-dialog`); the
  step pills and the close button share its header line.
- The dialog is one flow for every company: only the words in
  `lib/companies.ts` differ (name, method, plans, where an API key comes from,
  the sign-in title, the return address). Each company's return address is
  written there once; `returnPort` and `returnPath` derive from it, and the
  desktop listener (`lib/sign-in-return.ts`) uses them. A new company adds an
  entry there, in `productOf` and `agentOf` (`lib/api.ts`), its sign-in module
  in agent-proxy (`design/agent-proxy.md`), and its port in the shell's
  listener (`allowed_port` in `app/src-tauri/src/sign_in_return.rs`).
- The return watch: the Profiles page listens, per company, for the newest
  waiting sign-in of the member (a new subscription, a repair, another account,
  one account's sign-in) and finishes it; each company has one port, so an
  older sign-in of the same company still waiting is finished by pasting. The
  dialog that waits for it (the page's or the details') sees it end through its
  own `lib/sign-in-watch.ts`, and reads how the page ended it
  (`returns.ended`). A sign-in started from the details is handed to the page
  (`returns.started`) so it is listened for before the list shows it.
- The listener stays up while that sign-in waits: it restarts only for a
  different sign-in (a memo in front of the effect: an effect source computed
  again re-runs the effect even for the same id, and the list answers again on
  every change), a port in use or a failed listen is tried again every 5 s, a
  cancel it did not ask for after 1 s, and only the return finished, a cancel,
  expiry or leaving the page stop it. The shell's listener keeps its port
  across stray connections and closes those it gives up on with a reset, so
  they leave nothing in TIME_WAIT on the port (`design/shell.md`).

## Primitives used

The thread picker uses `Menu.RadioGroup`, `Menu.RadioItem`, `Icon` and `Chip sm`.

`Avatar`, `Button` (`sm` ghost "Sign in", "Sign out", "Add account",
"Continue", "Cancel"; `md` ghost "Add subscription", "Copy link", "Back", "New
profile"; `bare` "Profiles" in the header; brand "Open sign-in page" (a link in
a browser, a button in the desktop app), "Done", "Start again", "Create";
destructive "Remove"), `Chip` (`sm`), `Dialog`
(also "New profile" and the remove confirmation), `Icon` (12, 14, 16), `icons`,
`Input` (`md`, `md` `mono`, `lg`), `Menu` (`Root`, `Trigger` as a ghost `sm`
icon button, `Content`, `Group`, `GroupLabel`, `Item`, `Separator`), `Row`
(single and double), `Switch` (solid-js's `Switch` is imported as `Choose`),
`Tooltip` (`sm` ghost icon triggers; "Add to profile" renders the menu's
trigger through the tooltip's); its own `CompanyMark`, profile box, row and
drop slot (`ui/profile-box.tsx`), and drag ghost.

How the Paper copies were made: `e2e/browser/plugin-screens.spec.ts` ("profiles
screens") takes each screen in the desktop app's window (the test desktop's
listener waits until cancelled and no return comes, so the sign-in step shows
the desktop wording and the test pastes);
`e2e/paper-html.ts` turns the page with
`PAPER_DROP="dialog-,FixtureView,PanelView,ThrowingView,WindowStateView,OtherDraftView"`
(the dialog layers and the fixture plugins' rail marks) and the dialog and its
backdrop with `--page`, since the converter clips the dialog to the stage while
the browser draws it in the top layer. Every artboard was rewritten whole from
the merged branch `feature/tkm-256-wave3` (TKM-261, 262, 264, 265, 295). The
converter keeps no rotation, so the drag ghost is not tilted on the copy. The
Switch's transparent 2 px border is left out (Paper measures from inside it).

## Open questions

- Per-thread scope on `agents:list` (with a separate draft scope) is pending owner
  confirmation. Further per-account model and effort matching is deferred.
- Update both the desktop app and its Runner before installing AI Profiles.
  Older callers cannot run the launch and ended hooks, even for people who
  have no profiles. The thread asks the person to update Tokamak on that computer.
- A profile turn needs an attached or connected Runner. The standalone desktop
  window fallback can read the picker catalog but cannot call the plugin-only
  key functions. It asks to connect a machine instead of using the personal login.

- **The details are not a page of their own.** They are window state on the
  Profiles page (`openSubscription`) until plugins get route parameters: the
  shell's Back does not leave them, and a reload opens on the cards. A `view`
  route with a parameter would let them be `/p/ai-profiles/subscription/<id>`.
- **The card's second button is drawn "Refresh usage"** and built as "Check
  again": it reads the plan, the accounts and the models again. Usage numbers
  are out of scope (TKM-256).
- **"Add to profile" is not drawn.** It sits in the action row before Remove,
  always shown. Where should it go in the drawing, and should removing a row
  from a profile be drawn (an × on the row) rather than only in its menu?
- **The codes wrap under the model line** when they do not fit beside it (see
  "Decided here"). Should the drawing show that, or the codes always on their
  own line?
- A second account on another plan is refused (`OtherPlan`). If the owner
  wants mixed plans under one card, the card needs a plan per account.
- **The sign-in step differs from the drawing**, for both companies. The
  drawing puts the paste field under "Signed in on another device?" and
  expects Claude's page to show `code#state`. As built the field shows at once,
  with its own line; in the desktop app the step says Tokamak finishes by
  itself and keeps the field for another device or a return that did not
  come. A pasted `code#state` or bare code is
  still accepted for Claude; ChatGPT has no code page.
- **Profiles: a row dragged onto another profile is copied** (it stays in its
  own). Should it move instead, or ask?
- **Profiles: fields and dialog.** No "New profile" dialog is drawn; it uses
  `Input` `md` (40) for both fields, since there is no 32 px dense `Input`.
- **Profiles: the pointed box's ring** is drawn at 20% ink, which no token has;
  it uses `edge` (12%). The carried card would need a 20% edge token too.
- **Profiles: touch.** A touch on a card scrolls the page; only a mouse or pen
  drags. Touch users use the menus.
- **Profiles: rename and delete** are not on this screen (TKM-269).
- The company rows' 2 px gap, the method row's 18 px icon and its band-on-hover
  are not available without restyling `Row` or `Icon`; rows show their text in
  ink-2 at rest where the drawing has ink.
- In the browser run the dialog sits at the window's top-left corner, as the
  shell's sign-in dialog does (`design/shell.md`); the Paper copies draw it
  there. Check where the desktop app puts it.
- The rail has a Profiles mark whenever ai-profiles is installed; the
  `App 1:1 · Shell` copy still shows the rail without it.
