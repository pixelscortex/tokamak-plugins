import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon, Menu, icons } from "@tokamak/ui";
import type { Subscription } from "../lib/api";
import type { Builder, Profile } from "../lib/builder";
import { countOf, titleOf } from "../lib/format";
import { gripGlyph, profileGlyph } from "../lib/profile-icons";
import { CompanyMark } from "./company-mark";

/**
 * One profile (Paper "1 · Profiles · screen", a profile box): its code and
 * name, "Fill first", and its subscriptions numbered in the order they are
 * used. Pointing at it dims the cards it does not hold ("4a"); while a card
 * is dragged it rings as the target and shows where the card would land, or
 * fades and says "added" when it already holds that card ("4b").
 *
 * Every row has a menu (Move up, Move down, Remove) so the keyboard can do
 * what dragging does; its button shows when the row is pointed at or focused.
 */
export function ProfileBox(props: {
  profile: Profile;
  builder: Builder;
  subscriptions: ReadonlyMap<string, Subscription>;
}): JSX.Element {
  const profile = () => props.profile;
  const builder = () => props.builder;
  const carry = () => builder().drag.carry();
  const over = () => {
    const target = builder().drag.over();
    return target?.profile === profile().id && !builder().added(profile()) ? target : undefined;
  };
  /** The rows as drawn: a row carried inside this profile leaves its place; the slot shows where it lands. */
  const rows = () => {
    const carried = carry();
    return profile().subscriptions.filter(
      (id) => !(carried?.from === profile().id && carried.subscription === id),
    );
  };
  const slot = () => over()?.index;
  const pointedHere = () => builder().pointed() === profile().id && !carry();

  return (
    <section
      data-profile={profile().id}
      aria-label={`${profile().code}, ${profile().name}`}
      tabindex="-1"
      data-pointed={pointedHere() || undefined}
      data-target={over() ? "" : undefined}
      data-added={builder().added(profile()) || undefined}
      class={[
        "flex min-w-0 flex-col gap-1 rounded-md p-1 surface-tray outline-none transition",
        "data-pointed:bg-card data-pointed:inset-ring data-pointed:inset-ring-edge",
        "data-target:bg-card data-target:inset-ring data-target:inset-ring-edge-strong data-added:opacity-40",
      ]}
      onPointerEnter={() => builder().setPointed(profile().id)}
      onPointerLeave={() => builder().pointed() === profile().id && builder().setPointed(undefined)}
      onFocusIn={() => builder().setPointed(profile().id)}
      onFocusOut={(event: FocusEvent & { currentTarget: HTMLElement }) => {
        if (
          !event.currentTarget.contains(event.relatedTarget as Node | null) &&
          builder().pointed() === profile().id
        )
          builder().setPointed(undefined);
      }}
    >
      <header class="flex h-10 items-center gap-2 px-3">
        <Icon path={profileGlyph} size={14} class="text-ink-3" />
        <h3 class="m-0 flex min-w-0 flex-1 items-center gap-2 font-normal">
          <span class="text-code font-medium text-ink">{profile().code}</span>
          <span class="min-w-0 truncate text-row text-ink-2">{profile().name}</span>
        </h3>
        <Show
          when={builder().added(profile())}
          fallback={<span class="text-label text-ink-3">Fill first</span>}
        >
          <span class="flex items-center gap-1 text-label text-ink-3">
            <Icon path={icons.check} size={12} />
            added
          </span>
        </Show>
      </header>
      {/* An empty list would still take a gap: the box then shows only its hint. */}
      <Show when={rows().length > 0 || slot() !== undefined}>
        <ol class="m-0 flex list-none flex-col gap-1 p-0" aria-label={`${profile().code}, in use order`}>
          <For each={rows()}>
            {(id, index) => (
              <>
                <Show when={slot() === index()}>
                  <DropSlot position={index() + 1} />
                </Show>
                <Entry
                  profile={profile()}
                  builder={builder()}
                  subscription={props.subscriptions.get(id)}
                  id={id}
                  position={index()}
                  count={profile().subscriptions.length}
                />
              </>
            )}
          </For>
          <Show when={slot() !== undefined && slot()! >= rows().length}>
            <DropSlot position={rows().length + 1} />
          </Show>
        </ol>
      </Show>
      <Show when={!profile().subscriptions.length && slot() === undefined}>
        <p class="m-0 flex h-10 items-center px-3 text-label text-ink-3">Drag a subscription here</p>
      </Show>
    </section>
  );
}

/** Where a dragged card would land: a dashed row with the number it would get. */
function DropSlot(props: { position: number }): JSX.Element {
  return (
    <li
      aria-hidden="true"
      class="flex h-10 items-center rounded-sm border border-dashed border-edge-strong ps-8 text-data text-ink-3"
    >
      {props.position}
    </li>
  );
}

function Entry(props: {
  profile: Profile;
  builder: Builder;
  subscription: Subscription | undefined;
  id: string;
  position: number;
  count: number;
}): JSX.Element {
  const title = () => (props.subscription ? titleOf(props.subscription) : "Subscription");
  /** The right-hand note: several accounts are counted, one shows its label. */
  const note = () => {
    const subscription = props.subscription;
    if (!subscription) return "";
    if (!subscription.enabled) return "Off";
    return subscription.accounts.length > 1
      ? countOf(subscription.accounts.length, "account")
      : subscription.label;
  };
  const name = () => [title(), props.subscription?.label].filter(Boolean).join(", ");
  return (
    <li
      data-entry={props.id}
      aria-label={`${props.position + 1}. ${name()}`}
      class="group/entry flex h-10 cursor-grab items-center gap-2 rounded-sm bg-card ps-2 pe-1 select-none"
      onPointerDown={(event: PointerEvent) =>
        props.builder.drag.start(event, { subscription: props.id, from: props.profile.id })
      }
    >
      <Icon path={gripGlyph} size={12} class="text-ink-3" />
      <span class="w-3 shrink-0 text-data text-ink-3">{props.position + 1}</span>
      <Show when={props.subscription}>
        {(subscription) => <CompanyMark company={subscription().company} size={16} />}
      </Show>
      <span class="min-w-0 flex-1 truncate text-row font-medium text-ink">{title()}</span>
      <span class="truncate text-label text-ink-3">{note()}</span>
      <span class="opacity-0 transition group-hover/entry:opacity-100 group-focus-within/entry:opacity-100 has-data-open:opacity-100">
        <Menu.Root
          onAction={(value: string) => {
            if (value === "up") void props.builder.move(props.profile.id, props.id, props.position - 1);
            else if (value === "down")
              void props.builder.move(props.profile.id, props.id, props.position + 1);
            else void props.builder.remove(props.profile.id, props.id);
          }}
        >
          <Menu.Trigger
            variant="ghost"
            size="sm"
            icon={icons.more}
            label={`${name()} in ${props.profile.code}`}
            data-entry-menu={`${props.profile.id} ${props.id}`}
          />
          <Menu.Content>
            <Menu.Item value="up" disabled={props.position === 0}>
              Move up
            </Menu.Item>
            <Menu.Item value="down" disabled={props.position === props.count - 1}>
              Move down
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item value="remove" destructive>
              Remove from {props.profile.code}
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
      </span>
    </li>
  );
}
