import { createEffect, createSignal, onCleanup } from "solid-js";
import { isFailure, type TokamakClient } from "@tokamak/sdk";
import { useQuery } from "@tokamak/sdk/client";
import type { ProfileView } from "../../server/profiles";
import { api, type Subscription } from "./api";
import { createDrag, type Carry, type Over } from "./drag";
import { titleOf } from "./format";

export type Profile = ProfileView;

/** What a person reads when a change could not reach the server. */
export const UNSAVED = "That change did not save. Try again.";

/**
 * The Profiles section's state, shared by the subscription cards above it and
 * the profile boxes: the person's profiles, what is being dragged or offered,
 * which profile the pointer or the keyboard is on, and the changes, each told
 * to screen readers in one sentence.
 *
 * The server keeps the profiles; every change here is a call, and the boxes
 * redraw from the live list when it lands.
 */
export function createBuilder(client: TokamakClient, subscriptions: () => readonly Subscription[]) {
  const listed = useQuery(client, api.profiles.list, () => ({}));
  const profiles = (): readonly Profile[] => listed.data() ?? [];
  const profileOf = (id: string | undefined) => profiles().find((profile) => profile.id === id);

  /** The profile under the pointer, or holding keyboard focus: the cards outside it dim. */
  const [pointed, setPointed] = createSignal<string>();
  /** The subscription whose card's "Add to profile" menu is open: the keyboard's drag. */
  const [offered, setOffered] = createSignal<string>();
  const [problem, setProblem] = createSignal<string>();
  /**
   * The last change, for the polite live region. The region is emptied first
   * and filled on the next frame, so the same sentence twice is read twice.
   */
  const [said, setSaid] = createSignal("");
  let saying = 0;
  const say = (message: string) => {
    const turn = ++saying;
    setSaid("");
    requestAnimationFrame(() => turn === saying && setSaid(message));
  };
  onCleanup(() => void ++saying);

  const drag = createDrag((carry, over) => void drop(carry, over));

  const nameOf = (id: string) => {
    const subscription = subscriptions().find((item) => item.id === id);
    return subscription ? [titleOf(subscription), subscription.label].filter(Boolean).join(", ") : "It";
  };

  /** The subscription on its way into a profile, by pointer or by its card's menu. */
  const incoming = () => drag.carry()?.subscription ?? offered();

  /** A profile that already holds what is on its way fades and says "added"; a drop there does nothing. */
  const added = (profile: Profile) => {
    const subscription = incoming();
    return (
      subscription !== undefined &&
      drag.carry()?.from !== profile.id &&
      profile.subscriptions.includes(subscription)
    );
  };

  /**
   * A card dims when a profile is pointed at and does not hold it (`undefined`
   * stands for a card with no subscription yet, an awaiting sign-in). While a
   * card is carried, only that card dims: it waits in its place.
   */
  const dimmed = (subscription?: string) => {
    const carry = drag.carry();
    if (carry) return !carry.from && carry.subscription === subscription;
    const profile = profileOf(pointed());
    return !!profile && !(subscription !== undefined && profile.subscriptions.includes(subscription));
  };

  const codesOf = (subscription: string) =>
    profiles()
      .filter((profile) => profile.subscriptions.includes(subscription))
      .map((profile) => profile.code);

  // A row moved or removed from its menu is drawn again, or gone, which takes
  // focus off its menu button. Once the new list has drawn, focus goes back to
  // the row (or to its profile), but only while focus is still lost, and only
  // shortly after the change: a person who has moved on keeps their place.
  let refocus: { selector: string; until: number } | undefined;
  const focusAgain = () => {
    const wanted = refocus;
    if (!wanted) return;
    requestAnimationFrame(() => {
      if (refocus !== wanted) return;
      if (Date.now() > wanted.until) return void (refocus = undefined);
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      const target = document.querySelector<HTMLElement>(wanted.selector);
      if (!target) return;
      refocus = undefined;
      target.focus();
    });
  };
  createEffect(
    () => listed.data(),
    () => focusAgain(),
  );
  onCleanup(() => (refocus = undefined));

  async function run(call: () => Promise<unknown>, done: () => string, focus?: string): Promise<boolean> {
    setProblem(undefined);
    refocus = focus ? { selector: focus, until: Date.now() + 1000 } : undefined;
    try {
      const result = await call();
      if (isFailure(result)) {
        const message =
          (result.data as { message?: string } | undefined)?.message ?? "That change did not save.";
        refocus = undefined;
        setProblem(message);
        say(message);
        return false;
      }
      say(done());
      focusAgain();
      return true;
    } catch {
      // Nothing is drawn ahead of the server, so the list already shows its state.
      refocus = undefined;
      setProblem(UNSAVED);
      say(UNSAVED);
      return false;
    }
  }

  function add(profileId: string, subscription: string, at?: number) {
    const profile = profileOf(profileId);
    if (!profile || profile.subscriptions.includes(subscription)) return Promise.resolve(false);
    const position = Math.min(at ?? profile.subscriptions.length, profile.subscriptions.length);
    return run(
      () => client.mutation(api.profiles.add, { profile: profile.id, subscription, at: position }),
      () => `${nameOf(subscription)} added to ${profile.code} as number ${position + 1}.`,
    );
  }

  function move(profileId: string, subscription: string, to: number) {
    const profile = profileOf(profileId);
    if (!profile) return Promise.resolve(false);
    const last = profile.subscriptions.length - 1;
    const position = Math.min(Math.max(to, 0), last);
    if (profile.subscriptions.indexOf(subscription) === position) return Promise.resolve(false);
    return run(
      () => client.mutation(api.profiles.move, { profile: profile.id, subscription, to: position }),
      () => `${nameOf(subscription)} is now number ${position + 1} in ${profile.code}.`,
      entryMenu(profile.id, subscription),
    );
  }

  function remove(profileId: string, subscription: string) {
    const profile = profileOf(profileId);
    if (!profile) return Promise.resolve(false);
    return run(
      () => client.mutation(api.profiles.remove, { profile: profile.id, subscription }),
      () => `${nameOf(subscription)} removed from ${profile.code}.`,
      `[data-profile="${profile.id}"]`,
    );
  }

  /** What a pointer drop does: put a card in at the drop position, or move a row there. */
  function drop(carry: Carry, over: Over) {
    const profile = profileOf(over.profile);
    if (!profile) return;
    if (carry.from === profile.id) return void move(profile.id, carry.subscription, over.index);
    // Already in this profile ("added"): nothing happens.
    if (profile.subscriptions.includes(carry.subscription)) return;
    void add(profile.id, carry.subscription, over.index);
  }

  /** Makes a profile; a call that throws comes back as a failure the dialog shows, like a refusal. */
  async function create(name: string, code: string) {
    setProblem(undefined);
    try {
      const made = await client.mutation(api.profiles.create, { name, code });
      if (isFailure(made)) say((made.data as { message?: string } | undefined)?.message ?? UNSAVED);
      else say(`Profile ${made.code} made.`);
      return made;
    } catch {
      say(UNSAVED);
      return { failed: true as const, kind: "Unsaved", data: { message: UNSAVED } };
    }
  }

  return {
    profiles,
    error: () => listed.error()?.message,
    pointed,
    setPointed,
    offered,
    setOffered,
    problem,
    said,
    drag,
    added,
    dimmed,
    codesOf,
    nameOf,
    add,
    move,
    remove,
    create,
  };
}

export type Builder = ReturnType<typeof createBuilder>;

/** The selector of a row's menu button, so focus can come back to it after a move (ids hold no quotes). */
export const entryMenu = (profile: string, subscription: string) =>
  `[data-entry-menu="${profile} ${subscription}"]`;
