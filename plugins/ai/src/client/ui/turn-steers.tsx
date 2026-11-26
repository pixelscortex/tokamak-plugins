import { For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useClient } from "@tokamak/sdk/client";
import { Avatar, Icon } from "@tokamak/ui";
import { messageText, type MessageProps } from "plugin:chat/client";
import { steerIcon } from "../lib/icons";
import { useTurn } from "../lib/replies";
import { steeredBody } from "../lib/steers";

/**
 * A steered reply's body, in place of chat's: the agent's text cut where each
 * follow-up arrived, with the follow-up drawn between the two parts as the
 * person's own message, under a quiet "Steer" label. The text pieces keep
 * chat's body text style (`plugins/chat/src/client/ui/message.tsx`), and the
 * text is chat's (`messageText`), so streaming and copying read as before.
 * Steers belong to the reply, even after the agent stops or the window reloads.
 */
export function SteeredBody(props: MessageProps): JSX.Element {
  const turn = useTurn(useClient(), props);
  const pieces = () => {
    const t = turn();
    return t ? steeredBody(messageText(props.message), t) : [];
  };
  return (
    <div data-part="body" class="flex max-w-read flex-col gap-4">
      {/* By position, so streamed text updates its piece in place instead of redrawing it. */}
      <For each={pieces()} keyed={false}>
        {(piece) => (
          <Switch>
            <Match when={piece().kind === "text"}>
              <div class="text-read break-words whitespace-pre-wrap text-ink">{piece().text}</div>
            </Match>
            <Match when={piece().kind === "steer"}>
              <Steer text={piece().text} sender={turn()?.sender.name ?? "You"} />
            </Match>
          </Switch>
        )}
      </For>
    </div>
  );
}

/**
 * One follow-up: "↳ Steer", then the person's author line and text drawn as
 * chat draws their message (avatar 18, name in `text-label`, text in
 * `text-read`). Announced as a group, "Steer from Sam".
 */
function Steer(props: { text: string; sender: string }): JSX.Element {
  return (
    // `py-2` on the body's `gap-4`: 24 around a steer, so the person's text stands apart from the agent's.
    <div role="group" aria-label={`Steer from ${props.sender}`} class="flex flex-col gap-2 py-2">
      <span class="flex h-5 items-center gap-1 text-label text-ink-3">
        <Icon path={steerIcon} size={12} />
        Steer
      </span>
      <span class="flex h-5 items-center gap-2">
        <Avatar name={props.sender} size={18} />
        <span class="text-label text-ink-3">{props.sender}</span>
      </span>
      <Show when={props.text}>
        <p class="text-read break-words whitespace-pre-wrap text-ink">{props.text}</p>
      </Show>
    </div>
  );
}
