# AI

`ai` puts agents into `chat` threads. It extends chat through the elements chat
publishes and imports no agent plugin: agents (`claude`, `codex`, the test
`fake-agent`) reach it only through the `agent` contract.

## What a person sees

- The agent row under the composer box (Paper "Chat v7 · dark"): separate
  pickers for agent, model, level (`effort`), speed, mode and permission
  level (Full access or Ask first). A picker hides when the agent offers
  nothing for it, and each one asks every agent for its `info` again as it
  opens, so an install or sign-in shows without a restart. A missing or
  signed-out agent shows only its line ("Codex isn't installed.", "Claude is
  signed out. Sign in, then come back.") and Send stays off in that composer
  (chat's `holdSend`). Empty without an agent or in a plain browser (no local
  part), so chat stays plain chat.
- The choices belong to the thread (table `choices`, `choices:get`/`choices:set`,
  creator only; a turn saves what it used only when its sender started the
  thread). A thread keeps its agent when that plugin is removed: the row says
  it isn't installed and Send waits. The agent picker always opens, so even a
  single agent is asked again. The new thread's stay in the window until its first Send; it
  starts with this device's last agent, model, level, speed and mode, and always on
  Full access. Each turn records what it used.
- On Ask first, a question from the agent shows on the composer's tray above
  the prompt (Paper "System · rules", Composer anatomy, state "Needs you"):
  "🔒 Claude wants to run `git push origin feat/csv-export`" with Approve,
  Always allow this session, Decline and Cancel on keys 1 to 4 (registered
  with `useShortcuts`; they answer only the card of the composer that has
  focus, and a digit typed into a field that holds text stays text). Only the
  sender sees it, on the device that runs the turn. A question from before the
  app quit shows "This question expired when the app quit." at once.
- The empty thread's heading names the agent: "What should Claude work on?".
  Without an agent it stays "Start a conversation".
- After each Send in this window, the turn runs on this computer and the
  agent's text streams into a reply in the thread.
- While a turn runs, Enter steers it and shows the follow-up inside its reply.
  Cmd+Enter queues a message with the current agent settings. Queued messages
  stay dashed at the end of the thread until they start, in order. Stop or Esc requests an interrupt. After 10 seconds the
  button offers Force stop. Stopped and failed replies keep their text.

## The reply (Paper "Thread ideas", option C, without the audit lane)

- Header: the agent's mark, its name and the model (`✳ Claude  Opus 5.5`), in
  place of chat's author line; no persona, no time.
- Above the text: thinking, folded; the actions line, folded: "14 actions ·
  1m 12s" once the turn ended, the step in progress and its clock while it
  runs ("Running pnpm test auth · 0:04"); it opens in place to one
  row per step (its path or command, then its detail or its time). One folded
  row per helper agent, opening to its answer.
- Under the text: "Tasks" (the to-do list, Paper's plan widget), the plan as
  a card, then usage, small ("12.4k in · 1.1k out · $0.04").
- All drawn from one live `turns:replies({ threadId })` per thread, shared by
  every reply in the window (`lib/replies.ts`), through
  `layer(chat.find("header"))`, `before(chat.find("body"))` and
  `after(chat.find("body"))`, each `when` the message is an agent's reply.
  What a folded part opens to (`turns:steps`, `turns:thinking`,
  `turns:helper`) is read only while it is open.

## The agent contract

```ts
import { action, provide } from "@tokamak/sdk";
import * as ai from "plugin:ai/contracts";

const info = action({
  on: "caller",
  handler: async (ctx): Promise<ai.Info> => ({ installed, signedIn, install, signIn, models, speeds, modes }),
});
const start = action({
  on: "caller",
  handler: async (ctx, run: ai.Run) => {
    const program = ctx.proc(["codex", "app-server"], { cwd: run.folder });
    // … send run.prompt, then for each message: run.text(delta)
    return { sessionId };
  },
});
export default provide(ai.agent, { id: "codex", name: "Codex", info, start });
```

- The contract uses `{ on: "caller", dataMethods: true }`: `info` and
  `start` run in the sender's Runner, with `ctx.proc`.
- `run.prompt` is the message exactly as stored; `run.text(delta)` adds to the
  reply. The agent never writes rows; `ai` does.
- The other reports: `run.thinking(delta)`; `run.tool({ id, kind, title,
  detail?, state })` and `run.helper({ id, name, title, state, text? })`,
  reported again with the same id on each change (the latest wins; `ai` times
  them on this computer); `run.tasks([{ text, state }])`, `run.plan(markdown)`
  and `run.usage({ inputTokens, outputTokens, cachedInputTokens?, costUsd? })`,
  each replacing the last. See `src/contracts.ts`.
- `info.models[].efforts` is the Level picker, `info.speeds` the Speed picker
  and `info.modes` the Mode picker (a way of working such as Codex's plan
  mode, not a speed); the first of each is the default, and an empty list
  hides it. `run.effort`, `run.speed` and `run.mode` carry the picks.
- `run.sessionId` is given when the thread's last turn was this agent's on
  this device: carry it on if the program still has it. `run.history` is the
  full text of every earlier message (`{ role: "user" | "agent" | "note", name, text }`,
  text parts only, so no command output): give it to a fresh session, when
  there is no session id or the session is gone. A very long thread gives only
  its newest messages (what chat's `listMessages` returns), after a first
  `note` saying how many are left out; a message too large to show is left
  out too. The thread in the database is the truth, so switching agent in a
  thread works the same way.
- `await run.ask({ kind, action, subject })` resolves `"approve"`,
  `"approveSession"`, `"decline"` or `"cancel"`; the agent translates the
  answer for its program. On Full access it resolves `"approve"` at once.
  After `"approveSession"`, `ai` answers `"approve"` itself to the same `kind`
  for the rest of that agent session: the allows are tied to the session id
  the agent returns and start empty in any turn that does not carry that
  session on (`run.sessionId`: the thread's last turn was this agent's on this
  device).
  Questions asked at once wait in a queue. Stop first answers a waiting
  question `"cancel"` (clearing it on the row), then calls `onStop`; after
  Stop or an aborted call every ask resolves `"cancel"` at once.
- Register `run.onSteer((text) => …)` to pass a follow-up into the running
  agent session, and `run.onStop(() => …)` to send a graceful interrupt.
  Let `start` settle when the program ends. Force stop kills the process
  groups started through the scoped `ctx.proc` supplied to `start`.
- `ctx.proc(argv, { env })` REPLACES the environment, and the plugin process
  starts with a short list (HOME, USER, LANG, PATH, …). Leave `env` out to pass
  that list on, or add what the program needs to find its login and settings.

## Turns

Table `turns`: thread, the message that began it, chat's reply, sender (with
the device that runs the turn), agent, model, effort, speed, mode, access, state
(`queued`, `running`, `waiting` with its `question`, `done`, `stopped`,
`failed`), error,
usage, the agent's session id, times. Chat's reply token is kept on the row and
never sent to windows. A queued row has no reply until it starts.

- Local `run:turn({ threadId, messageId, folder, agentId, model?, effort?, speed?, mode?, access? })`
  runs one turn to its end. A model, effort, speed or mode the agent does not offer
  falls back to its first; access defaults to Full access. The window passes
  the thread's choices (`lib/turn.ts`). Fails with `NoAgent`, `NotInstalled`,
  `SignedOut`, `Busy` (one writer per thread) or `Answered` (the message already
  has a turn).
- Local `run:steer`, `run:stop` and `run:forceStop` control a turn in its sender's
  plugin process. Steer returns `NoSteerHandler` without storing the draft if the
  provider never registers a handler.
- `turns:begin`, `turns:write`, `turns:steer`, `turns:requestStop` and
  `turns:finish` record the turn. The caller action calls the server on the window's
  session, so each mutation checks the sender and device (`begin` also checks
  the original message's sender).
- `turns:enqueue` stages the message and settings; `turns:failQueued` marks a head
  that could not launch. `turns:ready` is the live list of eligible heads for the
  caller's device. `turns:next` reads one thread's eligible head and
  `turns:queuedForMessage` reads a specific snapshot before selecting the provider.
- `turns:list` and `turns:active` read a thread's turns; `turns:pending` includes
  its queue head when idle. `turns:replySteers` reads the follow-ups for a reply.
  `turns:forceStopDelay` gives the remaining wait using the server's clock.
- The window listens for Sends once (`lib/turn.ts`, registered by the entry),
  not per composer.
- `turns:write` carries what changed since the last write: text and thinking
  as appended deltas, the latest tasks, plan and usage, and the changed
  steps; the caller action keeps each write under 640 KB. Table `steps` holds
  one row per step or helper (`key` is the agent's id, `n` its place); the
  turn keeps the actions count and the step in progress. Limits
  (`src/server/limits.ts`): 256 KB of text, thinking and each helper's
  answer, 64 KB of plan, 100 tasks, one line per title; a cut text ends with
  "…cut". `turns:finish` carries no report, so size never refuses it; it
  closes steps still running at the sender's time.
- A malformed report throws back to the agent; a write the server refuses
  twice stops the agent (as Force stop does) and fails the turn,
  keeping its session id when the agent returned one.
- `turns:list({ threadId })`, `turns:replies({ threadId })` (latest turns
  first, up to 200 and 512 KB), `turns:steps`, `turns:thinking`,
  `turns:helper`, local `agents:list` (every agent with its `info`).
- Local `agents:list` returns every agent with its `info`.
- `turns:ask` puts the turn in `waiting` with its question and a token the
  asking caller action keeps (never on Full access); `turns:answer` clears the
  question and lets the turn run on. Both check the sender's device inside,
  and `answer` also wants the token, so another window, even on the same
  device, cannot let a turn run on while its agent still waits. The answer
  itself is not stored.
- Local `run:answer({ turnId, questionId, answer })` is how the card answers;
  local `run:pending({ turnId, questionId })` tells the card whether this local
  part still holds the question. Waiting questions live in the memory of the
  caller action running the turn, so they expire when the app quits: answering
  one then fails with `Expired`.
- `turns:questions()` lists the questions waiting for the caller on this
  device. Local `agents:list` returns every agent with its `info`.

### The `turnHooks` contract

Plugins use `provide(ai.turnHooks, { before, after })` with either or both
members. On the QuickJS Runner, each receives plain data in the provider's
process: `threadId`, `turnId`, and `folder`. Use
`action({ on: "caller", handler: (ctx, turn: ai.TurnInfo) => … })`. The
SDK supplies `turn.signal` in the provider on QuickJS; Bun passes the live
signal. Use `turnId` to find anything saved for the turn.

- A `before` failure or timeout ends the turn with a reason and skips the agent
  and all `after` hooks.
- After the agent ends, `after` hooks run together before the thread is freed.
  Errors or timeouts appear as a local notice and leave the outcome in place.
- Each before hook has 60 seconds; all after hooks share one 60-second
  deadline. On QuickJS, Stop cancels a pending before hook without a notice.
  On Bun, Stop lets the before hook finish under its original deadline. Stop
  never cancels an after hook. Stop and quit can skip remaining after work
  without changing the finished outcome. Force stop only kills the agent's
  programs.
- Reloading AI on QuickJS interrupts its running turns, closes pending
  questions, and stops their programs. The thread is available again as soon
  as the interruption is saved. Reloading Code or an agent doesn't interrupt
  a turn in AI. "Always allow this session" answers are held by AI's process,
  so reloading AI forgets them and later turns ask again.

## Tests

`CARGO_BUILD_JOBS=2 cargo test --locked -p server --test ai_turns --test ai_threads`
(the fake-agent harness in `e2e/fake-agent`), and the browser tests
`CARGO_BUILD_JOBS=2 proto run bun -- e2e/browser.ts ai.spec.ts ai-thread.spec.ts`.
