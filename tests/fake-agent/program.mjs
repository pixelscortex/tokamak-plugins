// The fake agent program: replays one recorded script of messages, the way
// a real agent program (`claude`, `codex app-server`) would speak them. Run by
// Bun through the command the harness puts on PATH for each fake agent.
//
//   fake-agent --list             names of the scripts in ./replays, one per line
//   fake-agent --replay <name>    plays ./replays/<name>.jsonl in the current folder
//
// A script is JSON lines, one step each (blank lines and lines starting with
// "#" are skipped). The steps are the keys of `steps` below:
//   {"read": "prompt"}           reads the next JSON line from stdin, kept as `prompt`;
//                                read again for later input (a steer, an answer)
//                                optional "expect" checks a subset of the input
//                                ("exact": true checks the entire message)
//   {"out": <json>}              writes <json> as one line; {"$": "prompt.text"} inside
//                                it is replaced by that value from what was read, and
//                                {"$repeat": "ab", "times": 3} by "ababab" (long reports)
//   {"sleep": 50}                waits 50 ms
//   {"write": "file", "text": ""} writes a file in the current folder
//   {"gate": "go", "ms": 30000}  waits until a file named `go` exists in the current
//                                folder; gives up after `ms` (default 60 s) with exit 124
//   {"signals": "ignore"}        from here on ignores SIGTERM and SIGINT, like an agent
//                                that does not stop when asked (Force stop must kill it)
//   {"grandchild": "pids.json"} starts a descendant that ignores signals and records both PIDs
//   {"exit": 3}                  exits with that code
//   {"ask": <question>, "as": "push"}
//                                a permission question: writes {"type": "ask", "question": …}
//                                and waits for the next stdin line (the answer), kept as `push`
//   {"if": "push.answer", "is": "cancel", "then": [<steps>]}
//                                runs the steps only when that read value equals `is`
// The program exits 0 after the last step. It also exits (code 141) when stdin
// closes, and on SIGTERM/SIGINT unless told to ignore them, so a failed test
// never leaves it behind.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { deepStrictEqual, partialDeepStrictEqual } from "node:assert";

const replays = new URL("./replays/", import.meta.url);
const [flag, name] = process.argv.slice(2);

/** Exits once everything written has reached the pipe, so no last line is lost. */
function finish(code) {
  process.stdout.write("", () => process.exit(code));
  return new Promise(() => {});
}

if (flag === "--list") {
  const names = (await readdir(replays)).filter((file) => file.endsWith(".jsonl")).sort();
  process.stdout.write(names.map((file) => file.slice(0, -".jsonl".length) + "\n").join(""));
  await finish(0);
}
if (flag !== "--replay" || !name || !/^(?:[\w-]+\/)?[\w-]+$/.test(name)) {
  process.stderr.write("usage: fake-agent --list | --replay <name>\n");
  await finish(2);
}

/** Stdin as a queue of lines: each `read` takes the next one, waiting if none has come yet. */
const input = (() => {
  const lines = [];
  const waiting = [];
  let closed = false;
  const reader = createInterface({ input: process.stdin });
  reader.on("line", (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
  // The parent closed its end or went away: stop, whatever step the script is at.
  reader.on("close", () => {
    closed = true;
    void finish(141);
  });
  return {
    next: () =>
      lines.length
        ? Promise.resolve(lines.shift())
        : closed
          ? finish(141)
          : new Promise((resolve) => waiting.push(resolve)),
  };
})();

const stopOnSignal = (signal) => void finish(128 + (signal === "SIGINT" ? 2 : 15));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stopOnSignal);

const read = {};

/** Replaces each {"$": "a.b"} with that value from what the script has read. */
function fill(value) {
  if (Array.isArray(value)) return value.map(fill);
  if (value === null || typeof value !== "object") return value;
  if (typeof value.$ === "string") return value.$.split(".").reduce((at, key) => at?.[key], read);
  if (typeof value.$repeat === "string") return value.$repeat.repeat(value.times);
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner)]));
}

const steps = {
  async read(step) {
    read[step.read] = JSON.parse(await input.next());
    if (step.expect)
      (step.exact ? deepStrictEqual : partialDeepStrictEqual)(read[step.read], fill(step.expect));
  },
  async out(step) {
    // Wait until the pipe took it: a long line written just before exiting would be cut otherwise.
    await new Promise((resolve) => process.stdout.write(JSON.stringify(fill(step.out)) + "\n", resolve));
  },
  async sleep(step) {
    await Bun.sleep(step.sleep);
  },
  async write(step) {
    if (basename(step.write) !== step.write || [".", ".."].includes(step.write)) {
      throw new Error("Replay writes must name a file in the current folder");
    }
    await writeFile(step.write, step.text);
  },
  async gate(step) {
    const deadline = Date.now() + (step.ms ?? 60_000);
    while (!(await stat(step.gate).catch(() => undefined))) {
      if (Date.now() > deadline) {
        process.stderr.write(`fake-agent: gate "${step.gate}" never opened\n`);
        await finish(124);
      }
      await Bun.sleep(20);
    }
  },
  async signals(step) {
    if (step.signals !== "ignore") throw new Error(`Unknown signals setting ${step.signals}`);
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.off(signal, stopOnSignal);
      process.on(signal, () => {});
    }
  },
  async grandchild(step) {
    const hold = `
      for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {});
    `;
    const leaf = hold + `console.log("ready"); setInterval(() => {}, 60000);`;
    const child = spawn(
      process.execPath,
      [
        "-e",
        hold +
          `
      const { spawn } = require("node:child_process");
      const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(leaf)}], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      grandchild.stdout.once("data", () => console.log(grandchild.pid));
    `,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const grandchildPid = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("fake agent child exited before reporting a grandchild")));
      const lines = createInterface({ input: child.stdout });
      lines.once("line", (pid) => {
        lines.close();
        resolve(Number(pid));
      });
    });
    await writeFile(step.grandchild, JSON.stringify([process.pid, child.pid, grandchildPid]));
  },
  async exit(step) {
    await finish(step.exit);
  },
  async ask(step) {
    process.stdout.write(JSON.stringify({ type: "ask", question: fill(step.ask) }) + "\n");
    read[step.as ?? "answer"] = JSON.parse(await input.next());
  },
  async if(step) {
    if (fill({ $: step.if }) === step.is) await play(step.then);
  },
};

/** Runs steps in order; `if` runs its own list through this too. */
async function play(list) {
  for (const step of list) {
    const kind = Object.keys(steps).find((key) => key in step);
    if (!kind) throw new Error(`Unknown step ${JSON.stringify(step)}`);
    await steps[kind](step);
  }
}

const script = (await readFile(new URL(`${name}.jsonl`, replays), "utf8"))
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => JSON.parse(line));
await play(script);
await finish(0);
