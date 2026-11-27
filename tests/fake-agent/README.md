# The fake agent

A test agent for end-to-end turns, so CI never starts a real (paid) agent.

- `program.mjs` is the agent program. `fake-agent --list` prints the scripts in
  `replays/`; `fake-agent --replay <name>` plays `replays/<name>.jsonl` in the
  current folder. Steps: `read` (any number of times), `out` (with
  `{"$": "prompt.text"}` filled from what was read), `sleep`, `write` (a file
  in the replay folder), `gate` (wait for a file in the folder, with a
  timeout), `signals` (ignore SIGTERM), `exit`, `ask` (a permission question;
  waits for the answer line on stdin) and `if` (runs nested steps when a read
  value matches, e.g. stop on `cancel`). It
  stops when stdin closes. See the comment at the top of the program.
- `agents/<command>/` is one fake agent plugin each, named after the command
  it starts; the harness puts the replay program on PATH under that name.
  `agents/fake-agent` provides ai's `agent` contract as "Fake agent": `info`
  runs `fake-agent --list` and offers each script as a model; `start` runs
  `fake-agent --replay <model>` in the thread's folder, writes the prompt to
  its stdin and turns each line it prints into a call on ai's `run`: one
  message type per run method (`text`, `thinking`, `tool`, `tasks`, `plan`,
  `helper`, `usage`; see `replays/work.jsonl`), `ask` (`run.ask`; the answer
  goes back on stdin), then `done` (the session id) or `error` (the turn
  fails). Any other type fails the turn. It keeps its sessions as files in
  `~/.fake-agent/sessions/` (unlink one to lose it) and is signed out while
  `~/.fake-agent/signed-out` exists. "Fake agent" offers modes (`default`,
  `plan`) but no levels or speeds; `agents/other-agent` ("Other agent") offers
  levels (`low`, `high`) and speeds (`standard`, `fast`) but no modes, for
  switching agents and for every picker of the agent row. Both are made by
  `agents/factory.ts` (`provide(ai.agent, fakeAgent({ id, name, efforts, speeds, modes }))`);
  each agent links it as `src/server/factory.ts` and the harness copies the
  real file in before building. The `context` replay says back what the agent
  was given: the session it carries on (or "Fresh session" and the thread's
  earlier messages) and the settings.
- `harness.mjs` builds chat, ai and the fake agent with the real build, starts
  the real `tokamak-server`, connects windows (with or without a local part)
  and gives `watch`, `gate`/`closeGate`, `folder`, `signInMember`, `ownerDevice`
  (a second device of the owner) and `quit` (close one window and its local
  part, as quitting the app does). Its helpers (`within`, `build`, `copySource`,
  `startServer`, `connect`, `watchQuery`) also serve the chat threads driver. `local.mjs` starts a local
  part the way the desktop client does, with its short environment and
  `fake-agent` on PATH; it works under Bun and Node (the browser suite).

## Add a replay

Drop `replays/<name>.jsonl` here. It is a new model of every fake agent:
pass `model: "<name>"` to `ai`'s `run:turn`, or pick it in the agent row. For
the real agents' own messages (`claude` stream-JSON, `codex app-server`),
record the program's output lines as `out` steps and its input as `read`
steps. A new fake agent is a new folder under `agents/` (copy `fake-agent`,
keeping its `factory.ts` link, and change its id and name in `plugin.ts` and
`agent.ts`); tests find agents by id, never by count.

Before committing a recording, replace personal data with neutral examples and
run `proto run bun -- tests/fake-agent/replay-privacy.mjs`. Both agent suites use
this scanner. Run without arguments (as CI's lint step does), it also checks
every tracked or new text file (tests, fixtures, docs) for the local login,
the home folder and the private words; lockfiles and three existing app names
are skipped. Set `TOKAMAK_PRIVATE_WORDS` in your local environment to a
comma-separated list of additional names or words to reject; never write
those words in the repository.

## Run

- Server: `proto run bun -- run test:suite ai-turns`
  (driver: `tests/server/ai-turns-driver.mjs`).
- Browser: `CARGO_BUILD_JOBS=2 proto run bun -- e2e/browser.ts ai.spec.ts`.
  A desktop page (`browser/desktop.ts`) answers the window's Tauri calls from
  the test process and runs each plugin's real local part.
