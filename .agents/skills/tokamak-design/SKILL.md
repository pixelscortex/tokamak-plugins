---
name: tokamak-design
description: Tokamak's design rules and the design sync rule that keeps the app, Paper and the design notes the same. Use when changing what a Tokamak screen looks like, in the Tokamak shell or in a plugin.
---

Paper shows how screens look. The design notes record how they relate: which
plugin draws what, which parts it offers and what it adds to another plugin's
screen. Paper cannot show that a change in chat's composer moves ai's agent row.
The notes do.

## Where the notes are

- **A plugin's note** is the `DESIGN.md` in its own folder in the separate
  `tokamak-plugins` repository (`plugins/<id>/DESIGN.md`).
- **The shell's note** (the app frame, `app/src/shell`) is `design/shell.md` in
  Tokamak.

A note has these sections:

1. **Screens**: what it draws, the source file, the Paper artboard.
2. **Parts it offers**: compiler-named paths and the parts other plugins use.
3. **What it adds to others**: its additions to other plugins' screens.
4. **If you change X, check Y**: what else moves when this changes.
5. **Primitives used** from `@tokamak/ui`.

Then **Open questions** for anything the code does not settle. A plugin with
no other plugin depending on it can keep a short note.

## The sync rule

Every change to what a screen looks like does three things in the same piece
of work:

1. Update the note: the plugin's `DESIGN.md`, or `design/shell.md` for the shell.
2. Update that screen's `App 1:1` page in Paper so it looks the same as the app.
3. Read the "If you change X, check Y" notes of every plugin listed as
   affected, and check those screens too.

Review checks all three.

The owner's own Paper pages (Chat, Plugins · coding, notes, System · rules,
the moodboard and the rest) belong to the owner: never edit those nodes. The
`App 1:1` pages are kept by whoever changes the UI. An `App 1:1` artboard is a
plain copy of one screen of the running app at 1728 × 1117 in the dark theme:
nothing drawn on top, no outlines, no labels. Tokamak's `design/README.md`
describes how those copies are made from the app. For plugin screens, check
which builds loaded in Settings → Plugins. It shows both loaded and failed
plugins, as do `GET /plugins` and `tokamak-server plugin list`.

## The design rules

The full rules, with every token and measured contrast, are the wiki's
"Design rules" page (`wiki/content/docs/design/index.mdx` in Tokamak). They
come from the owner's Paper page "System v1 · rules, composer, chat". The
tokens, the primitives and a lint config that enforces them ship in
`@tokamak/ui`; the app's `/kit` page shows every token and primitive in both
themes. The short version:

- **A system, not a look.** Build from the tokens, the rules and the few
  primitives in `@tokamak/ui`. Use a primitive where one exists; add only
  layout classes to it. Build the rest from tokens, with `tv` and `cn`.
- **Turn on the lint config** (`@tokamak/ui/lint`). It reports raw colours,
  arbitrary values, classes outside the theme, inline styles, restyled
  primitives, corners that are not concentric and a density looser than its
  container, and names the fix.
- **Tones, not borders.** Neutrals are pure grey. A surface is told apart by
  its tone (`window`, `stage`, `tray`, `card`, `band`). Edges are translucent
  ink (`edge`, `edge-strong`), used only where tone and space cannot separate.
- **Three text tones** (`ink`, `ink-2`, `ink-3`) and the type roles
  `text-read`, `text-row`, `text-label`, `text-data`. No display size; a
  heading is 16 at weight 600. Mono only for what a person could copy.
- **One spacing scale** (4 to 64) and **one radius scale** (4, 8, 12, 16).
  Nested corners are concentric: `nest-*` on the container, `rounded-inner`
  on the child.
- **Brand purple marks four things**: the brand button, links, the focus ring
  and nothing else. Semantic colour only on status and diff content. Colour is
  never the only cue.
- **Buttons are the only thing with depth.** At most one brand or primary
  button per region. Every click target is at least 32 × 32.
- **Three densities** (roomy 48, normal 40, dense 32); density only gets
  tighter inward.
- **Status is an icon,** coloured only when it needs the person (amber needs
  you, red failed). Rows carry no status words.
- **Threads are for talking.** Tool work folds into one collapsed row. Heavy
  output goes in the plugin's own panel, with a one-row summary in the thread.
- **The shell is the frame.** Plugins fill its regions (`Region.Sidebar`,
  `Region.Header`, `Region.Panel`) and never draw it.

New screens follow the owner's Chat and System · rules pages in Paper. Do not
invent visual rules that are not written there or on the design rules page.
Before calling a screen done, run the lint config and check hierarchy,
grouping, line length, contrast, target sizes, and the focus and empty states.
