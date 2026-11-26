import { For, Show, type Accessor } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TokamakClient } from "@tokamak/sdk";
import { useClient, useQuery } from "@tokamak/sdk/client";
import { Collapsible, Icon, StatusIcon, icons } from "@tokamak/ui";
import type { MessageProps } from "plugin:chat/client";
import { api } from "../../server/_generated/api";
import { AgentMark } from "./agent-mark";
import { kinds } from "../lib/kinds";
import {
  actions,
  clock,
  doingParts,
  duration,
  useClock,
  useTurn,
  type Helper,
  type Step,
  type Turn,
} from "../lib/replies";
import { Spinning } from "./spinning";

/**
 * The agent's work, above the reply's text: thinking as a quiet line, the
 * actions line that folds every step into one row ("Worked · 5 actions"),
 * and one folded row per helper agent. Commands never become messages of
 * their own (Paper "Stage · thread": the folded work line; "Thread ideas",
 * option A). What a folded part opens to is read only while it is open.
 */
export function ReplyWork(props: MessageProps): JSX.Element {
  const client = useClient();
  const turn = useTurn(client, props);
  return (
    <Show when={turn()}>
      {(t) => (
        <div class="flex flex-col items-start gap-2">
          <Show when={t().hasThinking}>
            <Thinking client={client} turnId={t()._id} />
          </Show>
          <ActionsLine client={client} turn={t} />
          <For each={t().helpers} keyed={(helper) => helper._id}>
            {(helper) => <HelperRow client={client} helper={helper()} agentId={t().agent.id} />}
          </For>
        </div>
      )}
    </Show>
  );
}

/**
 * A folded block of the turn's work: a 32 px line on the tray, at least 360
 * wide (Paper's work line), that opens in place and grows to fit what it
 * opens to, up to the reading width. A closed panel leaves the page, and its
 * reads with it.
 */
function Folded(props: { children: JSX.Element }): JSX.Element {
  return (
    <div class="w-fit max-w-read min-w-fold rounded-sm bg-hover">
      <Collapsible.Root class="flex flex-col">{props.children}</Collapsible.Root>
    </div>
  );
}

/** Text a folded row opens to: thinking, a helper's answer; empty until read. */
function FoldedText(props: { text: string | null | undefined }): JSX.Element {
  return <p class="px-3 pb-2 text-row break-words whitespace-pre-wrap text-ink-3">{props.text ?? ""}</p>;
}

/** Thinking: a quiet line with no fill, so it does not weigh as much as the work. */
function Thinking(props: { client: TokamakClient; turnId: Turn["_id"] }): JSX.Element {
  return (
    <Collapsible.Root class="flex w-full max-w-read flex-col">
      <Collapsible.Trigger variant="quiet" lead={<Icon path={icons.more} />} class="w-fit">
        <span class="text-label">Thinking</span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <ThinkingText client={props.client} turnId={props.turnId} />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** Mounted only while Thinking is open, so the thinking is read only then. */
function ThinkingText(props: { client: TokamakClient; turnId: Turn["_id"] }): JSX.Element {
  const text = useQuery(props.client, api.turns.thinking, () => ({ turnId: props.turnId }));
  return <FoldedText text={text.data()} />;
}

/**
 * "Worked  14 actions  1m 12s" once the turn has ended; while it runs, the
 * step in progress and its clock ("Running  pnpm test auth  0:04", the
 * command in mono). Opens to one row per step. Hidden for a finished turn
 * that took no step.
 */
function ActionsLine(props: { client: TokamakClient; turn: Accessor<Turn> }): JSX.Element {
  const turn = () => props.turn();
  const running = () => turn().state === "running";
  const now = useClock(running);
  const count = () => turn().actions ?? 0;
  const current = () => {
    const step = turn().current;
    return step ? doingParts(step) : undefined;
  };
  return (
    <Show when={running() || count() > 0}>
      <Folded>
        <Collapsible.Trigger
          lead={running() ? <Spinning /> : <Icon path={icons.done} />}
          trail={
            <Show when={running()} fallback={duration((turn().finishedAt ?? now()) - turn().startedAt)}>
              {clock(now() - (turn().current?.startedAt ?? turn().startedAt))}
            </Show>
          }
        >
          <Show
            when={running()}
            fallback={
              <>
                <span class="text-ink-2">Worked</span>{" "}
                <span class="text-label text-ink-3">{actions(count())}</span>
              </>
            }
          >
            <span class="shrink-0 font-medium text-ink">{current()?.verb ?? "Working"}</span>{" "}
            <Show when={current()?.detail}>
              {(detail) => <span class="min-w-0 truncate text-data text-ink-3">{detail()}</span>}
            </Show>
          </Show>
        </Collapsible.Trigger>
        <Collapsible.Panel>
          <Steps client={props.client} turnId={turn()._id} now={now()} />
        </Collapsible.Panel>
      </Folded>
    </Show>
  );
}

/** The opened actions line's rows; mounted only while it is open, so the steps are read only then. */
function Steps(props: { client: TokamakClient; turnId: Turn["_id"]; now: number }): JSX.Element {
  const steps = useQuery(props.client, api.turns.steps, () => ({ turnId: props.turnId }));
  return (
    <ul aria-label="Actions" class="flex flex-col pb-1">
      <For each={steps.data()?.steps ?? []} keyed={(step) => step._id}>
        {(step) => <StepRow step={step()} now={props.now} />}
      </For>
    </ul>
  );
}

/** One step: its kind, what it touched, and its detail ("+6 −2") or its time (Paper's lane rows). */
function StepRow(props: { step: Step; now: number }): JSX.Element {
  const step = () => props.step;
  return (
    <li class="flex h-8 items-center gap-2 ps-2 pe-3">
      <span class="flex w-4 shrink-0 justify-center text-ink-3">
        <StepIcon step={step()} />
      </span>
      <span class="min-w-0 flex-1 truncate text-data text-ink-2">{step().title}</span>
      <span class="shrink-0 text-data text-ink-3">{step().detail ?? elapsed(step(), props.now)}</span>
    </li>
  );
}

function StepIcon(props: { step: Step }): JSX.Element {
  if (props.step.state === "running") return <StatusIcon status="running" size={12} />;
  if (props.step.state === "failed") return <StatusIcon status="failed" size={12} />;
  return <Icon path={kinds[props.step.kind ?? "other"].icon} size={12} />;
}

/** A step's time: final once it ended, a running clock before. */
function elapsed(step: { startedAt: number; finishedAt?: number }, now: number): string {
  return step.finishedAt === undefined
    ? clock(now - step.startedAt)
    : duration(step.finishedAt - step.startedAt);
}

/** One built-in helper agent, folded: its kind and task; opens to its answer. */
function HelperRow(props: { client: TokamakClient; helper: Helper; agentId: string }): JSX.Element {
  const helper = () => props.helper;
  const now = useClock(() => helper().state === "running");
  return (
    <Folded>
      <Collapsible.Trigger
        lead={
          helper().state === "running" ? (
            <Spinning />
          ) : helper().state === "failed" ? (
            <StatusIcon status="failed" />
          ) : (
            <AgentMark agentId={props.agentId} size={16} />
          )
        }
        trail={elapsed(helper(), now())}
      >
        <span class="shrink-0 text-ink-2">{helper().name ?? "Helper"}</span>{" "}
        <span class="min-w-0 truncate text-label text-ink-3">{helper().title}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <Show when={helper().hasText} fallback={<FoldedText text="No answer yet." />}>
          <HelperText client={props.client} stepId={helper()._id} />
        </Show>
      </Collapsible.Panel>
    </Folded>
  );
}

/** Mounted only while a helper's row is open, so its answer is read only then. */
function HelperText(props: { client: TokamakClient; stepId: Helper["_id"] }): JSX.Element {
  const text = useQuery(props.client, api.turns.helper, () => ({ stepId: props.stepId }));
  return <FoldedText text={text.data()} />;
}
