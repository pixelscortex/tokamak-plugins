import { For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon, Menu, Tooltip, icons } from "@tokamak/ui";
import type { Subscription } from "../lib/api";
import type { Builder } from "../lib/builder";
import { shownCodes } from "../lib/format";
import { profileGlyph } from "../lib/profile-icons";

/** The row's other buttons are glyphs of their own; this one is the plain add. */
const profileAddGlyph = icons.add;

/**
 * The end of a subscription card's model line (Paper "1 · Profiles · screen"):
 * the codes of the profiles that use it. Up to three show; with more, two show
 * and "+N" stands for the rest. The model line wraps them to a line of their
 * own when they do not fit beside its text.
 */
export function CardProfiles(props: { subscription: Subscription; builder: Builder }): JSX.Element {
  const codes = () => shownCodes(props.builder.codesOf(props.subscription.id));
  return (
    <Show when={codes().shown.length}>
      <span class="flex shrink-0 items-center gap-2">
        <For each={codes().shown}>
          {(code) => (
            <span class="flex items-center gap-1 text-data text-ink-3">
              <Icon path={profileGlyph} size={12} />
              {code}
            </span>
          )}
        </For>
        <Show when={codes().more}>{(more) => <span class="text-data text-ink-3">+{more()}</span>}</Show>
      </span>
    </Show>
  );
}

/**
 * "Add to profile" in the card's action row: the keyboard's (and anyone's) way
 * to do what dragging the card does, always shown, an `sm` icon button with a
 * tooltip like the row's other buttons. The menu lists every profile; one that
 * already holds the card is marked "added" and cannot be picked, and while the
 * menu is open those profiles fade below, as they do during a drag. A press on
 * it never starts a drag (buttons are not drag handles, `lib/drag.ts`).
 */
export function AddToProfile(props: { subscription: Subscription; builder: Builder }): JSX.Element {
  const id = () => props.subscription.id;
  const label = () => `Add ${props.builder.nameOf(id())} to a profile`;
  return (
    <Menu.Root
      // The menu calls these from its own effects: read the id without tracking it.
      onOpenChange={(open: boolean) => props.builder.setOffered(open ? untrack(id) : undefined)}
      onAction={(profile: string) => void props.builder.add(profile, untrack(id))}
    >
      <Tooltip.Root>
        {/* One button, two parts: the tooltip's trigger renders the menu's. */}
        <Tooltip.Trigger
          size="sm"
          variant="ghost"
          icon={profileAddGlyph}
          label={label()}
          render={(attrs: Record<string, unknown>) => {
            // The tooltip's own content is left out: the menu trigger draws the icon once.
            const { children: _content, ...rest } = attrs;
            return (
              <Menu.Trigger {...rest} size="sm" variant="ghost" icon={profileAddGlyph} label={label()} />
            );
          }}
        />
        <Tooltip.Content>Add to profile</Tooltip.Content>
      </Tooltip.Root>
      <Menu.Content>
        <Menu.Group>
          <Menu.GroupLabel>Add to profile</Menu.GroupLabel>
          <For each={props.builder.profiles()} keyed={(profile: { id: string }) => profile.id}>
            {(profile) => {
              const holds = () => profile().subscriptions.includes(id());
              return (
                <Menu.Item value={profile().id} disabled={holds()}>
                  <span class="text-code">{profile().code}</span>
                  <span class="min-w-0 flex-1 truncate">{profile().name}</span>
                  <Show when={holds()}>
                    <span class="text-label text-ink-3">added</span>
                  </Show>
                </Menu.Item>
              );
            }}
          </For>
          <Show when={!props.builder.profiles().length}>
            <Menu.Item value="" disabled>
              No profiles yet
            </Menu.Item>
          </Show>
        </Menu.Group>
      </Menu.Content>
    </Menu.Root>
  );
}
