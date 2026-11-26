import { Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Dialog, Input, icons } from "@tokamak/ui";
import type { Profile } from "../lib/builder";

type Failed = { failed: true; kind: string; data: { message: string; field?: string } };
const failed = (value: unknown): value is Failed =>
  typeof value === "object" && value !== null && (value as { failed?: unknown }).failed === true;

/**
 * "New profile": a name and a code of up to four characters. The code is
 * shown in upper case as it is typed; the server checks that it is the
 * person's only profile with that code and says so if not. Not drawn in
 * Paper: built like the add-subscription dialog.
 */
export function ProfileDialog(props: {
  open: boolean;
  onClose: () => void;
  create: (name: string, code: string) => Promise<Profile | Failed>;
}): JSX.Element {
  const [name, setName] = createSignal("");
  const [code, setCode] = createSignal("");
  const [problem, setProblem] = createSignal<{ field?: string; message: string }>();
  /** Create is off while the call runs, so one press makes one profile. */
  const [saving, setSaving] = createSignal(false);
  const close = () => {
    setName("");
    setCode("");
    setProblem(undefined);
    props.onClose();
  };
  /** A refusal or a failed call keeps the dialog and its fields, and says why. */
  async function submit() {
    if (saving()) return;
    setSaving(true);
    try {
      const made = await props.create(name(), code());
      if (failed(made)) setProblem(made.data);
      else close();
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog.Root open={props.open} onOpenChange={(open: boolean) => !open && close()}>
      <Dialog.Backdrop />
      <Dialog.Content>
        <form
          class="flex flex-col gap-5"
          onSubmit={(event: SubmitEvent) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div class="flex items-center gap-3">
            <Dialog.Title class="flex-1">New profile</Dialog.Title>
            <Dialog.Close variant="ghost" icon={icons.close} label="Close" />
          </div>
          <div class="flex flex-col gap-2">
            <label for="profile-name" class="text-label text-ink-2">
              Name
            </label>
            <Input
              id="profile-name"
              placeholder="Personal"
              value={name()}
              invalid={problem()?.field === "name"}
              aria-describedby="profile-problem"
              onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) =>
                setName(event.currentTarget.value)
              }
            />
          </div>
          <div class="flex flex-col gap-2">
            <label for="profile-code" class="text-label text-ink-2">
              Code
            </label>
            <Input
              id="profile-code"
              mono
              maxlength={4}
              placeholder="PERS"
              autocomplete="off"
              spellcheck={false}
              value={code()}
              invalid={problem()?.field === "code"}
              aria-describedby="profile-code-help profile-problem"
              onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) => {
                const upper = event.currentTarget.value.toUpperCase();
                event.currentTarget.value = upper;
                setCode(upper);
              }}
            />
            <p id="profile-code-help" class="m-0 text-label text-ink-3">
              Up to 4 letters or digits. Threads show it in the picker.
            </p>
          </div>
          <Show when={problem()}>
            {(shown) => (
              <p id="profile-problem" role="alert" class="m-0 text-label text-removed">
                {shown().message}
              </p>
            )}
          </Show>
          <div class="flex justify-end gap-2">
            <Dialog.Close variant="ghost">Cancel</Dialog.Close>
            <Button variant="brand" type="submit" disabled={saving()}>
              Create
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
