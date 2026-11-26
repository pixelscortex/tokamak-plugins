import { Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Chip, Dialog, Icon, Menu } from "@tokamak/ui";
import type { Thread } from "../lib/api";
import { folderName } from "../lib/folders";
import { glyphs } from "../lib/icons";
import { errorText } from "../lib/state";

export interface HeaderProps {
  readonly thread: Thread;
  readonly onRename: (title: string) => Promise<void>;
  readonly onDelete: () => Promise<void>;
}

/**
 * The thread's page header (Paper "Chat v7", page header): the `title`
 * (double-click renames), its `folder`, and the `menu` with Rename and Delete.
 * Others add after the title (a branch chip) or before the menu (a panel toggle).
 */
export const Header = (props: HeaderProps) => {
  const [renaming, setRenaming] = createSignal(false, { ownedWrite: true });
  const [deleting, setDeleting] = createSignal(false, { ownedWrite: true });
  const [busy, setBusy] = createSignal(false, { ownedWrite: true });
  const [failure, setFailure] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  async function rename(title: string) {
    setRenaming(false);
    const value = title.trim();
    if (value && value !== props.thread.title) await props.onRename(value);
  }
  async function remove() {
    setBusy(true);
    setFailure(undefined);
    try {
      await props.onDelete();
      setDeleting(false);
    } catch (cause) {
      setFailure(`Couldn't delete this thread: ${errorText(cause)}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="flex min-w-0 flex-1 items-center gap-2">
      <Icon path={glyphs.thread} class="text-ink" />
      <div data-part="title" class="flex min-w-0 items-center">
        <Show
          when={renaming()}
          fallback={
            <h1
              class="min-w-0 cursor-default truncate text-row font-medium text-ink"
              title="Double-click to rename"
              onDblClick={() => setRenaming(true)}
            >
              {props.thread.title}
            </h1>
          }
        >
          <TitleInput title={props.thread.title} onDone={(title) => void rename(title)} />
        </Show>
      </div>
      <FolderChip path={props.thread.folder?.path} />
      <span class="flex-1" />
      <ThreadMenu onRename={() => setRenaming(true)} onDelete={() => setDeleting(true)} />
      <DeleteDialog
        title={props.thread.title}
        open={deleting()}
        busy={busy()}
        failure={failure()}
        onOpenChange={(open) => {
          if (busy()) return;
          setDeleting(open);
          setFailure(undefined);
        }}
        onDelete={() => void remove()}
      />
    </div>
  );
};

/**
 * The thread's folder by name, as a chip like the branch beside it (Paper's
 * header chips: 32 tall, a 14 px mark, the name in mono); the full path is
 * its label.
 */
function FolderChip(props: { path: string | undefined }): JSX.Element {
  return (
    <Show when={props.path}>
      {(path) => (
        <Chip mono icon={glyphs.folder} label={`Folder ${path()}`} class="shrink-0">
          {folderName(path())}
        </Chip>
      )}
    </Show>
  );
}

/** `⋯`: Rename and Delete thread. */
function ThreadMenu(props: { onRename: () => void; onDelete: () => void }): JSX.Element {
  return (
    <Menu.Root onAction={(value) => (value === "rename" ? props.onRename() : props.onDelete())}>
      <Menu.Trigger variant="ghost" icon={glyphs.more} label="Thread actions" />
      <Menu.Content>
        <Menu.Item value="rename">
          <Icon path={glyphs.edit} class="text-ink-2" />
          Rename
        </Menu.Item>
        <Menu.Separator />
        <Menu.Item value="delete" destructive>
          <Icon path={glyphs.delete} />
          Delete thread
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

/** Asks before a thread and its messages are deleted, and says so if deleting fails. */
function DeleteDialog(props: {
  title: string;
  open: boolean;
  busy: boolean;
  failure: string | undefined;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Backdrop />
      <Dialog.Content>
        <Dialog.Title>Delete “{props.title}”?</Dialog.Title>
        <Dialog.Description>Its messages are deleted too. This cannot be undone.</Dialog.Description>
        <Show when={props.failure}>
          {(text) => (
            <p role="alert" class="text-row text-ink-2">
              {text()}
            </p>
          )}
        </Show>
        <div class="flex justify-end gap-2">
          <Dialog.Close disabled={props.busy}>Cancel</Dialog.Close>
          <Button variant="destructive" disabled={props.busy} onClick={() => props.onDelete()}>
            Delete
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** The title in place, selected: Enter or leaving saves, Escape keeps the old title. */
function TitleInput(props: { title: string; onDone: (title: string) => void }): JSX.Element {
  let done = false;
  const finish = (title: string) => {
    if (done) return;
    done = true;
    props.onDone(title);
  };
  return (
    <input
      aria-label="Thread title"
      value={props.title}
      maxlength={200}
      ref={(element) => {
        requestAnimationFrame(() => {
          element.focus();
          element.select();
        });
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(event.currentTarget.value);
        else if (event.key === "Escape") finish(props.title);
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
      class="h-8 min-w-0 rounded-xs bg-card px-2 text-row font-medium text-ink outline-none focus-ring"
    />
  );
}
