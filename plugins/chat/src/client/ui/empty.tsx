import { For, Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isFailure } from "@tokamak/sdk";
import { useClient } from "@tokamak/sdk/client";
import { Button, Dialog, Icon, Row, Textarea } from "@tokamak/ui";
import { api, type Folder } from "../lib/api";
import { folderName, isFullPath } from "../lib/folders";
import { chatIcon, glyphs } from "../lib/icons";
import { errorText } from "../lib/state";

export interface EmptyProps {
  /** Recent folders first, then any folder picked with "Choose a folder…". */
  readonly folders: readonly string[];
  readonly folder: Folder;
  readonly onFolder: (folder: Folder) => void;
}

/**
 * The new thread before its first Send (Paper "Chat · empty thread"): an
 * `icon`, a `heading` other plugins may layer over, and the `folders` to work in.
 * The composer sits below it on the page.
 */
export const Empty = (props: EmptyProps) => (
  <div class="flex w-full max-w-read flex-col items-center gap-8">
    <div class="flex flex-col items-center gap-3">
      <span data-part="icon" class="flex text-ink">
        <Icon path={chatIcon} class="size-6" />
      </span>
      <h2 data-part="heading" class="text-read font-semibold text-ink">
        Start a conversation
      </h2>
    </div>
    <FolderPicker folders={props.folders} folder={props.folder} onFolder={props.onFolder} />
  </div>
);

/**
 * The starting points: recent folders, "Choose a folder…" and "No folder".
 * One is always picked; "No folder" gives the thread an empty folder of its own.
 */
function FolderPicker(props: EmptyProps): JSX.Element {
  const client = useClient();
  const [choosing, setChoosing] = createSignal(false, { ownedWrite: true });
  const [typed, setTyped] = createSignal("", { ownedWrite: true });
  const [problem, setProblem] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const picked = (path: string) => props.folder.kind === "chosen" && props.folder.path === path;
  const valid = () => isFullPath(typed());
  // On the Runner a caller action expands `~` and checks the folder exists;
  // a plain browser stores the path as typed.
  async function choose() {
    if (!valid()) return;
    setProblem(undefined);
    try {
      const path = typed();
      const checked = await client.action(api.folders.check, { path });
      const result = isFailure(checked) && checked.kind === "noMachine" ? path.trim() : checked;
      if (isFailure(result)) {
        setProblem(
          result.kind === "NotAFolder"
            ? `There is no folder at ${result.data.path}.`
            : result.kind === "NotFullPath"
              ? "Use a full path."
              : "The Runner cannot check this folder.",
        );
        return;
      }
      props.onFolder({ kind: "chosen", path: result });
      setChoosing(false);
    } catch (cause) {
      setProblem(errorText(cause));
    }
  }
  return (
    <div role="radiogroup" aria-label="Folder" class="flex w-full max-w-dialog flex-col gap-1 density-normal">
      <For each={props.folders}>
        {(path) => (
          <Choice
            icon={glyphs.folder}
            label={folderName(path)}
            detail={path}
            checked={picked(path)}
            onPick={() => props.onFolder({ kind: "chosen", path })}
          />
        )}
      </For>
      <Choice
        icon={glyphs.add}
        label="Choose a folder…"
        checked={false}
        opensDialog
        onPick={() => {
          setTyped(props.folder.kind === "chosen" ? props.folder.path : "");
          setProblem(undefined);
          setChoosing(true);
        }}
      />
      <Choice
        icon={glyphs.noFolder}
        label="No folder"
        checked={props.folder.kind === "own"}
        onPick={() => props.onFolder({ kind: "own" })}
      />
      <Dialog.Root open={choosing()} onOpenChange={setChoosing}>
        <Dialog.Backdrop />
        <Dialog.Content>
          <Dialog.Title>Choose a folder</Dialog.Title>
          <Dialog.Description>
            The full path of a folder on this computer, such as ~/code/app.
          </Dialog.Description>
          <form
            class="flex flex-col gap-4 pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              void choose();
            }}
          >
            <Textarea
              aria-label="Folder path"
              value={typed()}
              onValueChange={setTyped}
              submitShortcut="enter"
              onSubmit={() => void choose()}
              autofocus
            />
            <Show
              when={
                problem() ?? (typed().trim() && !valid() ? "Use a full path such as ~/code/app." : undefined)
              }
            >
              {(text) => (
                <p role="alert" class="text-row text-ink-2">
                  {text()}
                </p>
              )}
            </Show>
            <div class="flex justify-end gap-2">
              <Dialog.Close>Cancel</Dialog.Close>
              <Button type="submit" variant="primary" disabled={!valid()}>
                Use folder
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}

/** One starting point (Paper "Starting points" row): a normal-density row with a check when picked. */
function Choice(props: {
  icon: string;
  label: string;
  detail?: string;
  checked: boolean;
  /** "Choose a folder…" is a plain button: it opens a dialog rather than picking. */
  opensDialog?: boolean;
  onPick: () => void;
}): JSX.Element {
  // Each starting point sits on its own tray (Paper "Starting points").
  return (
    <div class="rounded-sm surface-tray">
      <Row
        as="button"
        selected={props.checked}
        lead={<Icon path={props.icon} />}
        trail={props.checked ? <Icon path={glyphs.check} /> : undefined}
        role={props.opensDialog ? undefined : "radio"}
        aria-checked={props.opensDialog ? undefined : props.checked ? "true" : "false"}
        aria-haspopup={props.opensDialog ? "dialog" : undefined}
        title={props.detail}
        onClick={() => props.onPick()}
      >
        {props.label}
      </Row>
    </div>
  );
}
