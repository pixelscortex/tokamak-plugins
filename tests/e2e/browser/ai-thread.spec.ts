import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { installFakeAgent } from "../../fake-agent/local.mjs";
import { agentChip, expectAgentOptions, lookAgain, pickAgentOption } from "./agent-picker";
import { asDesktop } from "./desktop";

// The agent picker and what belongs to a thread (TKM-224, TKM-259), on a desktop
// page running the real local part with two fake agents: "Fake agent" offers
// modes but no levels or speeds, "Other agent" levels and speeds but no modes. The `context` replay says
// back what the agent was given (see tests/fake-agent).

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const send = (page: Page) => page.getByRole("button", { name: "Send" });
const conversation = (page: Page) => page.getByRole("log", { name: "Conversation" });
const agentRow = (page: Page) => page.getByRole("group", { name: "Agent" });

test("the picker shows only what the agent offers, and Send waits while the agent is signed out or missing", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const { home, bin } = await asDesktop(context);
  const page = await context.newPage();
  await page.goto("/");

  // Other agent: model, level, speed and access level (no modes); every thread starts on Full access.
  await pickAgentOption(page, "Other agent", "context");
  await expect(agentChip(page)).toHaveAccessibleName("Agent: Other agent · context · Low");
  await expectAgentOptions(page, { Effort: "Low", Speed: "Standard", "Access level": "Full access" }, [
    "Mode",
  ]);
  // Fake agent offers no levels or speeds, but modes: a mode is not a speed.
  await pickAgentOption(page, "Fake agent", "context");
  await expect(agentChip(page)).toHaveAccessibleName("Agent: Fake agent · context");
  await expectAgentOptions(page, { Mode: "Default", "Access level": "Full access" }, ["Effort", "Speed"]);

  // Signed out: the chip names only the agent, the popover only the agents, and Send is off
  // (the button and Enter).
  await mkdir(join(home, ".other-agent"), { recursive: true });
  await writeFile(join(home, ".other-agent", "signed-out"), "");
  await pickAgentOption(page, "Other agent", "context");
  await expect(agentRow(page).getByRole("status")).toHaveText(
    "Other agent is signed out. Sign in, then come back.",
  );
  await expect(agentChip(page)).toHaveAccessibleName("Agent: Other agent");
  await expectAgentOptions(page, {}, ["Effort", "Speed", "Access level"]);
  await composer(page).fill("Add a CSV export");
  await expect(send(page)).toBeDisabled();
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("Add a CSV export");

  // Signed in again: seen the next time a picker opens, without a restart.
  await unlink(join(home, ".other-agent", "signed-out"));
  await lookAgain(page);
  await expect(agentRow(page).getByRole("status")).toHaveCount(0);
  await expect(send(page)).toBeEnabled();

  // Not installed, then installed.
  await unlink(join(bin, "other-agent"));
  await lookAgain(page);
  await expect(agentRow(page).getByRole("status")).toHaveText("Other agent isn't installed.");
  await expect(send(page)).toBeDisabled();
  await installFakeAgent(bin, ["other-agent"]);
  await lookAgain(page);
  await expect(send(page)).toBeEnabled();
  await context.close();
});

test("the choices belong to the thread, apply to its next turn, and a switched agent gets the conversation", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const { home } = await asDesktop(context);
  const page = await context.newPage();
  await page.goto("/");
  await pickAgentOption(page, "Other agent", "context");
  await pickAgentOption(page, "Effort", "High");
  await pickAgentOption(page, "Access level", "Ask first");

  const folder = join(home, `project-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(folder);
  await page.getByRole("button", { name: "Choose a folder…" }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(folder);
  await page.getByRole("button", { name: "Use folder" }).click();

  const replies = conversation(page).getByRole("article", { name: / at / });
  // Sends `text` as a new turn and waits until that turn has ended: Enter while a turn runs would steer it.
  const say = async (text: string) => {
    await composer(page).fill(text);
    await composer(page).press("Enter");
    await expect(replies.filter({ hasText: `Message: ${text}` })).toBeVisible();
    await expect(agentRow(page).getByText("esc to stop")).toHaveCount(0);
  };
  const first = `Plan the export ${crypto.randomUUID().slice(0, 8)}`;
  await say(first);
  const firstReply = replies.filter({ hasText: `Message: ${first}` });
  await expect(firstReply).toContainText("Fresh session");
  await expect(firstReply).toContainText("model context, level high, speed standard, mode -, access ask");

  // The open thread shows its own choices; changing them applies to the next turn, which carries on the session.
  await expectAgentOptions(page, { "Access level": "Ask first" });
  await pickAgentOption(page, "Effort", "Low");
  await pickAgentOption(page, "Speed", "Fast");
  await say("Now write it");
  const second = replies.filter({ hasText: "Message: Now write it" });
  await expect(second).toContainText("Carrying on other-agent-");
  await expect(second).toContainText("model context, level low, speed fast, mode -, access ask");

  // Switching agent mid-thread: the new agent starts fresh with the whole conversation so far.
  await pickAgentOption(page, "Fake agent", "context");
  await pickAgentOption(page, "Mode", "Plan");
  await say("Review it");
  const switched = replies.filter({ hasText: "Message: Review it" });
  await expect(switched).toHaveAccessibleName(/^Fake agent at /);
  await expect(switched).toContainText("Fresh session");
  await expect(switched).toContainText("level -, speed -, mode plan, access ask");
  await expect(switched).toContainText(`: ${first}`);
  await expect(switched).toContainText("agent Other agent: Fresh session");
  await expect(switched).toContainText(": Now write it");

  // A new thread starts on Full access, with this device's last agent.
  await page
    .getByRole("navigation", { name: "Chat threads" })
    .getByRole("button", { name: /New thread/ })
    .click();
  await expect(agentChip(page)).toHaveAccessibleName("Agent: Fake agent · context");
  await expectAgentOptions(page, { "Access level": "Full access" });
  // Back in the thread, its own choices are still there.
  await page.getByRole("option", { name: new RegExp(first) }).click();
  await expect(agentChip(page)).toHaveAccessibleName("Agent: Fake agent · context");
  await expectAgentOptions(page, { Mode: "Plan", "Access level": "Ask first" });
  await context.close();
});

test("a long model list stays inside a short window and scrolls to its last model", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await asDesktop(context);
  const page = await context.newPage();
  await page.goto("/");
  await pickAgentOption(page, "Fake agent", "echo");
  await agentChip(page).click();
  const menu = page.getByRole("menu");
  // Opening the picker refreshes its options and can replace rows during the entrance.
  await expect(menu).toHaveCSS("opacity", "1");
  const models = menu.getByRole("group", { name: "Fake agent", exact: true }).getByRole("menuitemradio");
  // Every replay is a model of the fake agent: far more than 720 px of rows.
  expect(await models.count()).toBeGreaterThan(15);
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(720);
  // The columns scroll; the settings bar under them stays in view.
  await expect(menu.getByRole("group", { name: "Access level" })).toBeInViewport();
  const last = (await models.last().textContent())!.trim();
  // Clicking scrolls the row into view inside the columns.
  await models.last().click();
  await expect(agentChip(page)).toHaveAccessibleName(`Agent: Fake agent · ${last}`);
  await context.close();
});
