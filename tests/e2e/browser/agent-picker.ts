import { expect, type Page } from "@playwright/test";

/** The agent row's closed picker: "Agent: <agent> · <model> · <effort>" for screen readers. */
export const agentChip = (page: Page) =>
  page.getByRole("group", { name: "Agent" }).getByRole("button", { name: /^Agent: / });

/** Opens the picker's popover; resolves it once its entrance has finished. */
async function openPicker(page: Page) {
  await agentChip(page).click();
  const menu = page.getByRole("menu");
  // Opening the picker refreshes its options and can replace rows during the entrance.
  await expect(menu).toHaveCSS("opacity", "1");
  return menu;
}

/** Closes the popover: its choices keep it open, so they can change together. */
async function closePicker(page: Page) {
  await page.keyboard.press("Escape");
  await expect(agentChip(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("menu", { includeHidden: true })).toBeHidden();
}

/**
 * Picks `option` in the picker's `group` and closes it again. The groups are each agent
 * by name (its models), "Effort", "Speed", "Mode" and "Access level". Resolves once the
 * pick is checked, which for an open thread means the server stored it.
 */
export async function pickAgentOption(page: Page, group: string, option: string) {
  const menu = await openPicker(page);
  const item = menu
    .getByRole("group", { name: group, exact: true })
    .getByRole("menuitemradio", { name: option, exact: true });
  await item.scrollIntoViewIfNeeded();
  await expect(item).toBeInViewport();
  await item.click();
  await expect(item).toHaveAttribute("aria-checked", "true");
  await closePicker(page);
}

/** Opens the picker and checks which option each group has picked; `absent` groups are not offered. */
export async function expectAgentOptions(
  page: Page,
  picked: Readonly<Record<string, string>>,
  absent: readonly string[] = [],
) {
  const menu = await openPicker(page);
  for (const [group, option] of Object.entries(picked))
    await expect(
      menu
        .getByRole("group", { name: group, exact: true })
        .getByRole("menuitemradio", { name: option, exact: true }),
    ).toHaveAttribute("aria-checked", "true");
  for (const group of absent)
    await expect(menu.getByRole("group", { name: group, exact: true })).toHaveCount(0);
  await closePicker(page);
}

/** Opens and closes the picker: the agents are asked for their `info` again. */
export async function lookAgain(page: Page) {
  await openPicker(page);
  await closePicker(page);
}
