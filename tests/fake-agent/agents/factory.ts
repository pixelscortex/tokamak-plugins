// One fake agent, filling ai's agent contract the way `claude` and `codex` do:
// it starts its command (the replay program, put on PATH under the agent's
// folder name by the harness) and turns the program's lines into `run`
// reports. Each folder here is one fake agent plugin whose `agent.ts` exports
// `provide(ai.agent, fakeAgent({ ... }))`; each links to this file as
// `src/server/factory.ts`, and the harness copies it in before building.
// It reaches files only through `ctx.proc` (a helper module may not import
// `node:` modules: the build places it in the server part too).
import { action, type CallerActionContext } from "@tokamak/sdk";
import * as ai from "plugin:ai/contracts";

export interface FakeAgent {
  /** The agent's id; also the command it starts and its plugin folder's name. */
  readonly id: string;
  /** Its name as people see it. */
  readonly name: string;
  /** What it offers for the Level, Speed and Mode pickers (empty: that picker hides). */
  readonly efforts?: readonly string[];
  readonly speeds?: readonly string[];
  readonly modes?: readonly string[];
}

/**
 * What the program writes, one JSON object per line: one type per report
 * method of ai's `Run` (tool and helper fields inline), a question, then how
 * the turn ended.
 */
type Message =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | ({ type: "tool" } & ai.Tool)
  | { type: "tasks"; tasks: ai.Task[] }
  | { type: "plan"; text: string }
  | ({ type: "helper" } & ai.Helper)
  | { type: "usage"; usage: ai.Usage }
  | { type: "ask"; question: ai.Question }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string };

/**
 * The agent's implementation of the contract. Its own folder in the person's home,
 * like `~/.claude`, holds one file per session it can carry on, and a
 * `signed-out` file while it is signed out. Each recorded script is offered
 * as a model, so a test picks a script by picking a model.
 */
export function fakeAgent({ id, name, efforts = [], speeds = [], modes = [] }: FakeAgent) {
  const info = action({
    on: "caller",
    handler: async (ctx): Promise<ai.Info> => {
      const names = await lines(ctx, [id, "--list"]);
      return {
        installed: names !== undefined,
        signedIn: names !== undefined && (await sh(ctx, 'test ! -e "$HOME/.$1/signed-out"', id)),
        install: `Put tests/fake-agent/program.mjs on PATH as \`${id}\``,
        signIn: `unlink ~/.${id}/signed-out`,
        models: (names ?? []).map((model) => ({ id: model, name: model, efforts })),
        speeds,
        modes,
      };
    },
  });

  /**
   * Plays the script named by the model in the thread's folder. It carries on
   * `run.sessionId` when this computer still has that session, and otherwise
   * starts a fresh one given the thread's earlier messages. The program gets
   * the worker's own environment (no `env` option: that would replace it).
   */
  const start = action({
    on: "caller",
    handler: async (ctx, run: ai.Run) => {
      const resumed =
        run.sessionId !== undefined && (await sh(ctx, 'test -e "$HOME/.$1/sessions/$2"', id, run.sessionId));
      if (!resumed && run.sessionId) run.sessionChanged(undefined);
      const session = resumed ? run.sessionId! : `${id}-${crypto.randomUUID()}`;
      const program = ctx.proc([id, "--replay", run.model], { cwd: run.folder });
      const prompt = { type: "prompt", text: run.prompt, sessionId: session, context: context(run, resumed) };
      program.write(JSON.stringify(prompt) + "\n");
      // Steer and stop reach the replay as input lines; the `no-steer` replay stands for an agent without steering.
      if (run.model !== "no-steer")
        run.onSteer((text) => program.write(JSON.stringify({ type: "steer", text }) + "\n"));
      run.onStop(() => program.write(JSON.stringify({ type: "stop" }) + "\n"));
      let sessionId: string | undefined;
      let failure: string | undefined;
      for await (const line of program.stdout) {
        const message = JSON.parse(line) as Message;
        switch (message.type) {
          case "text":
            run.text(message.delta);
            break;
          case "thinking":
            run.thinking(message.delta);
            break;
          case "tool": {
            const { type: _type, ...tool } = message;
            run.tool(tool);
            break;
          }
          case "tasks":
            run.tasks(message.tasks);
            break;
          case "plan":
            run.plan(message.text);
            break;
          case "helper": {
            const { type: _type, ...helper } = message;
            run.helper(helper);
            break;
          }
          case "usage":
            run.usage(message.usage);
            break;
          case "ask":
            // The program waits for the answer on stdin, as a real agent waits for approval.
            program.write(JSON.stringify({ type: "answer", answer: await run.ask(message.question) }) + "\n");
            break;
          case "done":
            sessionId = message.sessionId;
            break;
          case "error":
            failure = message.message;
            break;
          default:
            // A replay with a message this agent does not speak yet must fail loudly.
            throw new Error(`${id} wrote a message ${name} does not know: ${line}`);
        }
      }
      const code = await program.exited;
      if (failure !== undefined) throw new Error(failure);
      if (code !== 0 || sessionId === undefined) throw new Error(`${id} exited with ${code}`);
      await sh(ctx, 'mkdir -p "$HOME/.$1/sessions" && : > "$HOME/.$1/sessions/$2"', id, sessionId);
      return { sessionId };
    },
  });

  return { id, name, icon: NEUTRAL_MARK, info, start };
}

/** A neutral mark for test agents (a dot in a ring), in the contract's SVG shape. */
const NEUTRAL_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22C6.477 22 2 17.523 2 12C2 6.477 6.477 2 12 2C17.523 2 22 6.477 22 12C22 17.523 17.523 22 12 22ZM12 20C16.418 20 20 16.418 20 12C20 7.582 16.418 4 12 4C7.582 4 4 7.582 4 12C4 16.418 7.582 20 12 20ZM12 15C10.343 15 9 13.657 9 12C9 10.343 10.343 9 12 9C13.657 9 15 10.343 15 12C15 13.657 13.657 15 12 15Z"/></svg>';

/**
 * What this turn was given, as plain text the `context` replay says back: the
 * session, the settings and, for a fresh session only, the earlier messages
 * (a very long one shortened, so the reply stays small).
 */
function context(run: ai.Run, resumed: boolean): string {
  const settings = [
    `model ${run.model}`,
    `level ${run.effort ?? "-"}`,
    `speed ${run.speed ?? "-"}`,
    `mode ${run.mode ?? "-"}`,
    `access ${run.access}`,
  ];
  const lines = [resumed ? `Carrying on ${run.sessionId}` : "Fresh session", settings.join(", ")];
  if (!resumed)
    for (const message of run.history) lines.push(`${message.role} ${message.name}: ${short(message.text)}`);
  return lines.join("\n");
}

function short(text: string): string {
  return text.length > 10_000 ? `${text.slice(0, 20)}… (${text.length} characters)` : text;
}

/** Runs a program to its end; its stdout lines, or undefined when it failed or is missing. */
async function lines(ctx: CallerActionContext, argv: [string, ...string[]]): Promise<string[] | undefined> {
  try {
    const program = ctx.proc(argv);
    const out: string[] = [];
    for await (const line of program.stdout) if (line) out.push(line);
    return (await program.exited) === 0 ? out : undefined;
  } catch {
    return undefined; // Not on PATH: the program could not start.
  }
}

/** Runs a short shell script with `args` as $1, $2, …; true when it exits 0. */
async function sh(ctx: CallerActionContext, script: string, ...args: string[]): Promise<boolean> {
  const program = ctx.proc(["/bin/sh", "-c", script, "sh", ...args]);
  for await (const _line of program.stdout);
  return (await program.exited) === 0;
}
