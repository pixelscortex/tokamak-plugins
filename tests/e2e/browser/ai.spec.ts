import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { createApi, type FunctionReference } from "../../../node_modules/@tokamak/sdk/src/index";
import type { TurnView } from "../../../plugins/ai/src/server/_functions";
import { connect } from "../../fake-agent/harness.mjs";
import { agentChip, expectAgentOptions, pickAgentOption } from "./agent-picker";
import { asDesktop } from "./desktop";

// ai on top of chat. A plain browser has no local part, so no agent can run
// there; a desktop page runs the real local part and the fake agent (tests/fake-agent).

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const conversation = (page: Page) => page.getByRole("log", { name: "Conversation" });
const agentRow = (page: Page) => page.getByRole("group", { name: "Agent" });
const threads = (page: Page) => page.getByRole("listbox", { name: "Threads" }).getByRole("option");
const replyOf = (page: Page) => conversation(page).getByRole("article", { name: /^Fake agent at / });

// The test calls public server functions without importing the plugins' implementations.
const ai = createApi<{
  turns: {
    active: FunctionReference<"query", { threadId: string }, TurnView | null>;
    list: FunctionReference<"query", { threadId: string }, TurnView[]>;
  };
}>("ai", ["turns:active", "turns:list"]);

/** Picks one of the fake agent's replays (each replay is a model) in the agent picker. */
async function pickReplay(page: Page, replay: string) {
  await pickAgentOption(page, "Fake agent", replay);
  await expect(agentChip(page)).toHaveAccessibleName(`Agent: Fake agent · ${replay}`);
}

/** Chooses a fresh folder under the desktop's home for the new thread; returns its path. */
async function chooseFolder(page: Page, home: string) {
  const folder = join(home, `project-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(folder);
  await page.getByRole("button", { name: "Choose a folder…" }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(folder);
  await page.getByRole("button", { name: "Use folder" }).click();
  return folder;
}

test("without an agent the row is empty and the empty thread says Start a conversation", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/p\/chat$/);
  await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
  await expect(composer(page)).toBeVisible();
  await expect(agentRow(page)).toHaveCount(0);
});

test("the agent row names the agent and Send streams its reply into the thread", async ({ browser }) => {
  const context = await browser.newContext();
  const { home } = await asDesktop(context);
  const page = await context.newPage();
  await page.goto("/");
  // Pick the agent and the replay by name: other fake agents and replays may be installed too.
  await pickAgentOption(page, "Fake agent", "echo");
  await expect(page.getByRole("heading", { name: "What should Fake agent work on?" })).toBeVisible();
  await expect(agentChip(page)).toHaveAccessibleName("Agent: Fake agent · echo");

  const folder = join(home, `project-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(folder);
  await page.getByRole("button", { name: "Choose a folder…" }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(folder);
  await page.getByRole("button", { name: "Use folder" }).click();

  const text = `Add a CSV export ${crypto.randomUUID().slice(0, 8)}`;
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(conversation(page).getByText(text, { exact: true })).toBeVisible();
  // The replay holds after its first words until the test lets it go on: the reply is streaming.
  const reply = conversation(page).getByRole("article", { name: /^Fake agent at / });
  await expect(reply).toContainText("Reading your message.");
  await expect(reply).not.toContainText("You wrote:");
  await writeFile(join(folder, "go"), "");
  await expect(reply).toContainText(`Reading your message. You wrote: ${text}`);
  await context.close();
});

/**
 * Everything ai draws in a reply, from the rows it stored, both while the
 * turn runs and after (replay `work` in tests/fake-agent): the header, thinking,
 * the actions line, a helper, Tasks, the plan and usage.
 */
async function expectFinishedReply(page: Page) {
  const reply = replyOf(page);
  // The header is the agent's mark (named for screen readers) and the model, nothing else.
  const from = reply.getByRole("group", { name: "Reply from" });
  await expect(from).toHaveText(/^\s*work\s*$/);
  await expect(from.getByRole("img", { name: "Fake agent" })).toBeVisible();
  await expect(reply.locator("time")).toHaveCount(0);
  const line = reply.getByRole("button", { name: /^Worked\s*5 actions/ });
  await expect(line).toBeVisible();
  await expect(line).toHaveText(/5 actions\s*\d+(\.\d)?s/);
  const steps = reply.getByRole("list", { name: "Actions" }).getByRole("listitem");
  await expect(steps).toHaveText([
    /src\/auth\/session\.ts\s*\d+\.\ds/,
    /refresh\(\s*4$/,
    /src\/auth\/session\.ts\s*\+6 −2$/,
    /pnpm test auth\s*\d+(\.\d)?s$/,
    /linear\.get_issue\s*\d+(\.\d)?s$/,
  ]);
  await reply.getByRole("button", { name: "Thinking" }).click();
  await expect(reply).toContainText(
    "The session test fails since the refresh change. The cached token is the suspect.",
  );
  await reply.getByRole("button", { name: /^Explore\s*Find where the token is cached/ }).click();
  await expect(reply).toContainText("Session.current keeps the token from before refresh().");
  const tasks = reply.getByRole("region", { name: "Tasks" });
  await expect(tasks).toContainText("2 / 3");
  await expect(tasks.getByRole("listitem")).toHaveText([
    "Refresh the cached token with the session",
    "Run the auth tests",
    "Push the branch and open a PR",
  ]);
  await expect(reply.getByRole("region", { name: "Plan" })).toContainText(
    "1. Refresh the cached token together with the session.",
  );
  await expect(reply.getByLabel("Usage")).toHaveText("12.4k in · 1.1k out · $0.04");
  await expect(reply).toContainText("The cache outlived the token. I fixed the cache, not the test.");
}

test("a reply shows its work folded into one actions line, with thinking, a helper, tasks, the plan and usage", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const { home } = await asDesktop(context);
  const page = await context.newPage();
  await page.goto("/");
  await pickReplay(page, "work");
  const folder = await chooseFolder(page, home);
  const text = `Fix the session test ${crypto.randomUUID().slice(0, 8)}`;
  await composer(page).fill(text);
  await composer(page).press("Enter");

  // While the agent runs its command, the closed line shows that step and its clock.
  const reply = replyOf(page);
  const running = reply.getByRole("button", { name: /Running pnpm test auth/ });
  await expect(running).toHaveText(/^\s*Running pnpm test auth\s*0:0\d\s*$/);
  await running.click();
  const actions = reply.getByRole("list", { name: "Actions" });
  await expect(actions).toBeVisible();
  await writeFile(join(folder, "go"), "");
  await expect(reply.getByRole("button", { name: /^Worked\s*5 actions/ })).toBeVisible();
  await expect(actions).toBeVisible();
  // The commands are steps of the one reply, never messages of their own.
  await expect(conversation(page).getByRole("article")).toHaveCount(2);
  await expectFinishedReply(page);

  // A second window reads the same reply from the database.
  const second = await context.newPage();
  await second.goto("/");
  await threads(second).filter({ hasText: text }).click();
  await replyOf(second)
    .getByRole("button", { name: /^Worked\s*5 actions/ })
    .click();
  await expectFinishedReply(second);
  await context.close();
});

test("a thread with 150 agent replies loads and keeps updating", async ({ browser, browserName }) => {
  // The point is the window's subscriptions (one live query per thread, not one per reply),
  // which do not depend on the engine; one browser keeps the suite's time down.
  test.skip(browserName !== "chromium", "runs once");
  test.setTimeout(300_000);
  const context = await browser.newContext();
  try {
    const { home } = await asDesktop(context);
    const page = await context.newPage();
    await page.goto("/");
    await pickReplay(page, "quick");
    await chooseFolder(page, home);
    const working = conversation(page).getByRole("button", { name: /Working|Running/ });
    const send = async (text: string) => {
      await composer(page).fill(text);
      await composer(page).press("Enter");
      await expect(conversation(page).getByText(`Done: ${text}`, { exact: true })).toBeVisible();
      // The turn has ended: the next Send would otherwise find the thread busy.
      await expect(working).toHaveCount(0);
    };
    for (let n = 1; n <= 150; n += 1) await send(`Message ${n}`);

    // Reopened in a second window: every reply chat shows (its latest 200 messages) draws its turn.
    const second = await context.newPage();
    await second.goto("/");
    await threads(second).filter({ hasText: "Message 1" }).first().click();
    const replies = replyOf(second);
    await expect(replies).toHaveCount(100);
    await expect(replies.first().getByRole("group", { name: "Reply from" })).toHaveText(/^\s*quick\s*$/);
    await expect(replies.first().getByRole("button", { name: /^Worked\s*1 action/ })).toBeVisible();
    await expect(replies.last()).toContainText("Done: Message 150");

    // And it keeps updating: a new turn in the first window shows up in the second, drawn.
    await send("Message 151");
    await expect(replies.last()).toContainText("Done: Message 151");
    await expect(replies.last().getByRole("button", { name: /^Worked\s*1 action/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Enter steers, Cmd+Enter queues in order, and Escape stops", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await asDesktop(context);
    const page = await context.newPage();
    await page.goto("/");
    const selectReplay = async (name: string) => {
      // Resolves once checked: the next Send and Queue read the stored choice from the server.
      await pickAgentOption(page, "Fake agent", name);
      await expect(agentChip(page)).toHaveAccessibleName(`Agent: Fake agent · ${name}`);
    };
    const send = async (text: string, key = "Enter") => {
      await composer(page).fill(text);
      await composer(page).press(key);
      await expect(composer(page)).toHaveValue("");
    };

    await selectReplay("steer");
    await send("Start here");
    await expect(conversation(page)).toContainText("Ready for steering.");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(agentRow(page)).toContainText("esc to stop");

    await selectReplay("stop");
    await send("Second turn", "Meta+Enter");
    await send("Third turn", "Meta+Enter");
    const queued = conversation(page).getByRole("article").filter({ hasText: "Queued" });
    await expect(queued).toHaveCount(2);
    await expect(queued.nth(0)).toContainText("Second turn");
    await expect(queued.nth(1)).toContainText("Third turn");
    await expect(queued.nth(0).locator("[data-part=body]")).toHaveCSS("border-top-style", "dashed");

    await send("Take the other route");
    await expect(conversation(page)).toContainText("Steered: Take the other route");
    const reply = conversation(page).getByRole("article", { name: /^Fake agent at / });
    const steers = reply.getByRole("group", { name: /^Steer from / });
    await expect(steers).toHaveText([/^Steer.+Take the other route$/]);
    // The steer sits where it was sent: after the text before it, before the agent's answer to it.
    const pieces = reply.locator("[data-part=body] > *");
    await expect(pieces).toHaveText([
      "Ready for steering.",
      /^Steer.+Take the other route$/,
      "Steered: Take the other route",
    ]);
    await expect(conversation(page).getByRole("article")).toHaveCount(4);

    await send("Keep these notes too");
    await expect(steers).toHaveText([/^Steer.+Take the other route$/, /^Steer.+Keep these notes too$/]);
    await expect(pieces).toHaveText([
      "Ready for steering.",
      /^Steer.+Take the other route$/,
      "Steered: Take the other route",
      /^Steer.+Keep these notes too$/,
      "Then: Keep these notes too",
    ]);
    await expect(queued).toHaveCount(1);
    await expect(queued).toHaveCount(1);
    await expect(conversation(page).getByText("Partial reply.", { exact: true })).toBeVisible();
    await composer(page).press("Escape");
    await expect(conversation(page).getByText("Stopped", { exact: true })).toHaveCount(1);
    await expect(queued).toHaveCount(0);
    await expect(conversation(page).getByText("Partial reply.", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(conversation(page).getByText("Stopped", { exact: true })).toHaveCount(2);

    await selectReplay("fail");
    await send("Run a failure");
    await expect(conversation(page).getByText("Failed · rate limited", { exact: true })).toBeVisible();
    await expect(conversation(page).getByText("Starting", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

    await selectReplay("ignore-stop");
    await send("Test force stop");
    await expect(conversation(page)).toContainText("Partial reply from a stuck agent.");
    const forceStop = page.getByRole("button", { name: "Force stop", exact: true });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(conversation(page)).toContainText("Stop received.");
    await expect(forceStop).not.toBeVisible();
    await expect(forceStop).toBeVisible();
    await forceStop.click();
    await expect(conversation(page).getByText("Stopped", { exact: true })).toHaveCount(3);
  } finally {
    await context.close();
  }
});

test("a reloaded window starts its queued turns when the old turn ends", async ({ browser }) => {
  const context = await browser.newContext();
  const cleanup: (() => void)[] = [];
  try {
    const desk = await asDesktop(context);
    const client = await connect(desk.endpoint.ws, {
      token: desk.endpoint.token,
      cleanup,
      launch: undefined,
    });
    const page = await context.newPage();
    await page.goto("/");
    await pickAgentOption(page, "Fake agent", "echo");
    const folder = join(desk.home, "reload");
    await mkdir(folder);
    await page.getByRole("button", { name: "Choose a folder…" }).click();
    await page.getByRole("textbox", { name: "Folder path" }).fill(folder);
    await page.getByRole("button", { name: "Use folder" }).click();

    const first = `Before reload ${crypto.randomUUID().slice(0, 8)}`;
    await composer(page).fill(first);
    await composer(page).press("Enter");
    await expect(conversation(page)).toContainText("Reading your message.");
    const threadId = (await page.getByRole("region", { name: "Chat" }).getAttribute("data-thread-id"))!;
    const running = await client.query(ai.turns.active, { threadId });
    expect(running?.state).toBe("running");
    await composer(page).fill("Survive reload");
    await composer(page).press("Meta+Enter");
    const queued = conversation(page).getByRole("article").filter({ hasText: "Queued" });
    await expect(queued).toHaveCount(1);

    await page.reload();
    await expect(agentRow(page).getByRole("button", { name: "echo" })).toBeVisible();
    expect(await client.query(ai.turns.active, { threadId })).toMatchObject({ _id: running!._id });

    // The relaunched window's local part does not run the old turn: once that turn has been
    // silent for more than a beat, the window ends it (liveness:release) and the queue starts.
    await writeFile(join(folder, "go"), "");
    await expect
      .poll(async () => (await client.query(ai.turns.list, { threadId })).map((turn) => turn.state), {
        timeout: 45_000,
      })
      .toEqual(["interrupted", "done"]);
    // The reloaded window opens on a new thread: open this one to read the old reply.
    await page
      .getByRole("navigation", { name: "Chat threads" })
      .getByRole("option", { name: new RegExp(first) })
      .click();
    await expect(
      conversation(page).getByText("Interrupted · Tokamak was closed", { exact: true }),
    ).toBeVisible();
  } finally {
    for (const close of cleanup) close();
    await context.close();
  }
});

test("on Ask first the agent's question waits on the composer and each answer reaches it by click and by key", async ({
  browser,
}) => {
  // The model menu lists every replay (about 30) and opens upward from the agent row: a tall
  // window keeps "ask-once", at its top, on screen.
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const { home } = await asDesktop(context);
  const page = await context.newPage();
  await page.goto("/");
  await pickAgentOption(page, "Fake agent", "ask-once");
  const card = page.getByRole("group", { name: "Permission question" });
  const replies = () => conversation(page).getByRole("article", { name: /^Fake agent at / });
  /** The turn has ended: Send is back in place of Stop (Enter during a turn would steer it). */
  const ended = () => expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  /** Sends `text` once the thread is idle; resolves the reply that this Send gets. */
  async function send(text: string) {
    await ended();
    const before = await replies().count();
    await composer(page).fill(text);
    await composer(page).press("Enter");
    return replies().nth(before);
  }

  /** A new thread in a fresh folder, switched to Ask first before its first Send. */
  async function askFirstThread() {
    // Every new thread starts on Full access.
    await expectAgentOptions(page, { "Access level": "Full access" });
    await pickAgentOption(page, "Access level", "Ask first");
    const folder = join(home, `project-${crypto.randomUUID().slice(0, 8)}`);
    await mkdir(folder);
    await page.getByRole("button", { name: "Choose a folder…" }).click();
    await page.getByRole("textbox", { name: "Folder path" }).fill(folder);
    await page.getByRole("button", { name: "Use folder" }).click();
  }

  /** Sends a message, answers the card by clicking or by its key, and checks what the agent got. */
  async function answerWith(answer: string, label: string, key: string, by: "click" | "key") {
    if (answer === "decline" && by === "click") {
      // Dispatch a digit as soon as the card mounts, within its cooldown.
      await page.evaluate(() => {
        const observer = new MutationObserver(() => {
          if (!document.querySelector('[aria-label="Permission question"]')) return;
          observer.disconnect();
          const event = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });
          document.activeElement?.dispatchEvent(event);
          document.documentElement.dataset.permissionKeyHandled = String(event.defaultPrevented);
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
    const reply = await send(`Push it (${answer} by ${by})`);
    if (answer === "decline" && by === "click")
      await expect(page.locator("html")).toHaveAttribute("data-permission-key-handled", "false");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Fake agent wants to run");
    await expect(card.locator("code")).toHaveText("git push origin feat/csv-export");
    if (by === "click") await card.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    else {
      // A digit typed after text stays text; in the empty composer it answers instead.
      await composer(page).focus();
      await page.keyboard.type(`v${key}`);
      await expect(composer(page)).toHaveValue(`v${key}`);
      await expect(card).toBeVisible();
      await composer(page).fill("");
      await page.waitForTimeout(500);
      await page.keyboard.press(key);
      await expect(composer(page)).toHaveValue("");
    }
    await expect(reply).toContainText(`Checking the branch. Answer: ${answer}`);
    await expect(card).toHaveCount(0);
  }

  await askFirstThread();
  for (const by of ["click", "key"] as const) {
    await answerWith("approve", "Approve", "1", by);
    await answerWith("decline", "Decline", "3", by);
    await answerWith("cancel", "Cancel", "4", by);
  }
  await answerWith("approveSession", "Always allow this session", "2", "click");
  // The next turn carries that session on: the same kind is approved without a card.
  const allowed = await send("Push it (allowed for this session)");
  await expect(allowed).toContainText("Checking the branch. Answer: approve");
  await expect(card).toHaveCount(0);

  // A turn queued with Cmd+Enter while a question waits keeps the thread's Ask first: it asks too.
  // A new thread, whose session has no allows yet.
  await ended();
  await page.getByRole("button", { name: /^New thread/ }).click();
  await askFirstThread();
  const first = await send("Push it (then queue)");
  await expect(card).toBeVisible();
  await composer(page).fill("Push it (queued)");
  await composer(page).press("Meta+Enter");
  await expect(composer(page)).toHaveValue("");
  await card.getByRole("button", { name: /^Approve/ }).click();
  await expect(first).toContainText("Checking the branch. Answer: approve");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /^Decline/ }).click();
  await expect(replies().last()).toContainText("Checking the branch. Answer: decline");
  await expect(card).toHaveCount(0);

  await page.getByRole("button", { name: /^New thread/ }).click();
  await askFirstThread();
  await answerWith("approveSession", "Always allow this session", "2", "key");
  await context.close();
});
