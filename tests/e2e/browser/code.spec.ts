import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createApi, type FunctionReference } from "../../../node_modules/@tokamak/sdk/src/index";
import type { TurnView } from "../../../plugins/ai/src/server/_functions";
import { connect } from "../../fake-agent/harness.mjs";
import { startHostedFixture } from "../hosted-fixture";
import { pickAgentOption } from "./agent-picker";
import { asDesktop } from "./desktop";

test("a turn names the large file it skipped and deleting the thread removes its snapshots", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const { home } = await asDesktop(context);
    const folder = join(home, "code-project");
    await mkdir(folder);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: folder, env: { ...process.env, HOME: home } }).toString();
    git("init", "--quiet");
    const large = join(folder, "large.dat");
    await writeFile(large, "");
    await truncate(large, 50_000_001);
    await writeFile(join(folder, "go"), "");

    const page = await context.newPage();
    await page.goto("/");
    await pickAgentAndFolder(page, folder, "edit");

    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Check the project");
    await composer.press("Enter");
    const reply = page
      .getByRole("log", { name: "Conversation" })
      .getByRole("article", { name: /^Fake agent at / });
    await expect(reply.getByText("I edited agent.txt.")).toBeVisible();
    await expect(reply.getByRole("list", { name: "Skipped files" }).getByText("large.dat")).toBeVisible();
    const snapshots = () =>
      git("for-each-ref", "--format=%(refname)", "refs/tokamak/threads").trim().split("\n").filter(Boolean);
    expect(snapshots()).toHaveLength(2);

    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByRole("menuitem", { name: "Delete thread" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect.poll(snapshots).toEqual([]);
  } finally {
    await context.close();
  }
});

const conversation = (page: Page) => page.getByRole("log", { name: "Conversation" });
const replies = (page: Page) => conversation(page).getByRole("article", { name: /^Fake agent at / });

/** A desktop page with the fake agent picked, on `model`, in `folder`. */
async function desktopThread(context: BrowserContext, folder: string, model: string) {
  const page = await context.newPage();
  await page.goto("/");
  await pickAgentAndFolder(page, folder, model);
  return page;
}

async function pickAgentAndFolder(page: Page, folder: string, model: string) {
  await pickModel(page, model);
  await page.getByRole("button", { name: "Choose a folder…" }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(folder);
  await page.getByRole("button", { name: "Use folder" }).click();
}

async function pickModel(page: Page, model: string) {
  await pickAgentOption(page, "Fake agent", model);
}

async function send(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(conversation(page).getByText(text, { exact: true })).toBeVisible();
}

function gitIn(folder: string, home: string) {
  return (...args: string[]) =>
    execFileSync("git", args, {
      cwd: folder,
      env: {
        ...process.env,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      },
    })
      .toString()
      .trimEnd();
}

test("Stop and quit during the after snapshot keeps the finished reply and its code warning", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const cleanup: (() => void)[] = [];
  try {
    const desk = await asDesktop(context);
    const folder = join(desk.home, "quit-during-snapshot");
    await mkdir(folder);
    const git = gitIn(folder, desk.home);
    git("init", "--quiet");
    const page = await desktopThread(context, folder, "edit");
    await send(page, "Edit before quitting");
    await expect(replies(page)).toContainText("I edited agent.txt.");
    const threadId = (await page.getByRole("region", { name: "Chat" }).getAttribute("data-thread-id"))!;
    git("config", "filter.stall.clean", "touch .git/after-started; sleep 90; cat");
    await mkdir(join(folder, ".git/info"), { recursive: true });
    await writeFile(join(folder, ".git/info/attributes"), "agent.txt filter=stall\n");
    await writeFile(join(folder, "go"), "");
    await expect
      .poll(() =>
        stat(join(folder, ".git/after-started")).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);

    await desk.requestQuit();
    await page.getByRole("button", { name: "Stop and quit" }).click();
    await expect.poll(() => desk.quitAnswers).toEqual(["hold", "confirm"]);
    const refs = git("for-each-ref", "--format=%(refname)", "refs/tokamak/threads");
    expect(refs).toMatch(/\/before$/);
    expect(refs.split("\n")).toHaveLength(1);

    await desk.restart();
    const client = await connect(desk.endpoint.ws, {
      token: desk.endpoint.token,
      cleanup,
      launch: undefined,
    });
    const ai = createApi<{
      turns: { list: FunctionReference<"query", { threadId: string }, TurnView[]> };
    }>("ai", ["turns:list"]);
    expect((await client.query(ai.turns.list, { threadId }))[0].state).toBe("done");
    await page.reload();
    await page.getByRole("navigation", { name: "Chat threads" }).getByText("Edit before quitting").click();
    await expect(replies(page)).toContainText("Couldn't save this turn's code");
  } finally {
    for (const close of cleanup) close();
    await context.close();
  }
});

test("reopening Chat removes local snapshots of a thread deleted elsewhere", async ({ browser }) => {
  const context = await browser.newContext();
  const cleanup: (() => void)[] = [];
  try {
    const desk = await asDesktop(context);
    const folder = join(desk.home, "delete-elsewhere");
    await mkdir(folder);
    const git = gitIn(folder, desk.home);
    git("init", "--quiet");
    await writeFile(join(folder, "go"), "");
    const snapshots = () =>
      git("for-each-ref", "--format=%(refname)", "refs/tokamak/threads").split("\n").filter(Boolean);
    const page = await desktopThread(context, folder, "edit");
    await send(page, "Save a snapshot");
    await expect.poll(snapshots).toHaveLength(2);
    const threadId = await page.getByRole("region", { name: "Chat" }).getAttribute("data-thread-id");
    expect(threadId).toBeTruthy();
    await page.close();

    const remote = await connect(desk.endpoint.ws, {
      token: desk.endpoint.token,
      cleanup,
      launch: undefined,
    });
    const chat = createApi<{
      threads: { remove: FunctionReference<"mutation", { threadId: string }, null> };
    }>("chat", ["threads:remove"]);
    await remote.mutation(chat.threads.remove, { threadId: threadId! });
    expect(snapshots()).toHaveLength(2);

    const reopened = await context.newPage();
    await reopened.goto("/");
    await expect(reopened.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect.poll(snapshots).toEqual([]);
  } finally {
    for (const close of cleanup) close();
    await context.close();
  }
});

test("a turn's change card opens the review panel and the branch chip follows the branch", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const shared = await startHostedFixture({
    port: 0,
    ownerKey: randomBytes(32).toString("hex"),
    extraPlugins: ["ai", "code", "fake-agent", "chat"],
  });
  try {
    const { home } = await asDesktop(context);
    const folder = join(home, "review-project");
    await mkdir(folder);
    const git = gitIn(folder, home);
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(folder, ".gitignore"), "go\n");
    await writeFile(join(folder, "README.md"), "# Invoices\n\nExport as PDF.\n");
    git("add", ".");
    git("-c", "user.name=Sam", "-c", "user.email=sam@example.invalid", "commit", "--quiet", "-m", "Start");

    // Both clients open the shared workspace. Only the desktop uses its private Runner for local calls.
    const page = await context.newPage();
    const address = new URL(shared.url).host;
    await page.goto("/connect");
    await page.getByRole("textbox", { name: "Server address" }).fill(shared.url);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Use an invite" }).click();
    await page.getByRole("textbox", { name: "Invite token" }).fill(shared.ownerKey);
    await page.getByRole("button", { name: "Join", exact: true }).click();
    await page.getByRole("textbox", { name: "Your name" }).fill("Sam");
    await page.getByRole("button", { name: `Open ${address}`, exact: true }).click();
    await expect(page.getByRole("status", { name: "Connection status" })).toHaveText(address);
    await pickAgentAndFolder(page, folder, "edit");
    await expect(page.getByRole("img", { name: "Branch main" })).toHaveCount(0);
    const title = `Add a CSV export ${crypto.randomUUID().slice(0, 8)}`;
    await send(page, title);
    // The agent waits for `go`: change the folder while it works, as an agent's tool would.
    await expect(replies(page).first()).toContainText("I edited agent.txt.");
    await writeFile(join(folder, "README.md"), "# Invoices\n\nExport as PDF or CSV.\n");
    await writeFile(join(folder, "go"), "");

    const card = replies(page).first().getByRole("button", { name: "Review turn 1" });
    await expect(card).toBeVisible();
    const [turnRef] = git("for-each-ref", "--format=%(refname)", "refs/tokamak/threads").split("\n");
    const turn = turnRef!.replace(/\/(before|after)$/, "");
    // What `git diff` says between the two snapshots: README.md +1 −1, agent.txt +1.
    expect(git("diff", "--numstat", `${turn}/before`, `${turn}/after`)).toBe(
      "1\t1\tREADME.md\n1\t0\tagent.txt",
    );
    await expect(card).toContainText("2 files+2−1open in review");

    await expect(page.getByRole("img", { name: "Branch main" })).toBeVisible();
    git("checkout", "--quiet", "-b", "feat/csv-export");
    await expect(page.getByRole("img", { name: "Branch feat/csv-export" })).toBeVisible();

    await card.click();
    const panel = page.getByRole("region", { name: "Review" });
    await expect(panel.getByRole("heading", { name: "Turn 1 · 2 files +2 −1" })).toBeVisible();
    const files = panel.getByRole("list", { name: "Changed files" }).getByRole("listitem");
    await expect(files).toHaveText(["README.md+1−1", "agent.txt+10"]);
    const readme = panel.getByRole("article", { name: "Diff of README.md" });
    await expect(readme).toContainText("@@ -1,3 +1,3 @@");
    await expect(readme).toContainText("−Export as PDF.");
    await expect(readme).toContainText("+Export as PDF or CSV.");
    await expect(page.getByRole("button", { name: "Review panel" })).toHaveAttribute("aria-pressed", "true");

    // A turn that changes nothing shows no card; the first turn keeps its own.
    await pickModel(page, "echo");
    await send(page, "Say it back");
    await expect(replies(page).nth(1)).toContainText("You wrote: Say it back");
    await expect(replies(page).nth(1).getByText("Replayed by the fake agent")).toBeVisible();
    await expect(
      replies(page)
        .nth(1)
        .getByRole("button", { name: /^Review turn/ }),
    ).toHaveCount(0);
    await expect(conversation(page).getByRole("button", { name: /^Review turn/ })).toHaveCount(1);
    // Another plugin's addition shares the footer with the card.
    await expect(replies(page).first().getByText("Replayed by the fake agent")).toBeVisible();

    await page.getByRole("button", { name: "Thread only" }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "Review panel" }).click();
    await expect(panel.getByRole("heading", { name: "Turn 1 · 2 files +2 −1" })).toBeVisible();

    // A plain browser has no local part: no card, chip or panel.
    const plain = await browser.newPage();
    try {
      await plain.addInitScript(
        (token) => localStorage.setItem("tokamak.access-token", token),
        shared.ownerKey,
      );
      await plain.goto(new URL("/p/chat", shared.url).href);
      await plain.getByRole("complementary", { name: "Sidebar" }).getByText(title, { exact: true }).click();
      await expect(conversation(plain).getByText("You wrote: Say it back")).toBeVisible();
      await expect(conversation(plain).getByRole("button", { name: /^Review turn/ })).toHaveCount(0);
      await expect(plain.getByRole("img", { name: /^Branch / })).toHaveCount(0);
      await expect(plain.getByRole("group", { name: "Layout" })).toHaveCount(0);
    } finally {
      await plain.close();
    }
  } finally {
    await context.close();
    shared.stop();
    expect(await shared.exited).toBe(0);
  }
});

test("a folder without Git stays plain chat until Git appears, then tracking starts", async ({ browser }) => {
  const context = await browser.newContext();
  // Outside the checkout, which would otherwise be the folder's repository.
  const folder = await mkdtemp(join(tmpdir(), "tokamak-plain-folder-"));
  try {
    const { home } = await asDesktop(context);
    await writeFile(join(folder, "go"), "");
    const page = await desktopThread(context, folder, "echo");
    await send(page, "Hello without Git");
    await expect(replies(page).first()).toContainText("You wrote: Hello without Git");
    await expect(replies(page).first().getByText("Replayed by the fake agent")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Review turn/ })).toHaveCount(0);
    await expect(page.getByRole("img", { name: /^Branch / })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Layout" })).toHaveCount(0);

    const git = gitIn(folder, home);
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(folder, ".gitignore"), "go\n");
    await writeFile(join(folder, "one.txt"), "1\n");
    await writeFile(join(folder, "two.txt"), "2\n");
    await send(page, "Now with Git");
    // Tracking starts on a turn that changed nothing: the line shows, and there is no panel to open.
    await expect(replies(page).nth(1)).toContainText("You wrote: Now with Git");
    await expect(replies(page).nth(1).getByText("Started tracking · 3 files")).toBeVisible();
    await expect(
      replies(page)
        .nth(1)
        .getByRole("button", { name: /^Review turn/ }),
    ).toHaveCount(0);
    await expect(page.getByRole("img", { name: "Branch main" })).toBeVisible();

    await pickModel(page, "edit");
    await send(page, "Edit with Git");
    const card = replies(page).nth(2).getByRole("button", { name: "Review turn 3" });
    await expect(card).toContainText("1 file+10open in review");
    await expect(card).not.toContainText("Started tracking");
  } finally {
    await context.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("a thread in Git from the start never says Started tracking, even after a failed first snapshot", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const { home } = await asDesktop(context);
    const folder = join(home, "blocked-project");
    await mkdir(folder);
    const git = gitIn(folder, home);
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(folder, ".gitignore"), "go\n");
    await writeFile(join(folder, "go"), "");
    git("add", ".");
    git("-c", "user.name=Sam", "-c", "user.email=sam@example.invalid", "commit", "--quiet", "-m", "Start");
    // A file where the snapshot refs go: the first before snapshot fails and the agent never runs.
    const blocker = join(folder, ".git/refs/tokamak");
    await writeFile(blocker, "");

    const page = await desktopThread(context, folder, "edit");
    await send(page, "Blocked first turn");
    await expect(replies(page).first()).toContainText("Couldn't save the code before this turn");
    await unlink(blocker);
    await send(page, "Second turn");
    const card = replies(page).nth(1).getByRole("button", { name: "Review turn 2" });
    await expect(card).toContainText("1 file+10open in review");
    await expect(card).not.toContainText("Started tracking");
  } finally {
    await context.close();
  }
});
