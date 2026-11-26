import { isFailure, type Id, type MachineFailure, type TokamakClient } from "@tokamak/sdk";
import { state } from "@tokamak/sdk/client";
import type { Info } from "../../contracts";
import { setupReason } from "../../shared/turn-shared";
import { api } from "../../server/_generated/api";
import { onCallerAction, windowAction } from "./window-actions";

export { api };

export interface AgentEntry {
  readonly id: string;
  readonly name: string;
  /** The agent's mark as its plugin gave it (an SVG document); see `Agent.icon`. */
  readonly icon?: string;
  readonly info: Info;
}

/** Installed agents as this computer’s Runner last answered. */
export const agents = state<readonly AgentEntry[]>([]);

/** A short line the row shows after a turn could not begin; cleared by the next Send. */
export const notice = state<string | undefined>(undefined);

/** A failed turn start's composer notice, cleared when a caller action succeeds. */
export const machineNotice = state<string | undefined>(undefined);
export const connectMachine = "Connect a machine to run this.";

let unlistenActions: (() => void) | undefined;
let asking: Promise<void> | undefined;
let queued: Promise<void> | undefined;
let connected: TokamakClient | undefined;

function clearMachineNotice(): void {
  machineNotice.set(undefined);
  notice.set((line) => (line === connectMachine ? undefined : line));
}

/** This window's connection, as the row or the heading last saw it; turns run through it. */
export function connectedClient(): TokamakClient | undefined {
  return connected;
}

/**
 * Asks every agent plugin for its `info` again, on this computer. Called
 * whenever the row or the heading appears and whenever a picker opens, so a
 * fresh install or sign-in shows without a restart. An ask already on its way
 * may have started before the change, so a call meanwhile asks once more after
 * it (several such calls share that one).
 */
export function refreshAgents(client: TokamakClient): Promise<void> {
  if (connected !== client) {
    const changed = connected !== undefined;
    connected = client;
    unlistenActions?.();
    unlistenActions = onCallerAction(client, clearMachineNotice);
    queueMicrotask(() => {
      if (connected !== client) return;
      if (changed) agents.set([]);
      clearMachineNotice();
    });
  }
  if (asking) {
    queued ??= asking.then(() => {
      queued = undefined;
      return refreshAgents(connected ?? client);
    });
    return queued;
  }
  asking = windowAction(client, api.agents.list, {})
    .then(
      (list) => {
        if (connected !== client || isFailure(list)) return;
        // Discovery can complete while a menu is open; keep unchanged options mounted.
        if (JSON.stringify(agents()) !== JSON.stringify(list)) agents.set(list);
      },
      () => {
        if (connected === client) agents.set([]);
      },
    )
    .finally(() => {
      asking = undefined;
    });
  return asking;
}

interface WindowCatalog {
  draft?: readonly AgentEntry[];
  open?: { threadId: string; entries: readonly AgentEntry[] };
}
const catalogs = new WeakMap<TokamakClient, WindowCatalog>();

export function rememberCatalog(
  client: TokamakClient,
  threadId: string | undefined,
  entries: readonly AgentEntry[] | undefined,
) {
  const previous = catalogs.get(client) ?? {};
  catalogs.set(
    client,
    threadId === undefined
      ? { ...previous, draft: entries }
      : { ...previous, open: entries && { threadId, entries } },
  );
}

export function cachedCatalog(client: TokamakClient, threadId: string | undefined) {
  const current = catalogs.get(client);
  return threadId === undefined
    ? current?.draft
    : current?.open?.threadId === threadId
      ? current.open.entries
      : undefined;
}

/** Choices for one composer. Keep this answer separate from discovery and marks. */
export async function agentCatalog(client: TokamakClient, threadId: string | undefined) {
  const list = await windowAction(
    client,
    api.agents.list,
    threadId === undefined ? { draft: true } : { threadId: threadId as Id<"threads"> },
  );
  return isFailure(list) ? undefined : list;
}

/** Why a turn cannot run or begin, as `run:turn` fails or the row sees it. */
export type Reason = "NoAgent" | "NotInstalled" | "SignedOut" | "Busy" | "Answered" | MachineFailure["kind"];

/** The row's line for `reason`, naming the agent as a person sees it. */
export function reasonLine(reason: Reason, agent: string, updateRequired?: string): string {
  switch (reason) {
    case "noMachine":
    case "machineOffline":
    case "machineLost":
      return connectMachine;
    case "machineForbidden":
    case "machineLimit":
    case "runnerArtifactMismatch":
    case "serverOnly":
    case "runnerCapabilityUnavailable":
      return "This machine cannot run this action.";
    case "NotInstalled":
      return updateRequired ?? `${agent} isn't installed.`;
    case "SignedOut":
      return `${agent} is signed out. Sign in, then come back.`;
    case "Busy":
      return `${agent} is still working in this thread.`;
    case "Answered":
      return `${agent} already answered this message.`;
    case "NoAgent":
      return `${agent} is no longer installed.`;
  }
}

/** Why Send cannot reach `agent` now, in the row's words; undefined when it can. */
export function unavailable(agent: AgentEntry): string | undefined {
  return setupReason(agent.name, agent.info, false);
}

/**
 * A model's name as people read it, without the agent's name in front:
 * "Claude Fable 5.2" under Claude is "Fable 5.2". Turns from before Claude
 * named its default by the model stored "Default (recommended)": that reads
 * "Default", since which model it was then is not known.
 */
export function modelLabel(agentName: string | undefined, name: string | undefined): string | undefined {
  const model = name?.replace(/^(default)\s*\(recommended\)$/i, "$1");
  if (!model) return undefined;
  if (!agentName) return model;
  const prefix = `${agentName} `;
  return model.toLowerCase().startsWith(prefix.toLowerCase()) && model.length > prefix.length
    ? model.slice(prefix.length)
    : model;
}
