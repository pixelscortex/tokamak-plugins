import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TokamakClient } from "@tokamak/sdk";
import { auth, useClient, useQuery, useShortcuts } from "@tokamak/sdk/client";
import { holdSend, type ComposerProps } from "plugin:chat/client";
import { errorText, isSendersDevice } from "../../shared/turn-shared";
import {
  agentCatalog,
  agents,
  api,
  machineNotice,
  notice,
  refreshAgents,
  rememberCatalog,
  unavailable,
  type AgentEntry,
} from "../lib/agents";
import {
  creatorOnlyLine,
  deviceChoices,
  newThreadChoices,
  pick,
  storedChoices,
  type Change,
  type Resolved,
} from "../lib/choices";
import { watchQuestions } from "../lib/questions";
import { listenForQueue } from "../lib/turn";
import { activeFor, localActiveTurn, onTurnDraft, stopTurn } from "../lib/turn-controls";
import { AgentPicker } from "./agent-picker";

/**
 * The agent row under the composer box: the agent picker on the left (one chip that
 * opens one popover with columns, `ui/agent-picker.tsx`), a short line on the right.
 * Opening the picker asks every agent for its `info` again.
 * The choices belong to the thread (the new thread's stay in this window
 * until its first Send). A missing or signed-out agent's chip names only the agent,
 * its line says why, and Send stays off in this composer until it is fixed; the picker
 * always opens, so even a single agent can be asked again.
 *
 * Empty when no agent plugin can be reached, so chat stays plain chat. Each Send in this window begins a turn
 * with these choices (lib/turn.ts). The row also starts following this
 * person's waiting questions (lib/questions.ts) for the permission card.
 */
export function AgentRow(props: ComposerProps): JSX.Element {
  const client = useClient();
  void refreshAgents(client);
  watchQuestions(client);
  listenForQueue(client);
  const me = auth.me();
  const shortcuts = useShortcuts();
  const active = useQuery(client, api.turns.active, () => ({ threadId: props.threadId ?? "" }));
  const running = () => activeFor(props.threadId);
  createEffect(
    () => {
      const turn = active.data();
      return turn && isSendersDevice(turn, { user: me, device: me.device }) ? turn : null;
    },
    (turn) => {
      localActiveTurn.set(turn);
      return () => {
        if (localActiveTurn() === turn) localActiveTurn.set(null);
      };
    },
  );
  createEffect(
    () => (running()?.stoppingAt === undefined ? running()?._id : undefined),
    (turnId) =>
      turnId ? shortcuts.registerShortcut("escape", () => void stopTurn(client, turnId)) : undefined,
  );
  // The right-hand line while this window's turn runs here.
  const turnLine = () => {
    const turn = running();
    return turn ? (turn.stoppingAt === undefined ? "esc to stop" : "Stopping…") : undefined;
  };
  return (
    <Show
      when={props.threadId}
      fallback={<Row client={client} threadId={undefined} resolved={newThreadChoices} turnLine={turnLine} />}
    >
      {(threadId) => <OpenThreadRow client={client} threadId={threadId()} turnLine={turnLine} />}
    </Show>
  );
}

/**
 * An open thread's row: its stored choices, live; this device's last picks until it has any.
 * Someone who did not start the thread sees only who runs its agent; their Send posts text.
 */
function OpenThreadRow(props: {
  client: TokamakClient;
  threadId: string;
  turnLine: () => string | undefined;
}): JSX.Element {
  const me = auth.me();
  const stored = useQuery(props.client, api.choices.get, () => ({ threadId: props.threadId }));
  const creator = useQuery(props.client, api.choices.creator, () => ({ threadId: props.threadId }));
  onCleanup(
    onTurnDraft(
      props.client,
      () => props.threadId,
      () => creator.data()?.id,
    ),
  );
  const othersThread = () => {
    const started = creator.data();
    return started && started.id !== me.id ? started : undefined;
  };
  const resolved = (catalog?: readonly AgentEntry[]) => {
    const choices = stored.data();
    return choices ? storedChoices(choices, catalog) : deviceChoices(undefined, catalog);
  };
  return (
    <Show when={!stored.loading() && !creator.loading()}>
      <Show
        when={othersThread()}
        fallback={
          <Row
            client={props.client}
            threadId={props.threadId}
            resolved={resolved}
            turnLine={props.turnLine}
          />
        }
      >
        {(started) => (
          <div role="group" aria-label="Agent" class="flex h-8 shrink-0 items-center px-3">
            <span role="status" class="text-label text-ink-3">
              {creatorOnlyLine(started().name)}
            </span>
          </div>
        )}
      </Show>
    </Show>
  );
}

function Row(props: {
  client: TokamakClient;
  threadId: string | undefined;
  resolved: (catalog?: readonly AgentEntry[]) => Resolved | undefined;
  turnLine: () => string | undefined;
}): JSX.Element {
  let row: HTMLDivElement | undefined;
  const [catalog, setCatalog] = createSignal<readonly AgentEntry[] | undefined>(undefined);
  const [checking, setChecking] = createSignal(false);
  let revision = 0;
  let catalogJson: string | undefined;
  let retired = false;
  onCleanup(() => {
    revision++;
    retired = true;
  });
  const resetCatalog = () => {
    if (retired) return;
    revision++;
    rememberCatalog(props.client, props.threadId, undefined);
    setCatalog(undefined);
    setChecking(false);
    catalogJson = undefined;
  };
  const refreshCatalog = (check = true) => {
    if (retired) return;
    if (check) setChecking(true);
    const request = ++revision;
    void agentCatalog(props.client, props.threadId).then(
      (list) => {
        if (request !== revision) return;
        setChecking(false);
        rememberCatalog(props.client, props.threadId, list);
        const json = JSON.stringify(list);
        if (json === catalogJson) return;
        catalogJson = json;
        setCatalog(list);
      },
      () => {
        if (request !== revision) return;
        resetCatalog();
      },
    );
  };
  const resolved = () => props.resolved(catalog());
  const notOffered = () => {
    const current = resolved();
    const list = catalog();
    return Boolean(
      current &&
      list &&
      agents().some((entry) => entry.id === current.agent.id) &&
      !list.some((entry) => entry.id === current.agent.id),
    );
  };
  const missing = () => {
    const current = resolved();
    return notOffered()
      ? "Pick an available agent or change your selection."
      : current && unavailable(current.agent);
  };
  onCleanup(
    holdSend((composer) => composer.threadId === props.threadId && (checking() || missing() !== undefined)),
  );
  const refresh = (open: boolean) => {
    if (!open) return;
    void refreshAgents(props.client);
    refreshCatalog(false);
  };
  const change = (current: Resolved, next: Change) =>
    void pick(props.client, props.threadId, current, next).catch((cause: unknown) =>
      notice.set(errorText(cause)),
    );
  return (
    <Show when={resolved()}>
      {(current) => (
        // No padding at the start: the picker's edge sits on the box's edge above it, and
        // 4 px from the tray on the left and below alike.
        <div
          ref={(element: HTMLDivElement) => (row = element)}
          role="group"
          aria-label="Agent"
          class="flex h-8 shrink-0 items-center pe-3"
        >
          <AgentPicker
            current={current()}
            threadId={props.threadId}
            agents={catalog() ?? agents()}
            notOffered={notOffered()}
            refreshCatalog={refreshCatalog}
            resetCatalog={resetCatalog}
            missing={missing()}
            anchor={() => row?.parentElement ?? undefined}
            onOpen={refresh}
            change={(next) => change(current(), next)}
          />
          <span class="flex-1" />
          <span data-part="statusExtras" class="contents" />
          <Show when={machineNotice() ?? notice() ?? props.turnLine() ?? missing()}>
            {(line) => (
              <span role="status" class="text-label text-ink-3">
                {line()}
              </span>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
