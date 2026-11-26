import { errorText } from "../../shared/turn-shared";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useClient, useShortcuts } from "@tokamak/sdk/client";
import { Icon, Kbd, Tooltip } from "@tokamak/ui";
import type { ComposerProps } from "plugin:chat/client";
import type { Answer } from "../../contracts";
import { lockIcon } from "../lib/icons";
import { answers, questionFor, sendAnswer, stillAsked } from "../lib/questions";

const expiredLine = "This question expired when the app quit.";

/** Cards on screen now: with focus on no field, keys go to a card only when it is the one shown. */
let shown = 0;

// Ignore digits briefly so typing in the prompt cannot answer a new question by accident.
const DIGIT_GRACE_MS = 500;

/**
 * The permission question on the composer (Paper "System · rules", Composer
 * anatomy, state "Needs you"): the lock, "Claude wants to run" and the command
 * in mono on the tray above the prompt, then Approve, Always allow this
 * session, Decline and Cancel on keys 1 to 4. Paper's row has Deny and Allow;
 * the ticket's four answers take their place, Approve as the one dark button.
 * Shown only to the sender, on the device that runs the turn
 * (`turns:questions`), while their turn waits.
 */
export function PermissionCard(props: ComposerProps): JSX.Element {
  const client = useClient();
  const question = () => questionFor(props.threadId);
  const [sending, setSending] = createSignal(false);
  /** Why the shown question can no longer be answered here, with that question's id. */
  const [problem, setProblem] = createSignal<{ id: string; line: string } | undefined>();
  const stuck = () => {
    const current = problem();
    return current && current.id === question()?.id ? current.line : undefined;
  };

  // A question from before the app quit is on the row but no longer in this window: say so at once.
  let shortcutsReadyAt = 0;
  createEffect(question, (asked) => {
    if (!asked) return;
    shortcutsReadyAt = performance.now() + DIGIT_GRACE_MS;
    void stillAsked(client, asked).then(
      (held) => held || setProblem({ id: asked.id, line: expiredLine }),
      () => {},
    );
  });

  async function reply(answer: Answer): Promise<void> {
    const asked = question();
    if (!asked || sending() || stuck()) return;
    setSending(true);
    try {
      if (!(await sendAnswer(client, asked, answer))) setProblem({ id: asked.id, line: expiredLine });
    } catch (cause) {
      setProblem({ id: asked.id, line: errorText(cause) });
    } finally {
      setSending(false);
    }
  }

  let root: HTMLElement | undefined;
  shown++;
  onCleanup(() => shown--);
  /**
   * Keys 1 to 4 answer this card when focus is in its composer (the prompt,
   * the card) or on no field while it is the only card shown. A field that
   * already holds text keeps its digit: the shortcut declines the key.
   */
  const shortcuts = useShortcuts();
  answers.forEach((choice, index) =>
    onCleanup(
      shortcuts.registerShortcut(String(index + 1), () => {
        if (!question() || stuck() || !root || performance.now() < shortcutsReadyAt) return false;
        const composer = root.closest('[data-part="top"]')?.parentElement ?? root;
        const focus = document.activeElement;
        const mine = focus && focus !== document.body ? composer.contains(focus) : shown === 1;
        if (!mine || typing(focus)) return false;
        void reply(choice.answer);
        return true;
      }),
    ),
  );

  return (
    <Show when={question()}>
      {(asked) => (
        <div
          ref={(element: HTMLDivElement) => (root = element)}
          role="group"
          aria-label="Permission question"
          class="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 ps-3 pe-1"
        >
          <div class="flex min-w-0 grow items-center gap-2">
            <Icon path={lockIcon} class="size-4 shrink-0 text-warn" />
            <span class="shrink-0 text-row font-medium text-ink">
              {asked().agent} wants to {asked().action}
            </span>
            <code class="min-w-0 truncate text-data text-ink">{asked().subject}</code>
          </div>
          <Show when={!stuck()} fallback={<span class="pe-3 text-label text-ink-3">{stuck()}</span>}>
            <div class="ms-auto flex shrink-0 items-center gap-1">
              <For each={answers}>
                {(choice, index) => (
                  <Tooltip.Root>
                    <Tooltip.Trigger
                      variant={index() === 0 ? "primary" : "outline"}
                      disabled={sending()}
                      aria-keyshortcuts={String(index() + 1)}
                      onClick={() => void reply(choice.answer)}
                    >
                      {choice.label}
                    </Tooltip.Trigger>
                    <Tooltip.Content>
                      <Kbd keys={String(index() + 1)} />
                    </Tooltip.Content>
                  </Tooltip.Root>
                )}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}

/** True when keys go into text the person is writing: a field or editor that already holds text. */
function typing(target: Element | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target.value !== "";
  return target instanceof HTMLElement && target.isContentEditable && (target.textContent ?? "") !== "";
}
