import { test, expect, type Page } from "@playwright/test";

// Chat on its own: pure threads, no agent. The real server runs the chat build;
// two pages stand in for two windows on the same server.

const unique = (text: string) => `${text} ${crypto.randomUUID().slice(0, 8)}`;
const threads = (page: Page) => page.getByRole("listbox", { name: "Threads" }).getByRole("option");
const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const conversation = (page: Page) => page.getByRole("log", { name: "Conversation" });

async function openChat(page: Page) {
  // Chat is the first view in the catalog, so opening the app lands on it.
  await page.goto("/");
  await expect(page).toHaveURL(/\/p\/chat$/);
  await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
}

async function startThread(page: Page, text: string) {
  await page
    .getByRole("navigation", { name: "Chat threads" })
    .getByRole("button", { name: /New thread/ })
    .click();
  await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(conversation(page).getByText(text, { exact: true })).toBeVisible();
}

test("the app opens on a new thread, and only the first Send creates it", async ({ page }) => {
  await openChat(page);
  await expect(page.getByRole("radiogroup", { name: "Folder" })).toBeVisible();
  const noFolder = page.getByRole("radio", { name: "No folder" });
  await expect(noFolder).toHaveAttribute("aria-checked", "true");
  await expect(noFolder).toHaveAttribute("data-selected", "");
  await expect
    .poll(() => noFolder.evaluate((row) => row.clientWidth === row.parentElement?.clientWidth))
    .toBe(true);
  const before = await threads(page).count();
  const text = unique("Plan the release");
  await composer(page).fill(text);
  // Typing alone stores nothing.
  await expect(threads(page)).toHaveCount(before);
  await composer(page).press("Enter");
  await expect(conversation(page).getByText(text, { exact: true })).toBeVisible();
  await expect(threads(page)).toHaveCount(before + 1);
  await expect(threads(page).first()).toContainText(text);
  await expect(page.getByRole("heading", { level: 1, name: text })).toBeVisible();
  await expect(composer(page)).toHaveValue("");

  // ⌘N goes back to a new thread without creating one.
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
  await expect(threads(page)).toHaveCount(before + 1);
});

test("a message sent in one window appears live in another", async ({ page, context }) => {
  await openChat(page);
  const first = unique("Write the changelog");
  await startThread(page, first);

  const other = await context.newPage();
  await openChat(other);
  await threads(other).filter({ hasText: first }).click();
  await expect(conversation(other).getByText(first, { exact: true })).toBeVisible();

  const second = unique("Mention the new export");
  await composer(page).fill(second);
  await composer(page).press("Enter");
  await expect(conversation(other).getByText(second, { exact: true })).toBeVisible();
  await other.close();
});

test("a thread is renamed by double-clicking its title and deleted from its menu", async ({ page }) => {
  await openChat(page);
  const text = unique("Tidy the invoices");
  await startThread(page, text);
  const renamed = unique("Invoices");

  await page.getByRole("heading", { level: 1, name: text }).dblclick();
  const title = page.getByRole("textbox", { name: "Thread title" });
  await title.fill(renamed);
  await title.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: renamed })).toBeVisible();
  await expect(threads(page).filter({ hasText: renamed })).toHaveCount(1);

  await page.getByRole("button", { name: "Thread actions" }).click();
  await page.getByRole("menuitem", { name: "Delete thread" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(threads(page).filter({ hasText: renamed })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
});

test("a chosen folder is stored with the thread and offered again", async ({ page }) => {
  await openChat(page);
  const folder = `/tmp/tokamak-e2e-${crypto.randomUUID().slice(0, 8)}/invoices-app`;
  await page.getByRole("button", { name: "Choose a folder…" }).click();
  const path = page.getByRole("textbox", { name: "Folder path" });
  await path.fill("relative/path");
  await expect(page.getByRole("button", { name: "Use folder" })).toBeDisabled();
  await path.fill(folder);
  await page.getByRole("button", { name: "Use folder" }).click();
  await expect(page.getByRole("radio", { name: "invoices-app" }).first()).toHaveAttribute(
    "aria-checked",
    "true",
  );

  const text = unique("Add a CSV export");
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(conversation(page).getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByLabel(`Folder ${folder}`)).toBeVisible();

  await page
    .getByRole("navigation", { name: "Chat threads" })
    .getByRole("button", { name: /New thread/ })
    .click();
  await expect(page.locator(`[role="radio"][title="${folder}"]`)).toBeVisible();
});
