import { Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useClient } from "@tokamak/sdk/client";
import { Button } from "@tokamak/ui";
import type { ComposerProps } from "plugin:chat/client";
import { api } from "../lib/agents";
import { activeFor, forceStopTurn, stopTurn } from "../lib/turn-controls";

const stopSquare = "M6 6H18V18H6Z";

export function StopButton(props: ComposerProps): JSX.Element {
  const client = useClient();
  const [force, setForce] = createSignal(false, { ownedWrite: true });
  const turn = () => activeFor(props.threadId);
  createEffect(
    () => (turn()?.stoppingAt === undefined ? undefined : turn()?._id),
    (id) => {
      setForce(false);
      if (!id) return;
      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      void client.query(api.turns.forceStopDelay, { turnId: id }).then(
        (delay) => {
          if (!disposed && delay !== null) timer = setTimeout(() => setForce(true), delay);
        },
        () => {}, // The turn may have ended while the query was in flight.
      );
      return () => {
        disposed = true;
        clearTimeout(timer);
      };
    },
  );
  return (
    <Show
      when={force()}
      fallback={
        <Button
          variant="primary"
          icon={stopSquare}
          label="Stop"
          disabled={turn()?.stoppingAt !== undefined}
          onClick={() => {
            const id = turn()?._id;
            if (id) void stopTurn(client, id);
          }}
        />
      }
    >
      <Button
        variant="primary"
        onClick={() => {
          const id = turn()?._id;
          if (id) void forceStopTurn(client, id);
        }}
      >
        Force stop
      </Button>
    </Show>
  );
}
