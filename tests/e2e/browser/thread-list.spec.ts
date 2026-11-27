import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { pickAgentOption } from "./agent-picker";
import { asDesktop } from "./desktop";

// ai's marks in chat's thread list (Paper "Threads · C"), on a desktop page
// running the real local part and the fake agent (tests/fake-agent).

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const threadRow = (page: Page, title: string) =>
  page.getByRole("navigation", { name: "Chat threads" }).getByRole("option", { name: new RegExp(title) });

test("each thread shows its status live, and a second line only while it works", async ({ browser }) => {
  // The picker lists every replay and opens upward: a tall window keeps them all on screen.
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  try {
    const { home } = await asDesktop(context);
    const page = await context.newPage();
    await page.goto("/");
    const id = crypto.randomUUID().slice(0, 8);

    /** A new thread in its own folder, sent with the replay `model`; resolves its title and folder name. */
    async function startThread(label: string, model: string, access?: "Ask first") {
      await page
        .getByRole("navigation", { name: "Chat threads" })
        .getByRole("button", { name: /^New thread/ })
        .click();
      await pickAgentOption(page, "Fake agent", model);
      if (access) await pickAgentOption(page, "Access level", access);
      const folderName = `${label.toLowerCase()}-${id}`;
      await mkdir(join(home, folderName));
      await page.getByRole("button", { name: "Choose a folder…" }).click();
      await page.getByRole("textbox", { name: "Folder path" }).fill(join(home, folderName));
      await page.getByRole("button", { name: "Use folder" }).click();
      const title = `${label} ${id}`;
      await composer(page).fill(title);
      await composer(page).press("Enter");
      await expect(threadRow(page, title)).toBeVisible();
      return { row: threadRow(page, title), folderName };
    }
    const detail = (row: ReturnType<typeof threadRow>) => row.locator("[data-part=detail]");

    // Full access answers the replay's question at once: the turn ends as done, on one line.
    const done = await startThread("Finished", "ask-once");
    await expect(done.row.getByRole("img", { name: "done" })).toBeVisible();
    await expect(detail(done.row)).toBeHidden();

    const failed = await startThread("Broken", "fail");
    await expect(failed.row.getByRole("img", { name: "failed" })).toBeVisible();
    await expect(detail(failed.row)).toBeHidden();

    // A turn that runs until stopped: the running mark and agent, model and folder under the title.
    const running = await startThread("Working", "stop");
    await expect(running.row.getByRole("img", { name: "running" })).toBeVisible();
    await expect(detail(running.row)).toBeVisible();
    await expect(detail(running.row).getByRole("img", { name: "Fake agent" })).toBeVisible();
    await expect(detail(running.row)).toHaveText(`stop· ${running.folderName}`);

    // A turn with a helper agent: one small row under the thread, with its name, task and state.
    const helping = await startThread("Helping", "work");
    const helpers = helping.row.getByRole("list", { name: "Helpers" }).getByRole("listitem");
    await expect(helpers).toHaveCount(1);
    await expect(helpers).toContainText("Explore");
    await expect(helpers).toContainText("Find where the token is cached");
    await expect(helpers.getByRole("img", { name: "done" })).toBeVisible();
    await expect(detail(helping.row)).toHaveText(`work· ${helping.folderName}`);
    // When the turn ends the helper rows and the second line go.
    await writeFile(join(home, helping.folderName, "go"), "");
    await expect(helping.row.getByRole("img", { name: "done" }).first()).toBeVisible();
    await expect(helping.row.getByRole("list", { name: "Helpers" })).toHaveCount(0);
    await expect(detail(helping.row)).toBeHidden();

    // On Ask first the agent waits for an answer: the amber lock, and the second line too.
    const waiting = await startThread("Asking", "ask-once", "Ask first");
    const lock = waiting.row.getByRole("img", { name: "needs you" });
    await expect(lock).toBeVisible();
    await expect(waiting.row.locator("[data-slot=status-icon]")).toHaveClass(/text-warn/);
    await expect(detail(waiting.row)).toHaveText(`ask-once· ${waiting.folderName}`);
    // The other rows stay as they were.
    await expect(running.row.getByRole("img", { name: "running" })).toBeVisible();
    await expect(done.row.getByRole("img", { name: "done" })).toBeVisible();

    // Answering the question: the lock turns into done and the second line goes, live.
    await page
      .getByRole("group", { name: "Permission question" })
      .getByRole("button", { name: /^Approve/ })
      .click();
    await expect(waiting.row.getByRole("img", { name: "done" })).toBeVisible();
    await expect(detail(waiting.row)).toBeHidden();

    // Stopping the running thread: a stopped turn shows as done.
    await running.row.click();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(running.row.getByRole("img", { name: "done" })).toBeVisible();
    await expect(detail(running.row)).toBeHidden();
    // The age stays on the right of every row.
    await expect(running.row.locator("[data-part=age]")).toHaveText(/\S/);
  } finally {
    await context.close();
  }
});
