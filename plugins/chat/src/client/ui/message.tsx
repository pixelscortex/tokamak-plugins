import { Show } from "solid-js";
import type { Id } from "@tokamak/sdk";
import { Avatar } from "@tokamak/ui";
import type { MessageDoc } from "../lib/api";
import { timeOfDay } from "../lib/time";
import { textOf } from "../../shared/text";

export interface MessageProps {
  readonly message: MessageDoc;
  readonly threadId: Id<"threads">;
  /**
   * The message after this one, if any. With `isLast`, lets a plugin tell
   * where a run of replies ends (e.g. `!next || next.role === "user"`) without
   * chat knowing what a turn is.
   */
  readonly next: MessageDoc | undefined;
  readonly isLast: boolean;
}

/** The text a message shows; other parts are not drawn. */
export { textOf as messageText };

/**
 * How a reply ended when it did not complete: "Stopped", "Failed · rate
 * limited", "Interrupted · Tokamak was closed". Undefined otherwise.
 */
function endLine(message: MessageDoc): string | undefined {
  const reason = message.error ? ` · ${message.error}` : "";
  if (message.status === "cancelled") return "Stopped";
  if (message.status === "error") return `Failed${reason}`;
  if (message.status === "interrupted") return `Interrupted${reason}`;
  return undefined;
}

/**
 * One message (Paper "Chat v7", "Turn · user"): the `avatar`, who wrote it and
 * when, the text, and an open `footer` other plugins append to, such as a change card.
 */
export const Message = (props: MessageProps) => (
  <article
    class="flex flex-col gap-2 pb-12"
    aria-label={`${props.message.author?.name ?? "Unknown"} at ${timeOfDay(props.message.createdAt)}`}
  >
    <header data-part="header" class="flex h-5 items-center gap-2">
      <Avatar name={props.message.author?.name ?? "?"} size={18} />
      <span class="text-label text-ink-3">{props.message.author?.name ?? "Unknown"}</span>
      <time class="text-data text-ink-3" datetime={new Date(props.message.createdAt).toISOString()}>
        {timeOfDay(props.message.createdAt)}
      </time>
    </header>
    <div
      data-part="body"
      class={[
        "max-w-read text-read break-words whitespace-pre-wrap text-ink",
        { "rounded-sm border border-dashed border-edge-strong px-3 py-2": props.message.status === "queued" },
      ]}
    >
      <Show when={props.message.status === "queued"}>
        <div class="text-label text-ink-3">Queued</div>
      </Show>
      {textOf(props.message)}
    </div>
    <Show when={endLine(props.message)}>
      <span class="text-label text-ink-3">{endLine(props.message)}</span>
    </Show>
    <div data-part="footer" class="flex flex-col gap-2 empty:hidden" />
  </article>
);
