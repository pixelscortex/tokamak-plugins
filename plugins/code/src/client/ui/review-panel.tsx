import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isFailure, type Id, type MachineFailure, type ResultOf, type TokamakClient } from "@tokamak/sdk";
import { useClient } from "@tokamak/sdk/client";
import { FileName, Icon, Row, ScrollArea } from "@tokamak/ui";
import { api } from "../../server/_generated/api";
import { turnsOf } from "../lib/changes";
import { fileCodeIcon } from "../lib/icons";
import { Counts, filesLabel, minus, plus } from "./counts";

type Diff = Exclude<ResultOf<typeof api.changes.diff>, MachineFailure | null>;
type FileDiff = Diff["files"][number];
type Loaded =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly reason: string }
  | { readonly state: "none" }
  | { readonly state: "unsaved"; readonly number: number }
  | { readonly state: "ready"; readonly number: number; readonly diff: Diff };

/** The most hunk lines the panel shows; the caller action cuts the diff there (`DIFF_LINE_LIMIT`). */
const LINE_BUDGET = "3,000";

/** The turn to show: the one asked for, or the latest turn that changed files. */
async function load(client: TokamakClient, threadId: Id<"threads">, turnId?: string): Promise<Loaded> {
  const turns = await turnsOf(client, threadId, { fresh: true });
  let turn = turns.find((candidate) => candidate.turnId === turnId);
  // From the header's control: the counts are cheap to read, so find the turn with them first.
  for (let index = turns.length - 1; !turnId && index >= 0; index--) {
    const candidate = turns[index]!;
    const change = await client.action(api.changes.forTurn, {
      threadId,
      turnId: candidate.turnId,
      ranEarlier: [],
    });
    if (isFailure(change)) return unavailable(change);
    if (change?.files) {
      turn = candidate;
      break;
    }
  }
  if (!turn) return { state: "none" };
  const diff = await client.action(api.changes.diff, { threadId, turnId: turn.turnId });
  if (isFailure(diff)) return unavailable(diff);
  return diff ? { state: "ready", number: turn.number, diff } : { state: "unsaved", number: turn.number };
}

function unavailable(failure: MachineFailure): Loaded {
  return {
    state: "failed",
    reason:
      failure.kind === "noMachine" ? "Connect a machine to run this." : "The Runner cannot read the changes.",
  };
}

/**
 * The review panel in its simplest form (Paper "Coding · threads + review",
 * "Panel · review", without tabs or buttons): "Turn 3 · 4 files +86 −21",
 * the files with their counts, then plain diffs with no syntax colour.
 */
export function ReviewPanel(props: { threadId: Id<"threads">; turnId: string | undefined }): JSX.Element {
  const client = useClient();
  const [loaded, setLoaded] = createSignal<Loaded>({ state: "loading" }, { ownedWrite: true });
  createEffect(
    () => ({ threadId: props.threadId, turnId: props.turnId }),
    ({ threadId, turnId }) => {
      let active = true;
      setLoaded({ state: "loading" });
      load(client, threadId, turnId).then(
        (result) => active && setLoaded(result),
        (cause: unknown) =>
          active &&
          setLoaded({ state: "failed", reason: cause instanceof Error ? cause.message : String(cause) }),
      );
      return () => {
        active = false;
      };
    },
  );
  const view = () => {
    const current = loaded();
    switch (current.state) {
      case "loading":
        return <Note>Reading the changes…</Note>;
      case "failed":
        return <Note>Couldn't read this turn's changes: {current.reason}</Note>;
      case "none":
        return <Note>No turn in this thread has changed files yet.</Note>;
      case "unsaved":
        return <Note>Turn {current.number}: this turn's code wasn't saved.</Note>;
      case "ready":
        return <TurnReview number={current.number} diff={current.diff} />;
    }
  };
  return (
    <section aria-label="Review" class="flex min-h-0 flex-1 flex-col">
      {view()}
    </section>
  );
}

function Note(props: { children: JSX.Element }): JSX.Element {
  return <p class="px-4 py-3 text-row text-ink-2">{props.children}</p>;
}

function TurnReview(props: { number: number; diff: Diff }): JSX.Element {
  const title = () =>
    `Turn ${props.number} · ${filesLabel(props.diff.files.length)} ${plus(props.diff.added)} ${minus(props.diff.removed)}`;
  return (
    <>
      <h2 aria-label={title()} class="flex h-12 shrink-0 items-center gap-2 ps-4 pe-2">
        <span class="text-row font-medium text-ink">Turn {props.number}</span>
        <span class="text-row text-ink-2">· {filesLabel(props.diff.files.length)}</span>
        <Counts added={props.diff.added} removed={props.diff.removed} />
      </h2>
      {/* The panel's one scroller: diff lines wrap, so nothing inside scrolls sideways. */}
      <ScrollArea class="min-h-0 flex-1">
        <ul aria-label="Changed files" class="flex shrink-0 flex-col px-3 pt-1 pb-3 density-dense">
          <For each={props.diff.files} keyed={(file) => file.path}>
            {(file) => (
              <li>
                <Row
                  lead={<Icon path={fileCodeIcon} size={14} />}
                  trail={<FileCounts added={file().added} removed={file().removed} />}
                >
                  <FileName path={file().path} />
                </Row>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.diff.cut}>
          <p role="note" class="px-4 pb-3 text-label text-ink-3">
            This turn's diff is long: the panel shows its first {LINE_BUDGET} lines. Files after that are
            listed above without their changes.
          </p>
        </Show>
        <div class="flex flex-col gap-3 px-3 pb-3">
          <For each={props.diff.files} keyed={(file) => file.path}>
            {(file) => <FilePatch file={file()} />}
          </For>
        </div>
      </ScrollArea>
    </>
  );
}

/** A file row's counts (Paper's changed files): "+14" then "−9" right-aligned in its own lane. */
function FileCounts(props: { added: number; removed: number }): JSX.Element {
  return (
    <>
      <span class={["shrink-0 text-data", props.added ? "text-added" : "text-ink-3"]}>
        {props.added ? plus(props.added) : "0"}
      </span>
      <span class={["w-8 shrink-0 text-end text-data", props.removed ? "text-removed" : "text-ink-3"]}>
        {props.removed ? minus(props.removed) : "0"}
      </span>
    </>
  );
}

/**
 * One file's plain diff (Paper "Diff"): its name and counts on the tray, then
 * each hunk with old and new line numbers on the stage. Changed lines get a
 * quiet wash and a coloured sign; long lines wrap under their own text.
 */
function FilePatch(props: { file: FileDiff }): JSX.Element {
  return (
    <article
      aria-label={`Diff of ${props.file.path}`}
      class="flex flex-col overflow-hidden rounded-md surface-tray"
    >
      <header class="flex h-10 shrink-0 items-center gap-2 ps-3 pe-1">
        <span class="flex min-w-0 text-row font-medium text-ink">
          <FileName path={props.file.path} folder={false} class="min-w-0" />
        </span>
        <Counts added={props.file.added} removed={props.file.removed} />
      </header>
      <Show when={props.file.note}>{(note) => <PatchNote>{note()}</PatchNote>}</Show>
      <Switch>
        <Match when={props.file.patch === null}>
          <PatchNote>Not shown: past the panel's {LINE_BUDGET} lines.</PatchNote>
        </Match>
        <Match when={props.file.patch?.length ? props.file.patch : undefined}>
          {(patch) => (
            <div class="flex flex-col bg-stage pb-2">
              <For each={rows(patch())}>{(row) => <PatchRow row={row} />}</For>
            </div>
          )}
        </Match>
      </Switch>
      <Show when={props.file.partial}>
        <PatchNote>Cut here: the rest of this file is past the panel's {LINE_BUDGET} lines.</PatchNote>
      </Show>
    </article>
  );
}

function PatchNote(props: { children: JSX.Element }): JSX.Element {
  return <p class="bg-stage px-3 py-2 text-label text-ink-3">{props.children}</p>;
}

type PatchLine =
  | { readonly kind: "hunk"; readonly text: string }
  | {
      readonly kind: "context" | "added" | "removed" | "note";
      readonly old?: number;
      readonly new?: number;
      readonly text: string;
    };

/** Gives each line of a Git patch its old and new line numbers. */
function rows(patch: readonly string[]): PatchLine[] {
  const out: PatchLine[] = [];
  let old = 0;
  let next = 0;
  for (const line of patch) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      out.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) out.push({ kind: "added", new: next++, text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ kind: "removed", old: old++, text: line.slice(1) });
    else if (line.startsWith("\\")) out.push({ kind: "note", text: line.slice(2) });
    else out.push({ kind: "context", old: old++, new: next++, text: line.slice(1) });
  }
  return out;
}

function PatchRow(props: { row: PatchLine }): JSX.Element {
  const row = props.row;
  if (row.kind === "hunk")
    return (
      <div class="mt-2 flex h-8 shrink-0 items-center bg-tray ps-3 pe-1 first:mt-0">
        <span class="min-w-0 truncate text-data text-ink-3">{row.text}</span>
      </div>
    );
  if (row.kind === "note") return <div class="ps-16 text-label text-ink-3">{row.text}</div>;
  const number = "flex h-5 w-10 shrink-0 items-center justify-end text-data text-ink-3";
  return (
    <div
      class={[
        "flex min-w-0",
        { "bg-diff-added": row.kind === "added", "bg-diff-removed": row.kind === "removed" },
      ]}
    >
      <span class={number}>{row.old ?? ""}</span>
      <span class={number}>{row.new ?? ""}</span>
      <span
        class={[
          "w-6 shrink-0 text-center text-code",
          { "text-added": row.kind === "added", "text-removed": row.kind === "removed" },
        ]}
      >
        {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""}
      </span>
      <span
        class={[
          "min-w-0 flex-1 pe-3 text-code wrap-code",
          row.kind === "context" ? "text-ink-2" : "text-ink",
        ]}
      >
        {row.text}
      </span>
    </div>
  );
}
