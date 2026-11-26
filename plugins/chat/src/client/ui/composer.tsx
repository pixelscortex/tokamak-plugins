import { Textarea } from "@ui-sdk/solid/textarea";
import type { JSX } from "@solidjs/web";
import type { Id } from "@tokamak/sdk";
import { Button } from "@tokamak/ui";
import type { Folder } from "../lib/api";
import { isHeld } from "../lib/hold";
import type { DraftIntent } from "../lib/sent";
import { glyphs } from "../lib/icons";

export interface ComposerProps {
  /** The thread the text goes to; undefined while the thread is new and unsent. */
  readonly threadId: Id<"threads"> | undefined;
  /** Where the thread works: the new thread's pick, or the open thread's folder. */
  readonly folder: Folder | undefined;
  readonly draft: string;
  /** True while a Send is on its way; the text stays until it has arrived. */
  readonly sending: boolean;
  readonly onDraft: (text: string) => void;
  readonly onSend: (intent?: DraftIntent) => void;
}

/**
 * The composer (Paper "Chat v7", composer slot): a tray holding an open `top`
 * area and the `box` with the prompt and Send. Other plugins add inside `top`
 * (a question card) and after `box` (an agent row); both sit in the same tray.
 * Send (the button and Enter) is off while another plugin holds it (`holdSend`).
 */
export const Composer = (props: ComposerProps) => (
  <div class="nest-lg/1 flex flex-col gap-1 surface-tray">
    <div data-part="top" class="flex flex-col gap-1 empty:hidden" />
    <div data-part="box" class="flex min-h-0 flex-col gap-2 rounded-inner surface-card py-3 ps-2 pe-3">
      {/* @tokamak/ui's Textarea draws a well with an edge; the composer's anatomy
          has none, so this is the same ui-sdk textarea with the composer's own look. */}
      <Textarea
        autoResize
        rows={1}
        submitShortcut="enter"
        aria-label="Message"
        placeholder="Write a message"
        value={props.draft}
        onValueChange={(text: string) => props.onDraft(text)}
        onSubmit={() => !isHeld(props) && props.onSend()}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.isComposing
          ) {
            event.preventDefault();
            if (!isHeld(props)) props.onSend("queue");
          }
        }}
        data-composer-input=""
        class="block min-h-8 w-full resize-none bg-transparent py-1 ps-2 text-read text-ink outline-none placeholder:text-ink-3 field-sizing-content"
      />
      <div class="flex h-8 items-center gap-1">
        <span data-part="tools" class="flex items-center gap-1 empty:hidden" />
        <span class="flex-1" />
        <SendButton disabled={props.sending || !props.draft.trim() || isHeld(props)} onSend={props.onSend} />
      </div>
    </div>
  </div>
);

/** Send: filled once there is text to send. */
function SendButton(props: { disabled: boolean; onSend: () => void }): JSX.Element {
  return (
    <Button
      variant={props.disabled ? "ghost" : "primary"}
      icon={glyphs.arrowUp}
      label="Send"
      disabled={props.disabled}
      onClick={() => props.onSend()}
    />
  );
}

/** Moves the caret into the composer on screen, e.g. after ⌘N. */
export function focusComposer(): void {
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-composer-input]")?.focus());
}
