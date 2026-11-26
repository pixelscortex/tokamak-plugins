import { For, Show, createEffect, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isFailure, type Id, type TokamakClient } from "@tokamak/sdk";
import { Region, useClient, usePageTitle, useQuery, useShortcuts, view } from "@tokamak/sdk/client";
import { Button, ScrollArea, StatusIcon, icons } from "@tokamak/ui";
import { api, type Folder } from "../lib/api";
import { createFollow } from "../lib/follow";
import { chatIcon } from "../lib/icons";
import { createSend } from "../lib/send";
import {
  NEW_THREAD,
  chosenFolder,
  draftOf,
  error,
  errorText,
  newFolder,
  openThread,
  setDraft,
} from "../lib/state";
import { Composer, focusComposer } from "../ui/composer";
import { Empty } from "../ui/empty";
import { Message } from "../ui/message";
import { Header } from "../ui/thread-header";
import { ThreadList } from "../ui/thread-list";

export const Chat = view({ route: "/", icon: chatIcon }, () => {
  const client = useClient();
  const shortcuts = useShortcuts();
  const threads = useQuery(client, api.threads.list, () => ({}));
  const current = () => threads.data()?.find((thread) => thread._id === openThread());
  // A thread leaves the screen once it has been listed and then disappears,
  // deleted here or in another window. A thread created a moment ago may not
  // be listed yet, so absence alone does not close it.
  const listed = new Set<string>();
  createEffect(
    () => threads.data(),
    (list) => {
      if (!list) return;
      for (const thread of list) listed.add(thread._id);
      const id = openThread();
      if (id && listed.has(id) && !list.some((thread) => thread._id === id)) openThread.set(undefined);
    },
  );
  usePageTitle(() => current()?.title ?? "New thread");

  function newThread() {
    openThread.set(undefined);
    error.set(undefined);
    focusComposer();
  }
  const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  onCleanup(shortcuts.registerShortcut(apple ? "Meta+n" : "Control+n", newThread));

  return (
    <>
      <Region.Sidebar>
        <ThreadList
          threads={threads.data()}
          current={openThread()}
          onOpen={(id) => {
            openThread.set(id);
            error.set(undefined);
          }}
          onNew={newThread}
        />
      </Region.Sidebar>
      <Region.Header>
        <Show when={current()}>
          {(thread) => (
            <Header
              thread={thread()}
              onRename={(title) =>
                client.mutation(api.threads.rename, { threadId: thread()._id, title }).then(
                  () => {},
                  (cause: unknown) => {
                    error.set(`Rename failed: ${errorText(cause)}`);
                  },
                )
              }
              onDelete={async () => {
                const args = { threadId: thread()._id };
                const deletion = await client.action(api.threads.removeLocal, args);
                if (isFailure(deletion)) {
                  if (deletion.kind !== "noMachine") throw new Error("The Runner cannot delete this thread.");
                  await client.mutation(api.threads.remove, args);
                }
                if (openThread() === args.threadId) openThread.set(undefined);
                if (!isFailure(deletion) && deletion?.warning) error.set(deletion.warning);
              }}
            />
          )}
        </Show>
      </Region.Header>
      <section
        aria-label="Chat"
        data-thread-id={openThread() ?? ""}
        class="flex h-full min-h-0 flex-1 flex-col"
      >
        <Show keyed when={openThread()} fallback={<NewThread client={client} />}>
          {(threadId: Id<"threads">) => (
            <OpenThread client={client} threadId={threadId} folder={current()?.folder} />
          )}
        </Show>
      </section>
    </>
  );
});

/**
 * The new thread: icon, heading, folders and the composer, centred. Nothing is
 * stored until the first Send, which creates the thread and its first message.
 */
function NewThread(props: { client: TokamakClient }): JSX.Element {
  const recent = useQuery(props.client, api.threads.recentFolders, () => ({}));
  const sender = createSend(props.client, {
    draftKey: () => NEW_THREAD,
    async store(text) {
      const started = await props.client.mutation(api.threads.start, { text, folder: newFolder() });
      openThread.set(started.threadId);
      return { ...started, first: true };
    },
  });
  const folders = () => {
    const list = recent.data() ?? [];
    const picked = chosenFolder();
    return picked && !list.includes(picked) ? [picked, ...list] : list;
  };
  function pickFolder(folder: Folder) {
    if (folder.kind === "chosen" && !(recent.data() ?? []).includes(folder.path))
      chosenFolder.set(folder.path);
    newFolder.set(folder);
  }
  return (
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 overflow-y-auto p-12">
      <Empty folders={folders()} folder={newFolder()} onFolder={pickFolder} />
      {/* The same column as an open thread's composer, so it does not change width on the first Send. */}
      <div class="flex w-full max-w-thread flex-col gap-2">
        <ErrorLine />
        <Composer
          threadId={undefined}
          folder={newFolder()}
          draft={draftOf(NEW_THREAD)}
          sending={sender.sending()}
          onDraft={(text) => setDraft(NEW_THREAD, text)}
          onSend={() => void sender.send()}
        />
      </div>
    </div>
  );
}

/** An open thread: its messages, live, above the composer. */
function OpenThread(props: {
  client: TokamakClient;
  threadId: Id<"threads">;
  folder: Folder | undefined;
}): JSX.Element {
  const messages = useQuery(props.client, api.messages.list, () => ({ threadId: props.threadId }));
  const follow = createFollow();
  const sender = createSend(props.client, {
    draftKey: () => props.threadId,
    threadId: () => props.threadId,
    async store(text) {
      const messageId = await props.client.mutation(api.messages.post, { threadId: props.threadId, text });
      follow.jump();
      return { threadId: props.threadId, messageId, first: false };
    },
  });
  let box: HTMLDivElement | undefined;
  let content: HTMLDivElement | undefined;
  const attach = () => box && content && follow.attach(box, content);
  const list = () => messages.data() ?? [];
  // The messages and the composer share one column: the same padding and the
  // same width, centred in the same box (the scrollbar lies over the edge and
  // takes no room), so their edges line up.
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <ScrollArea
        class="min-h-0 flex-1"
        viewportRef={(element) => {
          box = element;
          queueMicrotask(attach);
        }}
      >
        <div class="flex flex-1 flex-col items-center px-8">
          <div
            ref={(element) => (content = element)}
            role="log"
            aria-label="Conversation"
            class="mt-auto flex w-full max-w-thread flex-col pt-6 pb-6"
          >
            <For each={list()} keyed={(row) => row._id}>
              {(row, index) => (
                <Message
                  message={row()}
                  threadId={props.threadId}
                  next={list()[index() + 1]}
                  isLast={index() === list().length - 1}
                />
              )}
            </For>
          </div>
        </div>
      </ScrollArea>
      <div class="flex shrink-0 justify-center px-8 pb-4">
        <div class="flex w-full max-w-thread flex-col gap-2">
          <ErrorLine extra={messages.error()?.message} />
          <Composer
            threadId={props.threadId}
            folder={props.folder}
            draft={draftOf(props.threadId)}
            sending={sender.sending()}
            onDraft={(text) => setDraft(props.threadId, text)}
            onSend={(intent) => void sender.send(intent)}
          />
        </div>
      </div>
    </div>
  );
}

function ErrorLine(props: { extra?: string }): JSX.Element {
  return (
    <Show when={error() ?? props.extra}>
      {(text) => (
        <div role="alert" class="flex items-center gap-2 ps-1 text-row text-ink-2">
          <StatusIcon status="failed" />
          <span class="min-w-0 flex-1 break-words">{text()}</span>
          <Button variant="ghost" icon={icons.close} label="Dismiss" onClick={() => error.set(undefined)} />
        </div>
      )}
    </Show>
  );
}
