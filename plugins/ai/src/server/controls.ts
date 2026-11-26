import { fail } from "@tokamak/sdk";
import { TURN_ENDED } from "@tokamak/sdk/agent-turn";
import type { Run } from "../contracts";
import { errorText } from "../shared/turn-shared";

type Steer = Parameters<Run["onSteer"]>[0];
type Stop = Parameters<Run["onStop"]>[0];
type SteerDelivery = "pending" | "delivered" | "failed";
type RecordSteer = (text: string, delivery?: SteerDelivery) => Promise<unknown>;
const STEER_REGISTRATION_MS = 500;
const STEER_COMMIT_ATTEMPTS = 3;

const running = new Map<string, ReturnType<typeof turnControl>>();

export function controlFor(turnId: string, owner: string) {
  const control = running.get(turnId);
  return control?.owner === owner ? control : undefined;
}

/** Bridges separate caller actions into the invocation owned by the sender's window. */
export function turnControl(
  turnId: string,
  owner: string,
  cancelQuestion?: () => Promise<void>,
  cancelBefore?: () => void,
) {
  let steer: Steer | undefined;
  let finishing = false;
  let stop: Stop | undefined;
  let stopRequested = false;
  let stopReady = false;
  let stopSent = false;
  let agentClosed = false;
  let closed = false;
  let forceKill: (() => Promise<void>) | undefined;
  let forcing: Promise<void> | undefined;
  let resolveForced!: () => void;
  const forcedEnd = new Promise<undefined>((resolve) => (resolveForced = () => resolve(undefined)));
  let steerLine: Promise<unknown> = Promise.resolve();
  let unsettledSteer: { text: string; delivery: "delivered" | "failed" } | undefined;
  // The row can appear before start registers its handlers. Hold early steers briefly and in order;
  // if the provider never registers, return a failure before any text is written to the reply.
  let releaseEarlySteers!: () => void;
  const earlySteers = new Promise<void>((resolve) => (releaseEarlySteers = resolve));
  let registrationTimer: ReturnType<typeof setTimeout> | undefined;

  function releaseSteers() {
    clearTimeout(registrationTimer);
    releaseEarlySteers();
  }

  function sendStop() {
    if (agentClosed || !stop || stopSent) return;
    stopSent = true;
    void Promise.resolve()
      .then(stop)
      .catch(() => {});
  }

  async function settleSteer(record: RecordSteer) {
    if (!unsettledSteer) return;
    const { text, delivery } = unsettledSteer;
    for (let attempt = 1; ; attempt++) {
      try {
        await record(text, delivery);
        unsettledSteer = undefined;
        return;
      } catch (error) {
        if (attempt === STEER_COMMIT_ATTEMPTS) throw error;
      }
    }
  }

  const control = {
    owner,
    onSteer(handler: Steer) {
      steer = handler;
      releaseSteers();
    },
    onStop(handler: Stop) {
      stop = handler;
      if (stopReady) sendStop();
    },
    steer(text: string, record: RecordSteer) {
      const delivery = steerLine.then(async () => {
        if (!steer && !agentClosed && !stopRequested) {
          registrationTimer ??= setTimeout(releaseSteers, STEER_REGISTRATION_MS);
          await earlySteers;
        }
        if (agentClosed || finishing || stopRequested) return noRunningTurn(turnId);
        const deliver = steer;
        if (!deliver) return fail("NoSteerHandler", { turnId });
        await settleSteer(record);
        // Record before delivery so even an immediate reaction follows the
        // steer.
        await record(text, "pending");
        const result = await Promise.resolve()
          .then(() => deliver(text))
          .then(
            () => ({ error: null }),
            (cause: unknown) => ({ error: errorText(cause) }),
          );
        unsettledSteer = { text, delivery: result.error === null ? "delivered" : "failed" };
        // Delivery is already decided. The next steer or finish can settle
        // the record if the server still cannot commit it here.
        await settleSteer(record).catch(() => {});
        if (result.error === TURN_ENDED || result.error === "Local contract channel ended")
          return noRunningTurn(turnId);
        return result;
      });
      steerLine = delivery.catch(() => {});
      return delivery;
    },
    acknowledgedSteer() {
      return unsettledSteer?.delivery === "delivered" ? unsettledSteer.text : undefined;
    },
    /** Cancel a pending run.ask before interrupting; some providers wait for the answer to proceed. */
    get active() {
      return !agentClosed;
    },
    async requestStop(mark: () => Promise<unknown>) {
      if (agentClosed) return false;
      if (stopRequested) return true;
      stopRequested = true;
      try {
        await mark();
      } catch (error) {
        stopRequested = false;
        throw error;
      }
      cancelBefore?.();
      releaseSteers();
      try {
        await cancelQuestion?.();
      } finally {
        stopReady = true;
        sendStop();
      }
      return true;
    },
    async run<T>(start: () => Promise<T>, kill: () => Promise<void>) {
      forceKill = kill;
      // A provider may never settle, even after every program dies. Race its promise, but let
      // any in-progress kill finish before releasing the queue if start settles during the kill.
      try {
        return await Promise.race([start(), forcedEnd]);
      } finally {
        await forcing;
        finishing = true;
        await steerLine;
      }
    },
    async forceStop() {
      if (closed || !forceKill) return noRunningTurn(turnId);
      forcing ??= forceKill().then(resolveForced);
      await forcing;
      return null;
    },
    finish() {
      agentClosed = true;
      releaseSteers();
    },
    close() {
      control.finish();
      closed = true;
      running.delete(turnId);
    },
  };
  running.set(turnId, control);
  return control;
}

export const noRunningTurn = (turnId: string) => fail("NotRunning", { turnId });
