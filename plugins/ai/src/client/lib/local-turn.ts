import { isLocalReloadTimeout, type ArgsOf, type TokamakClient } from "@tokamak/sdk";
import { api } from "../../server/_generated/api";
import { RELOADED } from "../../shared/turn-timing";
import { windowAction } from "./window-actions";

/** Run a turn, settling it from the window if a retired AI build could not. */
export async function runLocalTurn(
  client: TokamakClient,
  input: Omit<ArgsOf<typeof api.run.turn>, "replyToken" | "windowId">,
) {
  const replyToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  try {
    return await windowAction(client, api.run.turn, { ...input, replyToken });
  } catch (error) {
    if (!isLocalReloadTimeout(error)) throw error;
    const released = await client.mutation(api.liveness.releaseReloaded, {
      messageId: input.messageId,
      replyToken,
    });
    if (released === "ended") return undefined;
    if (!released) throw error;
    return { state: "interrupted" as const, ended: RELOADED };
  }
}
