/** States in which a turn holds its thread (one writer); a second turn cannot begin. */
export const ACTIVE = ["running", "waiting"] as const;
/** States of a turn that ran and has ended. */
export const ENDED = ["done", "failed", "stopped", "interrupted"] as const;

import type { AuthContext } from "@tokamak/sdk";
import type { Info } from "../contracts";

export function setupReason(agent: string, info: Info, withCommand = true): string | undefined {
  if (info.installed && info.signedIn) return;
  const reason = info.installed
    ? `${agent} is signed out. Sign in, then come back.`
    : (info.updateRequired ?? `${agent} isn't installed.`);
  const command = info.installed ? info.signIn : info.install;
  return withCommand && command ? `${reason} Run \`${command}\`.` : reason;
}

export function isSendersDevice(
  turn: { sender: { id: string; device: string } },
  auth: Pick<AuthContext, "user" | "device">,
) {
  return turn.sender.id === auth.user.id && turn.sender.device === auth.device.id;
}

/** Whether two turns were sent by the same person from the same device. */
export function sameSender(
  a: { sender: { id: string; device: string } },
  b: { sender: { id: string; device: string } },
) {
  return a.sender.id === b.sender.id && a.sender.device === b.sender.device;
}

export function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** An older caller can reject a point hook before the turn action starts. */
export function hookRunnerUpdate(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause && "kind" in cause && cause.kind === "hookRunnerUnavailable")
    return "Update Tokamak on this computer to send turns. A plugin that hooks this turn needs a newer version.";
}
