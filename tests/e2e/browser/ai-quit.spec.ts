import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { createApi, type FunctionReference } from "../../../node_modules/@tokamak/sdk/src/index";
import type { TurnView } from "../../../plugins/ai/src/server/_functions";
import { connect } from "../../fake-agent/harness.mjs";
import { pickAgentOption } from "./agent-picker";
import { asDesktop } from "./desktop";

// Quitting the desktop app while an agent works: the window asks first. The
// test desktop (desktop.ts) plays the native side: it sends the quit request
// and, on confirm, closes every local worker as the app does.

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const conversation = (page: Page) => page.getByRole("log", { name: "Conversation" });
const agentRow = (page: Page) => page.getByRole("group", { name: "Agent" });

const ai = createApi<{
  turns: { list: FunctionReference<"query", { threadId: string }, TurnView[]> };
}>("ai", ["turns:list"]);

/** Whether a process still runs (a zombie waiting for its parent counts as gone). */
function alive(pid: number) {
  const stat = spawnSync("ps", ["-ww", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  return stat !== "" && !stat.startsWith("Z");
}

test("quitting with no turn running quits at once, without a dialog", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const desk = await asDesktop(context);
    const page = await context.newPage();
    await page.goto("/");
    await expect(agentRow(page)).toBeVisible();
    await desk.requestQuit();
    await expect.poll(() => desk.quitAnswers).toEqual(["confirm"]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("quitting while an agent works asks first; Cancel keeps it, Stop and quit leaves no agent process", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
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
    // An agent that ignores Stop and has started a child and a grandchild that ignore signals too.
    await pickAgentOption(page, "Fake agent", "ignore-stop");
    const folder = join(desk.home, `quit-${crypto.randomUUID().slice(0, 8)}`);
    await mkdir(folder);
    await page.getByRole("button", { name: "Choose a folder…" }).click();
    await page.getByRole("textbox", { name: "Folder path" }).fill(folder);
    await page.getByRole("button", { name: "Use folder" }).click();
    await composer(page).fill("Keep going");
    await composer(page).press("Enter");
    await expect(composer(page)).toHaveValue("");
    await expect(conversation(page)).toContainText("Partial reply from a stuck agent.");
    const threadId = (await page.getByRole("region", { name: "Chat" }).getAttribute("data-thread-id"))!;
    const pids: number[] = JSON.parse(await readFile(join(folder, "process-tree.json"), "utf8"));
    expect(pids).toHaveLength(3);

    for (const text of ["First follow-up", "Second follow-up"]) {
      await composer(page).fill(text);
      await composer(page).press("Meta+Enter");
      await expect(composer(page)).toHaveValue("");
      await expect(conversation(page).getByRole("article").filter({ hasText: text })).toContainText("Queued");
    }

    const dialog = page.getByRole("dialog");
    await desk.requestQuit();
    await expect(dialog).toContainText("Fake agent is still working in 1 thread and has 2 queued messages");
    expect(desk.quitAnswers).toEqual(["hold"]);

    // Cancel: the app stays and the agent keeps working.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(desk.quitAnswers).toEqual(["hold", "cancel"]);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    expect(pids.every(alive)).toBe(true);
    expect((await client.query(ai.turns.list, { threadId }))[0].state).toBe("running");

    // Stop and quit: every turn stops (this agent only by force, after the Stop delay), then the app quits.
    await desk.requestQuit();
    await dialog.getByRole("button", { name: "Stop and quit" }).click();
    await expect(dialog).toContainText("Stopping…");
    await expect
      .poll(() => desk.quitAnswers, { timeout: 30_000 })
      .toEqual(["hold", "cancel", "hold", "confirm"]);
    expect(pids.filter(alive)).toEqual([]);
    await desk.restart();
    const reopened = await connect(desk.endpoint.ws, {
      token: desk.endpoint.token,
      cleanup,
      launch: undefined,
    });
    const turns = await reopened.query(ai.turns.list, { threadId });
    expect(turns.map((turn) => turn.state)).toEqual(["stopped", "stopped", "stopped"]);

    // The original page has lost its connection. Reopen the thread as a
    // person would after relaunching, then check the saved labels on screen.
    await page.reload();
    await page.getByRole("navigation", { name: "Chat threads" }).getByText("Keep going").click();
    await expect(page.getByRole("region", { name: "Chat" })).toHaveAttribute("data-thread-id", threadId);
    for (const text of [
      "First follow-up",
      "Second follow-up",
      "Partial reply from a stuck agent. Stop received.",
    ]) {
      await expect(conversation(page).getByRole("article").filter({ hasText: text })).toContainText(
        "Stopped",
      );
    }
    await expect(conversation(page)).not.toContainText("Interrupted");
  } finally {
    for (const close of cleanup) close();
    await context.close();
  }
});
