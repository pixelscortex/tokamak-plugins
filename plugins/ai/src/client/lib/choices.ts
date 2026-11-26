import type { TokamakClient } from "@tokamak/sdk";
import { state } from "@tokamak/sdk/client";
import type { Access, Info } from "../../contracts";
import type { Choices } from "../../server/schema";
import { offered, type Offered, type Picked } from "../../shared/offered";
import { agents, api, cachedCatalog, type AgentEntry } from "./agents";

export type { Access, Choices };

/** Choices resolved against what the agent offers now: what the row shows and the turn uses. */
export interface Resolved extends Offered {
  readonly agent: AgentEntry;
  readonly access: Access;
}

/**
 * One change in the picker: another agent (with one of its models when picked from the model
 * list), or a new model, level, speed, mode or access level for the same agent.
 */
export type Change =
  | { readonly agent: AgentEntry; readonly model?: string }
  | (Picked & { readonly access?: Access });

/** What a removed agent offers: nothing, so the row says it isn't installed. */
const GONE: Info = {
  installed: false,
  signedIn: false,
  install: "",
  signIn: "",
  models: [],
  speeds: [],
  modes: [],
};

/** This device's last picked agent: where a new thread starts. */
const lastAgent = state<string | null>(null, { keep: "device" });

/** This device's last model, level, speed and mode for each agent, used again on a new thread. */
const lastPicks = state<Readonly<Record<string, Picked>>>({}, { keep: "device" });

/** The new, unsent thread's permission level. Not kept: every thread starts on Full access. */
const newAccess = state<Access>("full");

/** The new thread's choices: this device's last picks, on the access picked for it. */
export function newThreadChoices(catalog?: readonly AgentEntry[]): Resolved | undefined {
  return deviceChoices(newAccess(), catalog);
}

/**
 * This device's last picks, for the new thread or a thread with none stored.
 * When that agent is gone, the first one that can answer now. Undefined
 * without agents (none installed, or a plain browser).
 */
export function deviceChoices(
  access: Access = "full",
  catalog?: readonly AgentEntry[],
): Resolved | undefined {
  const list = agents();
  const agent =
    list.find((entry) => entry.id === lastAgent()) ??
    list.find((entry) => entry.info.installed && entry.info.signedIn) ??
    list[0];
  return (
    agent &&
    resolveWith(catalog?.find((entry) => entry.id === agent.id) ?? agent, lastPicks()[agent.id] ?? {}, access)
  );
}

/**
 * A thread's stored choices as the agent offers them now. The thread keeps its
 * agent even when that plugin is gone: the row then says it isn't installed
 * and Send waits, instead of switching to another agent unasked.
 */
export function storedChoices(choices: Choices, catalog?: readonly AgentEntry[]): Resolved | undefined {
  const list = agents();
  if (list.length === 0) return undefined;
  const agent = (catalog ?? []).find((entry) => entry.id === choices.agent.id) ??
    list.find((entry) => entry.id === choices.agent.id) ?? { ...choices.agent, info: GONE };
  return resolveWith(agent, choices, choices.access);
}

function resolveWith(agent: AgentEntry, picked: Picked, access: Access): Resolved {
  return { agent, ...offered(agent.info, picked), access };
}

/** Back to what a thread stores: only what the agent offers, nothing undefined. */
export function toStored(resolved: Resolved): Choices {
  const { agent, model, effort, speed, mode, access } = resolved;
  return {
    agent: { id: agent.id, name: agent.name },
    ...(model && { model: model.id }),
    ...(effort !== undefined && { effort }),
    ...(speed !== undefined && { speed }),
    ...(mode !== undefined && { mode }),
    access,
  };
}

/**
 * A choice changed: the thread's choices change at once (the new thread's stay
 * in this window until its first Send), and this device remembers the agent,
 * model, level, speed and mode for the next new thread. Switching agent takes
 * that agent's last picks on this device, with the model picked beside it.
 */
export async function pick(
  client: TokamakClient,
  threadId: string | undefined,
  current: Resolved,
  change: Change,
): Promise<void> {
  const next =
    "agent" in change
      ? toStored(
          resolveWith(
            change.agent,
            {
              ...lastPicks()[change.agent.id],
              ...(change.model !== undefined && { model: change.model }),
            },
            current.access,
          ),
        )
      : { ...toStored(current), ...change };
  lastAgent.set(next.agent.id);
  if (!("agent" in change) || change.model !== undefined) {
    const { agent, access: _access, ...rest } = next;
    lastPicks.set((all) => ({ ...all, [agent.id]: rest }));
  }
  if (threadId === undefined) newAccess.set(next.access);
  else await client.mutation(api.choices.set, { threadId, ...next });
}

/**
 * What a thread's next turn uses, for Send and Queue: the new thread's picks
 * on its first Send (the next new thread then starts on Full access again),
 * else what the thread stores, else this device's last picks.
 */
export async function threadChoices(
  client: TokamakClient,
  threadId: string,
  first: boolean,
): Promise<Resolved | undefined> {
  const catalog = cachedCatalog(client, first ? undefined : threadId);
  if (first) {
    const resolved = newThreadChoices(catalog);
    newAccess.set("full");
    return resolved;
  }
  const stored = await client.query(api.choices.get, { threadId });
  return stored ? storedChoices(stored, catalog) : deviceChoices(undefined, catalog);
}

/** "high" → "High": levels, speeds and modes as the row shows them. */
export function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export const ACCESS_LABEL: Record<Access, string> = { full: "Full access", ask: "Ask first" };

/** The agent row's line for someone who did not start the thread. */
export function creatorOnlyLine(name: string | undefined): string {
  return `Only ${name ?? "the person who started this thread"} can run the agent here`;
}
