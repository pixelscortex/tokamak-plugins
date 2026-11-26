import { For, Show, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isFailure, type Id } from "@tokamak/sdk";
import { useClient, useQuery } from "@tokamak/sdk/client";
import { Chip, Icon, Menu } from "@tokamak/ui";
import { holdSend, type ThreadRowProps } from "plugin:chat/client";
import { SavedAgentDetail } from "plugin:ai/client";
import { api } from "../lib/api";
import { profileGlyph } from "../lib/profile-icons";
import { CompanyMark, loadMarks } from "./company-mark";

type PickerProps = { threadId: string | undefined };

const argsFor = (threadId: string | undefined) =>
  threadId === undefined ? {} : { thread: threadId as Id<"chat.threads"> };

function pickerProfiles(props: PickerProps) {
  const client = useClient();
  const profiles = useQuery(client, api.profiles.list, () => ({}));
  const selection = useQuery(client, api["thread-profiles"].selection, () => argsFor(props.threadId));
  return { client, profiles, selection };
}

function ProfileCode(props: { code?: string }): JSX.Element {
  return (
    <Chip size="sm" tone={props.code ? "neutral" : "warn"} icon={profileGlyph}>
      {props.code ?? "Profile"}
    </Chip>
  );
}

export function PickerProfileChip(
  props: PickerProps & {
    refreshCatalog: () => void;
    resetCatalog: () => void;
  },
): JSX.Element {
  const { profiles, selection } = pickerProfiles(props);
  onCleanup(() => queueMicrotask(untrack(() => props.resetCatalog)));
  createEffect(
    () => {
      const picked = selection.data();
      return picked ? `${picked.id}:${JSON.stringify(picked.agents)}` : undefined;
    },
    (current, previous) => {
      if (current !== undefined || previous !== undefined) untrack(props.refreshCatalog);
    },
  );

  return (
    <Show when={(profiles.data()?.length ?? 0) > 0}>
      <span class="ms-2 inline-flex align-middle">
        <ProfileCode code={selection.data()?.code} />
      </span>
    </Show>
  );
}

export function PickerProfileStatus(props: PickerProps): JSX.Element {
  const { profiles, selection } = pickerProfiles(props);
  const needed = () => (profiles.data()?.length ?? 0) > 0 && !selection.data();
  onCleanup(
    holdSend(
      (composer) =>
        composer.threadId === props.threadId && (profiles.loading() || selection.loading() || needed()),
    ),
  );
  return (
    <Show when={needed() && !selection.loading()}>
      <span role="status" class="me-2 text-label text-warn">
        Pick a profile to send.
      </span>
    </Show>
  );
}

export function PickerProfileColumn(props: PickerProps): JSX.Element {
  const { client, profiles, selection } = pickerProfiles(props);
  const subscriptions = useQuery(client, api.subscriptions.list, () => ({}));
  const companyOf = (ids: readonly string[]) => {
    const listed = subscriptions.data()?.subscriptions ?? [];
    return ids.map((id) => listed.find((subscription) => subscription.id === id)?.company).find(Boolean);
  };
  createEffect(
    () => (profiles.data()?.length ?? 0) > 0,
    (hasProfiles) => {
      if (hasProfiles) loadMarks(client);
    },
  );
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string>();
  async function pick(profile: string) {
    if (saving()) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await client.mutation(api["thread-profiles"].pick, {
        ...argsFor(props.threadId),
        profile,
      });
      if (isFailure(result)) setError(result.data.message);
    } catch {
      setError("Could not pick that profile.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Show when={(profiles.data()?.length ?? 0) > 0}>
      <Menu.RadioGroup
        name="Profile"
        aria-label="Profile"
        value={selection.data()?.id ?? null}
        onValueChange={(profile) => void pick(profile)}
        class="flex min-w-16 shrink-0 flex-col"
      >
        <div class="px-2 pt-2 pb-1 text-label text-ink-3 select-none">Profile</div>
        <For each={profiles.data() ?? []} keyed={(profile) => profile.id}>
          {(profile) => (
            <Menu.RadioItem value={profile().id} disabled={saving()} title={profile().name}>
              <Show
                when={companyOf(profile().subscriptions)}
                fallback={<Icon path={profileGlyph} size={14} class="text-ink-3" />}
              >
                {(company) => <CompanyMark company={company()} size={14} class="text-ink-3" />}
              </Show>
              <span class="text-data">{profile().code}</span>
            </Menu.RadioItem>
          )}
        </For>
        <Show when={error()}>
          {(line) => (
            <span role="alert" class="px-2 text-label text-removed">
              {line()}
            </span>
          )}
        </Show>
      </Menu.RadioGroup>
    </Show>
  );
}

function threadPick(props: ThreadRowProps) {
  return useQuery(useClient(), api["thread-profiles"].selection, () => argsFor(props.thread._id));
}

export function ThreadProfile(props: ThreadRowProps): JSX.Element {
  const selection = threadPick(props);
  return <Show when={selection.data()}>{(picked) => <ProfileCode code={picked().code} />}</Show>;
}

export function IdleThreadProfile(props: ThreadRowProps): JSX.Element {
  const selection = threadPick(props);
  return (
    <Show when={selection.data()}>
      {(picked) => (
        <>
          <SavedAgentDetail {...props} />
          <ProfileCode code={picked().code} />
        </>
      )}
    </Show>
  );
}
