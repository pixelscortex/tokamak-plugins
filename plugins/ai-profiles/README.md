# AI Profiles

The Profiles screen, in two sections. Subscriptions: a person adds a Claude or
ChatGPT subscription (company, method, sign-in, connected; the same steps for
both, with each company's words and return address in `lib/companies.ts`),
sees it as a card, and from the card opens its details (accounts, "Add
account", an account's "Sign out" and "Sign in", label, models, the profiles
that use it), checks it again or removes it. Profiles: a person makes a
profile (a name and a code of up to four characters, unique for them) and
drags subscription cards into it, in the order they are used, first one first;
"Add to profile" on a card's action row does the same from the keyboard. The
composer’s Profile column narrows the picker to the enabled subscriptions
in that profile: Claude for Claude subscriptions and Codex for ChatGPT
subscriptions, with each agent’s own models. A mixed profile offers both.
The thread keeps its agent when switching profiles; if it isn't offered,
the picker says "Not available" and holds Send until the pick changes.

Each turn gets a company-bound key from agent-proxy and runs inside a private
CLI home. Profile turns need an attached or connected Runner. Update both
the desktop app and Runner before installing AI Profiles so launch and cleanup
hooks can run; older callers show an update message.

It depends on `ai` and `agent-proxy`. Subscriptions belong to `agent-proxy`;
this plugin stores only profiles (`src/server/schema.ts`), each one person's,
holding subscription ids. A subscription `agent-proxy` does not list right now
is hidden from every profile but kept, and shows again when listed. Removing a
subscription (`manage:remove`) takes it out of every profile in the same
transaction, through `src/server/profile-uses.ts`, which also answers "Used
by" and the remove dialog. Its server functions (`src/server/subscriptions.ts`,
`src/server/manage.ts`) pass the window's calls on to `agent-proxy`'s
plugin-only exports, which answer for the calling member only and never with a
login.

Company logos are the marks of the `claude` and `codex` agent plugins, read
from ai's agent list on this computer (`ui/company-mark.tsx`). A window without a reachable Runner shows a neutral mark.

In the desktop app the page listens for the browser's return after a sign-in
(`lib/sign-in-return.ts`, through the shell's commands in `lib/desktop.ts`) and
finishes it without a paste. Each company has one port, so it listens, per
company, for the newest waiting sign-in of the member only; an older sign-in of
the same company that still waits is finished by pasting. The listener stays up
while that sign-in waits: a port in use or a failed listen is tried again every
5 s, and only the return, a cancel, expiry or leaving the page stop it. Without
the desktop app the person pastes the address the browser ended on.

The screen asks the server to renew logins that run out soon when it opens
and every minute while it stays open (server code has no network timer).

Tests: `moon run ai-profiles:test`. Window tests with a stand-in server: the
dialog, the cards and the awaiting card (`profiles.test.tsx`), the OpenAI path
(`chatgpt.test.tsx`), the details, card actions and removal
(`manage.test.tsx`), the Profiles section with dragging and its menus
(`profiles-section.test.tsx`), and the desktop return listener
(`desktop-sign-in.test.tsx`, `desktop-returns.test.tsx`). On a real server
when the server and plugin host are built: profiles and removal
(`profiles-server.test.ts`). The sign-in itself runs on a real server against
the fake companies in `plugins/agent-proxy/tests/` (`sign-in.test.ts`,
`chatgpt-sign-in.test.ts`, `manage.test.ts`, `manage-companies.test.ts`).

Screens and their Paper copies: `design/ai-profiles.md`.
