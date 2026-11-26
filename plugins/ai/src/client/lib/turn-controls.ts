import { isFailure, type Id, type TokamakClient } from "@tokamak/sdk";
import { auth, state } from "@tokamak/sdk/client";
import { onDraftSubmit, type DraftSubmission } from "plugin:chat/client";
import type { TurnView } from "../../server/_functions";
import { errorText } from "../../shared/turn-shared";
import { api, notice, reasonLine, unavailable } from "./agents";
import { threadChoices, toStored } from "./choices";
import { windowAction } from "./window-actions";

export const localActiveTurn = state<TurnView | null>(null);

export function activeFor(threadId: string | undefined) {
  const turn = localActiveTurn();
  return turn?.threadId === threadId ? turn : null;
}

/** Intercept drafts for the creator using the same live identity and creator the row displays. */
export function onTurnDraft(
  client: TokamakClient,
  threadId: () => string,
  creatorId: () => string | undefined,
) {
  const me = auth.me();
  return onDraftSubmit(async (draft) => {
    if (draft.threadId !== threadId()) return false;
    const id = creatorId();
    return id !== undefined && id === me.id && submit(client, draft);
  });
}

async function submit(client: TokamakClient, { threadId, text, intent }: DraftSubmission) {
  const holder = await client.query(api.turns.pending, { threadId });
  if (!holder) return false;
  notice.set(undefined);
  if (holder.state !== "queued" && intent === "steer") {
    const result = await windowAction(client, api.run.steer, { turnId: holder._id, text });
    if (isFailure(result)) {
      if (result.kind === "noMachine" || result.kind === "runnerCapabilityUnavailable")
        throw new Error(reasonLine(result.kind, ""));
      if (result.kind === "NoSteerHandler")
        throw new Error("This agent doesn't accept follow-ups during a turn. Use Cmd+Enter to queue.");
      if (!(await client.query(api.turns.pending, { threadId }))) return false;
      throw new Error("This turn is running in another window or is ending.");
    }
    if (result.error) notice.set(`The agent could not receive the steer: ${result.error}`);
  } else {
    // A queued turn keeps the thread's choices as they are now.
    const picked = await threadChoices(client, threadId, false);
    if (!picked) throw new Error("Choose an agent before queuing a message.");
    const problem = unavailable(picked.agent);
    if (problem) throw new Error(problem);
    const { model, ...settings } = toStored(picked);
    const result = await client.mutation(api.turns.enqueue, {
      threadId,
      text,
      model: model ?? "default",
      ...settings,
    });
    if (isFailure(result)) throw new Error(reasonLine(result.kind, result.data.agent));
  }
  return true;
}

export async function stopTurn(client: TokamakClient, turnId: Id<"turns">) {
  try {
    const result = await windowAction(client, api.run.stop, { turnId });
    // A turn that is only saving its after work has already finished; Stop has nothing to say.
    if (isFailure(result)) {
      if (result.kind !== "NotRunning") notice.set(reasonLine(result.kind, ""));
      else if (!("finishing" in result.data))
        notice.set("This turn is running in another window or has ended.");
    }
  } catch (cause) {
    notice.set(`The turn could not stop: ${errorText(cause)}`);
  }
}

export async function forceStopTurn(client: TokamakClient, turnId: Id<"turns">) {
  try {
    const result = await windowAction(client, api.run.forceStop, { turnId });
    if (isFailure(result))
      notice.set(
        result.kind === "NotRunning"
          ? "This turn is running in another window or has ended."
          : result.kind === "TooEarly"
            ? "Still stopping…"
            : reasonLine(result.kind, ""),
      );
  } catch (cause) {
    notice.set(`The turn could not stop: ${errorText(cause)}`);
  }
}
