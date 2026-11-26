import { Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isFailure } from "@tokamak/sdk";
import { useClient } from "@tokamak/sdk/client";
import { Tooltip, icons } from "@tokamak/ui";
import { api, type Subscription } from "../lib/api";
import { modelName, nameOf } from "../lib/format";
import { manageGlyphs, openSubscription, removing } from "../lib/manage";

/**
 * The subscription card's action row (Paper "1 · Profiles · screen"): four
 * ghost `sm` icon buttons with tooltips. Models (the tooltip lists them) and
 * Details open the details screen; Check again reads plan and models anew;
 * Remove asks first. A failed check says why on the card itself.
 *
 * Each button is 24 px and they sit 2 px apart, as drawn: smaller than the
 * 32 px target rule, an exception the owner has yet to confirm.
 */
export function CardActions(props: {
  subscription: Subscription;
  /** "Add to profile" (TKM-264), before Remove. */
  addToProfile?: JSX.Element;
}): JSX.Element {
  const client = useClient();
  const [checking, setChecking] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  // Title and label, so two cards with the same title never share a control's name.
  const name = () => nameOf(props.subscription);
  async function check() {
    if (checking()) return;
    setChecking(true);
    setProblem(undefined);
    try {
      const result = await client.action(api.manage.checkAgain, { id: props.subscription.id });
      if (isFailure(result)) setProblem(result.data.message);
    } catch {
      setProblem("Could not check again. Try again.");
    } finally {
      setChecking(false);
    }
  }
  const open = () => openSubscription.set(props.subscription.id);
  const models = () =>
    props.subscription.models.length
      ? props.subscription.models.map((model) => modelName(model.name)).join(" · ")
      : "No models found";
  type Action = { label: () => string; icon: string; tip: () => string; run: () => unknown };
  const button = (action: Action) => {
    const busy = () => action.icon === manageGlyphs.refresh && checking();
    return (
      <Tooltip.Root>
        <Tooltip.Trigger
          size="sm"
          variant="ghost"
          icon={busy() ? icons.running : action.icon}
          label={action.label()}
          aria-busy={busy() ? "true" : undefined}
          onClick={() => void action.run()}
        />
        <Tooltip.Content>{action.tip()}</Tooltip.Content>
      </Tooltip.Root>
    );
  };
  return (
    <div class="flex flex-col gap-1">
      <div role="toolbar" aria-label={`${name()} actions`} class="flex items-center gap-hair">
        {button({ label: () => `${name()} models`, icon: manageGlyphs.models, tip: models, run: open })}
        {button({
          label: () => `Check ${name()} again`,
          icon: manageGlyphs.refresh,
          tip: () => "Check again",
          run: check,
        })}
        {/* Beside "Check again", which reads it: an unknown plan is never a word in the title. */}
        <Show when={!props.subscription.plan}>
          <span class="px-1 text-data text-ink-3">plan unknown</span>
        </Show>
        {button({
          label: () => `${name()} details`,
          icon: manageGlyphs.details,
          tip: () => "Details",
          run: open,
        })}
        {props.addToProfile}
        {button({
          label: () => `Remove ${name()}`,
          icon: manageGlyphs.remove,
          tip: () => "Remove",
          run: () => removing.set(props.subscription.id),
        })}
      </div>
      <Show when={problem()}>
        <p role="alert" class="m-0 text-label text-removed">
          {problem()}
        </p>
      </Show>
    </div>
  );
}
