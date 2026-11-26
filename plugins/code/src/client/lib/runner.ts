import { fail, isFailure, type MachineFailure, type TokamakClient } from "@tokamak/sdk";
import { state } from "@tokamak/sdk/client";
import { createSignal, untrack } from "solid-js";

/** The change-card predicate runs before a card can mount and use the client context. */
export const windowClient = state<TokamakClient | undefined>(undefined);

export function rememberClient(client: TokamakClient): void {
  if (untrack(windowClient) !== client) queueMicrotask(() => windowClient.set(client));
}

type Availability = "unknown" | "available" | "missing";

function runnerGate() {
  const [missing, setMissing] = createSignal(false, { ownedWrite: true });
  const gate = {
    availability: "unknown" as Availability,
    missing,
    probe: undefined as Promise<void> | undefined,
    setAvailability(value: Availability) {
      gate.availability = value;
      setMissing(value === "missing");
    },
  };
  return gate;
}

const runners = new WeakMap<TokamakClient, ReturnType<typeof runnerGate>>();

function gateFor(client: TokamakClient) {
  let gate = runners.get(client);
  if (!gate) {
    gate = runnerGate();
    runners.set(client, gate);
  }
  return gate;
}

export function runnerMissing(client: TokamakClient): boolean {
  return gateFor(client).missing();
}

const noMachine = fail("noMachine", null);

/** Only one action probes an unknown Runner. The queued actions share its availability result. */
export async function onRunner<T>(client: TokamakClient, ask: () => Promise<T>): Promise<T | MachineFailure> {
  const gate = gateFor(client);
  while (gate.probe) await gate.probe;
  const availability = gate.availability;
  if (availability === "missing") return noMachine;

  const result = Promise.resolve()
    .then(ask)
    .then((value) => {
      if (isFailure(value) && value.kind === "noMachine") {
        gate.setAvailability("missing");
      } else if (gate.availability === "unknown") {
        gate.setAvailability("available");
      }
      return value;
    });
  if (availability === "unknown") {
    const settled = () => {
      gate.probe = undefined;
    };
    gate.probe = result.then(settled, settled);
  }
  return result;
}

/** A visible window gets one new probe after a missing Runner, even if several features wake. */
export function watchRunnerFocus(client: TokamakClient, refresh?: () => void): () => void {
  const wake = () => {
    if (document.hidden) return;
    const gate = gateFor(client);
    if (gate.availability === "missing") gate.setAvailability("unknown");
    refresh?.();
  };
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", wake);
  return () => {
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", wake);
  };
}
