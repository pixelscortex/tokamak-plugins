# Claude

This plugin provides the local agent for `ai`. Install Claude Code **2.1.330 or later** and sign in with `claude auth login`. Build this plugin beside `ai` and install both; select Claude in the agent row.

Claude runs in the thread's folder through the official program on the client's PATH. It inherits the Runner's HOME, PATH, `CLAUDE_CONFIG_DIR` and supported proxy and certificate settings. The client does not forward `ANTHROPIC_*` variables; use Claude's own settings for a gateway. The plugin never copies credentials into Tokamak data. Models and effort levels come from Claude. The plugin offers Standard and Fast only when Claude reports that fast mode is available with `--settings`, and passes the selected speed on launch. Account and provider restrictions still apply.

The plugin uses the flags from the [CLI reference](https://code.claude.com/docs/en/cli-reference) for streaming I/O, partial responses, permission mode and resume. The minimum version and replays guard the hidden flags and unpublished JSON control messages. The recordings in [the fake-agent harness](../../e2e/fake-agent/replays/) come from 2.1.330 and newer and omit unrelated fields, account data and local paths.

- The stream opens with `initialize`. Steer sends another user message, identified by UUID. During streaming text or thinking, it first interrupts the reply if no tool or permission question is active. The interrupted result keeps the turn open, and the echo tells us when the steer has joined. Any text already streamed stays in the reply, with the steer answer starting a new paragraph.
- Stop sends `interrupt` and waits for a terminal result. Claude returned `aborted_streaming` after one text delta and `aborted_tools` during a Bash command.
- Ask first uses CLI permission prompts. Approve allows the current input. Session approval lets `ai` remember the tool and its command, file path or fetch domain across turns. The plugin also passes an exact Bash rule to Claude when that rule is suggested. Decline denies the action; Cancel denies it and interrupts. Full access follows Claude's bypass mode and managed policy. Claude's free-text questions are outside Tokamak's four-answer permission contract.
- The CLI sends thinking summaries and task updates when available.
- Usage covers the current Tokamak turn. Claude's raw `input_tokens` excludes cache reads and writes; the plugin includes both in `inputTokens` and reports cache reads as `cachedInputTokens`. If a steer produces multiple CLI results, the plugin sums their token counts and uses the latest cumulative CLI cost.
- Reusing a session is a CLI resume. When Claude reports a missing session, the plugin starts a new one with the supplied thread history and the new prompt as separate text blocks.

The server acceptance test runs in the Linux CI check and uses only recorded sessions:

```sh
CARGO_BUILD_JOBS=2 cargo test --locked -p server --test claude_turns
```

To run the live smoke test locally, first build the Runner if necessary. This uses your configured Claude login and may consume usage. It cannot run in CI.

```sh
CARGO_BUILD_JOBS=2 cargo build --locked -p tokamak-runner -p tokamak-plugin-host
env -u CI proto run bun -- plugins/claude/tests/turns.mjs target/debug/tokamak-runner --live
```
