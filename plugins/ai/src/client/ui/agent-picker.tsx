import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { auth } from "@tokamak/sdk/client";
import { Icon, Menu } from "@tokamak/ui";
import { modelLabel, type AgentEntry } from "../lib/agents";
import { ACCESS_LABEL, label, type Access, type Change, type Resolved } from "../lib/choices";
import { computerIcon, expandIcon } from "../lib/icons";
import { AgentMark } from "./agent-mark";

/**
 * The agent picker (Paper artboard "6 · Thread · picker open"):
 * one popover above the composer. Its columns choose the agent and model, then that
 * model's effort; the bar under them holds speed, mode, access level and the computer the
 * turn runs on. Every choice is a radio item, so the popover stays open while several
 * change; each one is stored as it is picked.
 *
 * The chip (`PickerChip`) and the column area (`PickerColumns`) are one element each, so
 * another plugin can add a column or a piece of the chip by naming them. What the picker
 * offers comes from the catalog for this composer. A stored choice the agent
 * no longer offers already reads as its first offered one (`offered` in
 * `shared/offered.ts`), here and in the turn alike.
 */
export function AgentPicker(props: {
  current: Resolved;
  threadId: string | undefined;
  agents: readonly AgentEntry[];
  notOffered: boolean;
  refreshCatalog: () => void;
  resetCatalog: () => void;
  /** What the popover sits above: the whole composer, as drawn, rather than the chip alone. */
  anchor: () => HTMLElement | undefined;
  /** Why the agent cannot answer now: only the agent and model column shows then. */
  missing: string | undefined;
  /** Opening asks every agent for its `info` again, so a fresh install or sign-in shows. */
  onOpen: (open: boolean) => void;
  change: (next: Change) => void;
}): JSX.Element {
  return (
    <Menu.Root onOpenChange={props.onOpen}>
      <PickerChip
        current={props.current}
        missing={props.missing}
        threadId={props.threadId}
        refreshCatalog={props.refreshCatalog}
        resetCatalog={props.resetCatalog}
      />
      <Menu.Content side="top" align="start" sideOffset={8} anchor={props.anchor() ?? null}>
        {/* Held to the popover's height, so a long model list scrolls inside the columns and
            the settings bar under them stays in view. */}
        <div class="flex min-h-0 flex-col gap-1">
          <PickerColumns
            current={props.current}
            missing={props.missing}
            change={props.change}
            agents={props.agents}
            notOffered={props.notOffered}
            threadId={props.threadId}
          />
          <Show when={props.missing === undefined}>
            <PickerSettings current={props.current} change={props.change} />
          </Show>
        </div>
      </Menu.Content>
    </Menu.Root>
  );
}

/**
 * The closed picker: the agent's mark, the model and its effort ("✳ Opus 5.5 · High ⇅").
 * Without a model to show (a missing agent, or one that offers none) it names the agent.
 * Screen readers (and tests) read "Agent: <name> · <model> · <effort>".
 */
function PickerChip(props: {
  current: Resolved;
  missing: string | undefined;
  threadId: string | undefined;
  refreshCatalog: () => void;
  resetCatalog: () => void;
}): JSX.Element {
  const model = () =>
    props.missing === undefined ? modelLabel(props.current.agent.name, props.current.model?.name) : undefined;
  const parts = () => {
    const shown = model();
    const effort = props.current.effort;
    return shown === undefined ? [] : effort === undefined ? [shown] : [shown, label(effort)];
  };
  // One text for screen readers (and tests); the drawn parts are hidden from them.
  const spoken = () => `Agent: ${[props.current.agent.name, ...parts()].join(" · ")}`;
  return (
    // The standard ghost trigger: its size owns height, padding and text, and it fills while
    // open. No start padding of its own, so its edge sits on the composer box's edge above.
    <Menu.Trigger variant="ghost" lead={<AgentMark agentId={props.current.agent.id} />}>
      <span class="sr-only">{spoken()}</span>
      <span aria-hidden="true">
        <Show when={parts().length > 0} fallback={props.current.agent.name}>
          <For each={parts()}>
            {(part, index) => (
              <>
                <Show when={index() > 0}>
                  <span class="px-1">·</span>
                </Show>
                {part}
              </>
            )}
          </For>
        </Show>
      </span>
      <span data-part="chipExtras" class="contents" />
      {/* Inside the text line, as an inline box, so it centres on the trimmed text. */}
      <Icon path={expandIcon} size={12} class="ms-2 inline-block align-middle" />
    </Menu.Trigger>
  );
}

/** One agent's model in the agent and model column: both ids, so picking it can switch agent. */
const modelKey = (agentId: string, modelId?: string) => JSON.stringify([agentId, modelId ?? null]);

/**
 * The popover's columns, side by side: "Agent and model", then "Effort" when the model
 * offers levels. Each column is a radio group with its title; the effort column follows
 * the model picked in the first.
 */
function PickerColumns(props: {
  current: Resolved;
  threadId: string | undefined;
  agents: readonly AgentEntry[];
  notOffered: boolean;
  missing: string | undefined;
  change: (next: Change) => void;
}): JSX.Element {
  const efforts = () => (props.missing === undefined ? (props.current.model?.efforts ?? []) : []);
  const pickModel = (key: string) => {
    const [agentId, modelId] = JSON.parse(key) as [string, string | null];
    const agent = props.agents.find((entry) => entry.id === agentId);
    if (!agent) return;
    // The same agent keeps the thread's other choices; another agent brings this device's
    // last picks for it, with the model just picked.
    if (agent.id === props.current.agent.id && modelId !== null && props.missing === undefined)
      props.change({ model: modelId });
    else props.change({ agent, ...(modelId !== null && { model: modelId }) });
  };
  return (
    <div class="flex min-h-0 shrink gap-1 overflow-y-auto overscroll-contain">
      <Menu.RadioGroup
        name="Agent and model"
        aria-label="Agent and model"
        value={modelKey(props.current.agent.id, props.current.model?.id)}
        onValueChange={pickModel}
        class="flex min-w-models flex-1 flex-col"
      >
        <ColumnTitle>Agent and model</ColumnTitle>
        <Show when={props.notOffered}>
          <ColumnTitle>
            <AgentMark agentId={props.current.agent.id} />
            <span>{props.current.agent.name} · Not available</span>
          </ColumnTitle>
        </Show>
        <For each={props.agents}>{(agent) => <AgentModels agent={agent} />}</For>
      </Menu.RadioGroup>
      <Show when={efforts().length > 0}>
        <Menu.RadioGroup
          name="Effort"
          aria-label="Effort"
          value={props.current.effort ?? null}
          onValueChange={(effort) => props.change({ effort })}
          class="flex w-effort shrink-0 flex-col"
        >
          <ColumnTitle>Effort</ColumnTitle>
          <For each={efforts()}>
            {(effort) => <Menu.RadioItem value={effort}>{label(effort)}</Menu.RadioItem>}
          </For>
        </Menu.RadioGroup>
      </Show>
      <div data-part="extraColumns" class="contents" />
    </div>
  );
}

/**
 * A column's or an agent's title: 28 tall (16 line, 8 above, 4 below), quiet label text.
 * Plain text, not a group label: one radio group holds every agent's models, and its
 * name comes from `aria-label`.
 */
function ColumnTitle(props: { children: JSX.Element }): JSX.Element {
  return (
    <div class="flex items-center gap-2 px-2 pt-2 pb-1 text-label text-ink-3 select-none">
      {props.children}
    </div>
  );
}

/**
 * One agent in the agent and model column: its mark and name over its models, each model
 * indented past the mark. An agent that offers no model (signed out, not installed) is
 * picked by its name instead, so it can still be chosen and its line read.
 */
function AgentModels(props: { agent: AgentEntry }): JSX.Element {
  return (
    // Named by the agent, so two agents' models of the same name stay apart.
    <div role="group" aria-label={props.agent.name} class="flex flex-col">
      <Show
        when={props.agent.info.models.length > 0}
        fallback={
          <Menu.RadioItem value={modelKey(props.agent.id)}>
            <AgentMark agentId={props.agent.id} class="text-ink-2" />
            {props.agent.name}
          </Menu.RadioItem>
        }
      >
        <ColumnTitle>
          <AgentMark agentId={props.agent.id} class="text-ink-2" />
          <span class="text-ink-2">{props.agent.name}</span>
        </ColumnTitle>
        <For each={props.agent.info.models}>
          {(model) => (
            <Menu.RadioItem value={modelKey(props.agent.id, model.id)}>
              {/* The mark's empty lane: models line up under the agent's name. */}
              <span class="size-mark shrink-0" />
              {modelLabel(props.agent.name, model.name) ?? model.name}
            </Menu.RadioItem>
          )}
        </For>
      </Show>
    </div>
  );
}

/**
 * The bar under the columns: speed and mode when the agent offers them, the access level,
 * and the computer the turn runs on. Each choice is a short radio group laid out in a row
 * (the picked one carries the check), so the keys that move through the columns reach it.
 * Turns use caller placement, so "Runs on" names it and offers nothing.
 */
function PickerSettings(props: { current: Resolved; change: (next: Change) => void }): JSX.Element {
  const me = auth.me();
  const labelled = (ids: readonly string[]) => ids.map((id) => ({ id, label: label(id) }));
  return (
    <div class="flex h-10 shrink-0 items-center gap-4 rounded-sm bg-tray px-1">
      <Show when={props.current.speed}>
        {(speed) => (
          <Choice
            name="Speed"
            options={labelled(props.current.agent.info.speeds)}
            value={speed()}
            onPick={(next) => props.change({ speed: next })}
          />
        )}
      </Show>
      <Show when={props.current.mode}>
        {(mode) => (
          <Choice
            name="Mode"
            title="Mode"
            options={labelled(props.current.agent.info.modes)}
            value={mode()}
            onPick={(next) => props.change({ mode: next })}
          />
        )}
      </Show>
      <Choice
        name="Access level"
        options={(["full", "ask"] as const).map((id) => ({ id, label: ACCESS_LABEL[id] }))}
        value={props.current.access}
        onPick={(next) => props.change({ access: next as Access })}
      />
      <span class="flex-1" />
      {/* A fact, not a choice: kept out of the menu's own tree, where plain text is skipped or misread. */}
      <span aria-hidden="true" class="inline-flex h-8 items-center gap-2 px-2 text-label">
        <span class="font-normal text-ink-3">Runs on</span>
        <Icon path={computerIcon} size={12} class="text-ink-2" />
        <span class="text-ink-2">{me.device.name}</span>
      </span>
    </div>
  );
}

/** One choice in the bar: its options side by side, after a quiet word when it has one ("Mode"). */
function Choice(props: {
  name: string;
  title?: string;
  options: readonly { id: string; label: string }[];
  value: string;
  onPick: (id: string) => void;
}): JSX.Element {
  return (
    <Menu.RadioGroup
      name={props.name}
      aria-label={props.name}
      value={props.value}
      onValueChange={props.onPick}
      class="flex items-center"
    >
      <Show when={props.title}>
        {(title) => <span class="px-2 text-label font-normal text-ink-3 select-none">{title()}</span>}
      </Show>
      {/* Apart, so each check reads as its own option's. */}
      <div class="flex items-center gap-1">
        <For each={props.options}>
          {(option) => <Menu.RadioItem value={option.id}>{option.label}</Menu.RadioItem>}
        </For>
      </div>
    </Menu.RadioGroup>
  );
}
