import { For, Match, Show, Switch as Choose, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Chip, Dialog, Icon, Input, Row, icons } from "@tokamak/ui";
import type { Company, SignIn, Subscription } from "../lib/api";
import { COMPANIES, pasteExample, wordsOf } from "../lib/companies";
import { hasDesktopSignIn, openSignInBrowser } from "../lib/desktop";
import { ENDING } from "../lib/sign-in-watch";
import { countOf, modelName, titleOf } from "../lib/format";
import { glyphs, profilesIcon } from "../lib/icons";
import { CompanyMark, markPath } from "./company-mark";

/**
 * Adding a subscription (Paper "2a" to "2d"): company, then method, then
 * sign-in, then connected. Closing the dialog at any step stops nothing: a
 * sign-in keeps waiting, and the screen shows it as an "Awaiting sign-in" card
 * that opens this dialog at its sign-in step again; the Profiles page watches
 * for returns while a sign-in waits, even when the dialog is closed. Every
 * company goes through the same steps; only its words (`lib/companies.ts`)
 * differ.
 */
export type Step =
  | { kind: "company" }
  | { kind: "method"; company: Company }
  | { kind: "sign-in"; signIn: SignIn }
  | { kind: "connected"; subscription: Subscription };

type Failed = { failed: true; kind: string; data: { message: string } };
const failed = (value: unknown): value is Failed =>
  typeof value === "object" && value !== null && (value as { failed?: unknown }).failed === true;

export interface AddDialogProps {
  step: Step | undefined;
  onStep: (step: Step | undefined) => void;
  /** Starts a sign-in; `repair` signs that subscription in again instead of adding one. */
  start: (company: Company, repair?: string) => Promise<SignIn | Failed>;
  finish: (signIn: SignIn, pasted: string) => Promise<Subscription | Failed>;
  listening: (id: string) => boolean;
  returned: (id: string) => { address: string; problem?: string } | undefined;
  setLabel: (subscription: Subscription, label: string) => Promise<null | Failed>;
  /** Copies text to the clipboard; the window's own clipboard by default. */
  copy?: (text: string) => Promise<void>;
}

const STEPS = { company: 1, method: 2, "sign-in": 3, connected: 4 } as const;

export function AddDialog(props: AddDialogProps): JSX.Element {
  return (
    <Dialog.Root
      open={props.step !== undefined}
      onOpenChange={(open: boolean) => !open && props.onStep(undefined)}
    >
      <Dialog.Backdrop />
      <Dialog.Content>
        <Show when={props.step}>
          {(step) => (
            <div class="flex flex-col gap-5">
              <Choose>
                <Match when={step().kind === "company"}>
                  <CompanyStep onPick={(company) => props.onStep({ kind: "method", company })} />
                </Match>
                <Match
                  when={step().kind === "method" && (step() as Extract<Step, { kind: "method" }>).company}
                >
                  {(company) => (
                    <MethodStep
                      company={company()}
                      start={async () => {
                        const started = await props.start(company());
                        if (!failed(started)) props.onStep({ kind: "sign-in", signIn: started });
                        return started;
                      }}
                      onBack={() => props.onStep({ kind: "company" })}
                    />
                  )}
                </Match>
                <Match
                  when={step().kind === "sign-in" && (step() as Extract<Step, { kind: "sign-in" }>).signIn}
                >
                  {(signIn) => (
                    <SignInStep
                      signIn={signIn()}
                      copy={props.copy}
                      listening={props.listening(signIn().id)}
                      returned={props.returned(signIn().id)}
                      finish={async (pasted) => {
                        const current = signIn();
                        const added = await props.finish(current, pasted);
                        if (
                          !failed(added) &&
                          props.step?.kind === "sign-in" &&
                          props.step.signIn.id === current.id
                        )
                          props.onStep({ kind: "connected", subscription: added });
                        return added;
                      }}
                      restart={async () => {
                        const started = await props.start(signIn().company, signIn().repair);
                        if (!failed(started)) props.onStep({ kind: "sign-in", signIn: started });
                        return started;
                      }}
                    />
                  )}
                </Match>
                <Match
                  when={
                    step().kind === "connected" &&
                    (step() as Extract<Step, { kind: "connected" }>).subscription
                  }
                >
                  {(subscription) => (
                    <ConnectedStep
                      subscription={subscription()}
                      done={async (label) => {
                        const saved = await props.setLabel(subscription(), label);
                        if (!failed(saved)) props.onStep(undefined);
                        return saved;
                      }}
                    />
                  )}
                </Match>
              </Choose>
            </div>
          )}
        </Show>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** The dialog's top line: how far along it is, the company's mark, the title, close. */
function Header(props: { step: keyof typeof STEPS; mark?: Company; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex items-center gap-3">
      <div class="flex gap-1" role="img" aria-label={`Step ${STEPS[props.step]} of 4`}>
        <For each={[1, 2, 3, 4]}>
          {(n) => <span class={["h-1 w-6 rounded-full", n <= STEPS[props.step] ? "bg-ink" : "bg-edge"]} />}
        </For>
      </div>
      <Show when={props.mark}>{(company) => <CompanyMark company={company()} size={18} />}</Show>
      <Dialog.Title class="flex-1">{props.children}</Dialog.Title>
      <Dialog.Close variant="ghost" icon={icons.close} label="Close" />
    </div>
  );
}

function Problem(props: { message: string | undefined }): JSX.Element {
  return (
    <Show when={props.message}>
      <p role="alert" class="m-0 text-label text-removed">
        {props.message}
      </p>
    </Show>
  );
}

function CompanyStep(props: { onPick: (company: Company) => void }): JSX.Element {
  return (
    <>
      <Header step="company">Add subscription</Header>
      <div class="flex flex-col density-normal">
        <For each={COMPANIES}>
          {(company) => (
            <Row
              as="button"
              lead={<CompanyMark company={company} size={16} />}
              trail={<Icon path={glyphs.next} size={14} />}
              onClick={() => props.onPick(company)}
            >
              {wordsOf[company].name}
            </Row>
          )}
        </For>
        <div role="separator" class="mx-1 my-1 h-px bg-edge" />
        <div class="opacity-50">
          <Row lead={<span />}>More later</Row>
        </div>
      </div>
    </>
  );
}

function MethodStep(props: {
  company: Company;
  start: () => Promise<unknown>;
  onBack: () => void;
}): JSX.Element {
  const words = () => wordsOf[props.company];
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  async function choose() {
    if (busy()) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const started = await props.start();
      if (failed(started)) setProblem(started.data.message);
    } catch {
      setProblem("The sign-in could not start. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Header step="method" mark={props.company}>
        {words().name}
      </Header>
      <div class="flex flex-col gap-1">
        <div class="rounded-md p-1">
          <Row
            as="button"
            kind="double"
            aria-busy={busy() ? "true" : undefined}
            lead={<Icon path={profilesIcon} />}
            trail={<Icon path={glyphs.next} size={14} />}
            detail={words().plans}
            onClick={() => void choose()}
          >
            {words().method}
          </Row>
        </div>
        {/* Shown so it is not missed, and marked as coming later. */}
        <div class="rounded-md p-1 opacity-50 inset-ring inset-ring-edge" aria-disabled="true">
          <Row kind="double" lead={<Icon path={glyphs.key} />} trail="Later" detail={words().keys}>
            API key
          </Row>
        </div>
      </div>
      <Problem message={problem()} />
      <div class="flex">
        <Button variant="ghost" icon={glyphs.back} onClick={() => props.onBack()}>
          Back
        </Button>
      </div>
    </>
  );
}

function SignInStep(props: {
  signIn: SignIn;
  listening: boolean;
  returned: { address: string; problem?: string } | undefined;
  finish: (pasted: string) => Promise<unknown>;
  restart: () => Promise<unknown>;
  copy?: (text: string) => Promise<void>;
}): JSX.Element {
  const [pasted, setPasted] = createSignal("");
  const [problem, setProblem] = createSignal<string>();
  const [ended, setEnded] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const expired = () => props.signIn.expired;
  const desktop = hasDesktopSignIn();
  onCleanup(() => clearTimeout(copiedTimer));

  async function copyLink() {
    await (props.copy ?? ((text: string) => navigator.clipboard.writeText(text)))(props.signIn.link);
    setCopied(true);
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => setCopied(false), 2_000);
  }
  // One finish at a time: the server would answer a second one "already finishing" anyway.
  async function submit(address: string) {
    if (submitting() || !address.trim()) return;
    setSubmitting(true);
    setProblem(undefined);
    try {
      const result = await props.finish(address);
      if (failed(result)) {
        setProblem(result.data.message);
        setEnded(ENDING.includes(result.kind));
      }
    } catch {
      setProblem("The sign-in could not finish. Try again.");
    } finally {
      setSubmitting(false);
    }
  }
  createEffect(
    () => props.returned?.address,
    (address) => {
      if (address) setPasted(address);
    },
  );

  async function openBrowser() {
    try {
      await openSignInBrowser(props.signIn.link);
    } catch {
      setProblem("The browser could not open. Copy the link to open it yourself.");
    }
  }
  async function restart() {
    setProblem(undefined);
    try {
      const started = await props.restart();
      if (failed(started)) setProblem(started.data.message);
      else setEnded(false);
    } catch {
      setProblem("The sign-in could not start. Try again.");
    }
  }
  return (
    <>
      <Header step="sign-in" mark={props.signIn.company}>
        {wordsOf[props.signIn.company].signIn}
      </Header>
      <Show
        when={!ended() && !expired()}
        fallback={
          <div class="flex flex-col items-start gap-3">
            <Problem message={problem() ?? "This sign-in expired after 15 minutes. Start again."} />
            {/* The Button stays pending until the promise settles, so it cannot start twice. */}
            <Button variant="brand" onClick={() => restart()}>
              Start again
            </Button>
          </div>
        }
      >
        <div class="flex items-center gap-1 pt-1">
          <Button
            variant="brand"
            icon={glyphs.external}
            onClick={desktop ? openBrowser : undefined}
            render={
              desktop
                ? undefined
                : (attrs: Record<string, unknown>) => (
                    <a {...attrs} href={props.signIn.link} target="_blank" rel="noopener noreferrer" />
                  )
            }
          >
            Open sign-in page
          </Button>
          <span class="ps-2 text-label text-ink-3">or</span>
          <Button variant="ghost" icon={copied() ? icons.check : glyphs.copy} onClick={() => copyLink()}>
            {copied() ? "Copied" : "Copy link"}
          </Button>
        </div>
        {/* The desktop app listens for the browser's return and finishes by itself; a plain
            browser, or a listener that is busy or unavailable, needs the address pasted. */}
        <p id="sign-in-help" class="m-0 flex items-start gap-2 text-label text-ink-2">
          <Show when={props.listening}>
            {/* One label line tall, so the icon sits on the first line of the text. */}
            <span class="flex h-4 shrink-0 items-center text-ink-3">
              <Icon path={icons.running} size={12} />
            </span>
          </Show>
          {props.listening
            ? "Sign in in your browser. Tokamak finishes by itself when you are done."
            : "Sign in in your browser. It ends on a page that may not load. Copy its whole address and paste it here."}
        </p>
        <form
          class="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(pasted());
          }}
        >
          <Show when={props.listening}>
            <p id="paste-help" class="m-0 text-label text-ink-3">
              Signing in on another device, or it did not finish? The browser ends on a page that may not
              load. Copy its whole address and paste it here.
            </p>
          </Show>
          <div class="flex items-center gap-2">
            <Input
              mono
              class="flex-1"
              aria-label="Address the sign-in ended on"
              aria-describedby={props.listening ? "paste-help" : "sign-in-help"}
              placeholder={pasteExample(props.signIn.company)}
              invalid={Boolean(problem() ?? props.returned?.problem)}
              value={pasted()}
              onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) =>
                setPasted(event.currentTarget.value)
              }
            />
            <Button
              size="sm"
              variant="ghost"
              type="submit"
              disabled={!pasted().trim() || submitting()}
              aria-busy={submitting() ? "true" : undefined}
            >
              Continue
            </Button>
          </div>
          <Problem message={problem() ?? props.returned?.problem} />
        </form>
      </Show>
    </>
  );
}

function ConnectedStep(props: {
  subscription: Subscription;
  done: (label: string) => Promise<unknown>;
}): JSX.Element {
  // The field starts from the stored label once; what the person types is theirs from then on.
  const [label, setLabel] = createSignal(untrack(() => props.subscription.label));
  const [problem, setProblem] = createSignal<string>();
  const email = () => props.subscription.accounts.find((account) => account.email)?.email;
  async function save() {
    setProblem(undefined);
    const saved = await props.done(label());
    if (failed(saved)) setProblem(saved.data.message);
  }
  return (
    <>
      <Header step="connected">Connected</Header>
      <div class="flex items-center gap-3 rounded-md p-4 surface-tray">
        <CompanyMark company={props.subscription.company} size={24} />
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-row font-medium text-ink">{titleOf(props.subscription)}</span>
          <Show when={email()}>
            <span class="truncate text-data text-ink-2">{email()}</span>
          </Show>
        </div>
        <Icon path={icons.done} class="text-ink-3" />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-data text-ink-3">{countOf(props.subscription.models.length, "model")} found</span>
        <ul aria-label="Models" class="m-0 flex list-none flex-wrap gap-2 p-0">
          <For each={props.subscription.models}>
            {(model) => (
              <li>
                <Chip size="sm" icon={markPath(props.subscription.company)}>
                  {modelName(model.name)}
                </Chip>
              </li>
            )}
          </For>
        </ul>
      </div>
      <form
        class="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div class="flex flex-col gap-2">
          <label for="subscription-label" class="text-label text-ink-3">
            Label
          </label>
          <Input
            id="subscription-label"
            size="lg"
            placeholder="Personal"
            value={label()}
            invalid={Boolean(problem())}
            onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) =>
              setLabel(event.currentTarget.value)
            }
          />
          <Problem message={problem()} />
        </div>
        <div class="flex justify-end">
          <Button variant="brand" type="submit">
            Done
          </Button>
        </div>
      </form>
    </>
  );
}
