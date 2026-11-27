import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakeCompanies } from "../../../plugins/agent-proxy/tests/fake-companies";
import { agentChip, pickAgentOption } from "./agent-picker";
import { asDesktop } from "./desktop";
import { out, screen, shot } from "./screen-capture";

test.skip(!out, "set TOKAMAK_SCREENS to a folder to take the screenshots");

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const conversation = (page: Page) => page.getByRole("log", { name: "Conversation" });

async function pick(page: Page, replay: string) {
  await pickAgentOption(page, "Fake agent", replay);
}

async function useFolder(page: Page, folder: string) {
  await page.getByRole("button", { name: "Choose a folder…" }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(folder);
  await page.getByRole("button", { name: "Use folder" }).click();
}

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(conversation(page).getByText(text, { exact: true })).toBeVisible();
  await expect(composer(page)).toHaveValue("");
}

// A plain browser has no local part, so AI and Code draw nothing.
test("chat alone screens", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext(screen);
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    // A plain browser stores a typed folder as typed, so the example path needs no folder.
    await useFolder(page, "/example/project");
    await shot(page, "chat-new-thread");
    await composer(page).fill("Fix the session test");
    await shot(page, "chat-composer-typing");
    await composer(page).press("Enter");
    await expect(conversation(page).getByText("Fix the session test", { exact: true })).toBeVisible();
    await composer(page).fill("It fails since the token refresh change.");
    await composer(page).press("Enter");
    await expect(conversation(page).getByText("It fails since the token refresh change.")).toBeVisible();
    // The text stays in the composer until the message has arrived.
    await expect(composer(page)).toHaveValue("");
    await shot(page, "chat-open-thread");
    await page.getByRole("button", { name: "Thread actions" }).click();
    await shot(page, "chat-thread-menu");
    await page.keyboard.press("Escape");
  } finally {
    await context.close();
  }
});

test("thread screens", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext(screen);
  try {
    const { home } = await asDesktop(context);
    const page = await context.newPage();
    await page.goto("/");
    await pick(page, "work");
    await shot(page, "new-thread");
    // The agent picker open over the new thread's composer.
    await agentChip(page).click();
    await expect(page.getByRole("menu")).toHaveCSS("opacity", "1");
    await shot(page, "picker-open");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();

    // A Git folder, so the branch, the change card and the review panel show.
    const folder = join(home, "invoices-app");
    await mkdir(folder);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: folder,
        env: {
          ...process.env,
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        },
      });
    git("init", "--quiet", "-b", "feat/csv-export");
    await writeFile(join(folder, "README.md"), "# Invoices\n");
    await useFolder(page, folder);

    await send(page, "The session test fails since the token refresh change. Fix it, keep the public API.");
    const replies = conversation(page).getByRole("article", { name: /^Fake agent at / });
    await expect(replies.first().getByRole("button", { name: /Running pnpm test auth/ })).toBeVisible();
    await shot(page, "reply-running");

    await writeFile(join(folder, "go"), "");
    await expect(replies.first().getByRole("button", { name: /^Worked\s*5 actions/ })).toBeVisible();
    await shot(page, "reply-finished");
    await replies
      .first()
      .getByRole("button", { name: /^Worked\s*5 actions/ })
      .click();
    await replies.first().getByRole("button", { name: "Thinking" }).click();
    await shot(page, "reply-opened");
    await replies
      .first()
      .getByRole("button", { name: /^Worked\s*5 actions/ })
      .click();
    await replies.first().getByRole("button", { name: "Thinking" }).click();

    // A turn that edits a file: the change card, then the review panel.
    await unlinkGo(folder);
    await pick(page, "edit");
    const lines = Array.from(
      { length: 240 },
      (_, n) => `  const value${n} = format(rows[${n}], columns, { plain: true, locale: "en" });`,
    );
    await writeFile(join(folder, "export.ts"), lines.join("\n") + "\n");
    git("add", "-A");
    git("-c", "user.name=Sam", "-c", "user.email=sam@example.com", "commit", "-qm", "start");
    await send(page, "Add a CSV export to the invoices page.");
    // The replay holds after its text: edit while the turn runs (a long edit, and a file the
    // operating system writes), then let it end.
    await expect(conversation(page).getByText("I edited agent.txt.")).toBeVisible();
    const edited = [...lines];
    edited.splice(
      10,
      3,
      "  // The export reads the table's own column list, so the file and the screen can't drift apart, ever.",
    );
    for (const at of [60, 110, 160, 210])
      edited.splice(at, 2, `  const total${at} = sum(rows.slice(0, ${at}));`);
    edited.push("  export const csv = toCsv(rows, columns);");
    await writeFile(join(folder, "export.ts"), edited.join("\n") + "\n");
    await writeFile(join(folder, ".DS_Store"), Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]));
    await writeFile(join(folder, "go"), "");
    await expect(page.getByRole("button", { name: /^Review turn 2/ })).toBeVisible();
    await shot(page, "change-card");
    await page.getByRole("button", { name: /^Review turn 2/ }).click();
    await expect(
      page.getByRole("region", { name: "Review" }).getByRole("list", { name: "Changed files" }),
    ).toBeVisible();
    await shot(page, "review-panel");
    // The scrollbar's two hover steps: pointer in the panel, then on the thumb.
    const review = page.getByRole("region", { name: "Review" });
    const thumb = review.locator("[data-slot=scroll-area-thumb]").first();
    const colour = () => thumb.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(1200);
    console.log("thumb at rest", await colour());
    await review.hover({ position: { x: 200, y: 400 } });
    await page.waitForTimeout(400);
    console.log("thumb, pointer in the panel", await colour());
    await review.screenshot({ path: join(out!, "scrollbar-panel-hover.png") });
    await thumb.hover({ force: true });
    await page.waitForTimeout(400);
    console.log("thumb hovered", await colour());
    await review.screenshot({ path: join(out!, "scrollbar-thumb-hover.png") });
    await page.getByRole("button", { name: "Thread only" }).click();

    // A few more threads for the list.
    for (const title of ["Paginate customer list", "PDF dark mode"]) {
      await page.getByRole("button", { name: /^New thread/ }).click();
      await pick(page, "quick");
      await send(page, title);
      await expect(conversation(page).getByText(`Done: ${title}`)).toBeVisible();
    }
    // Every turn has ended: no Stop in the composer, no spinner in the list.
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await shot(page, "thread-list");

    // Ask first: the permission question on the composer's tray, and the waiting thread.
    await page.getByRole("button", { name: /^New thread/ }).click();
    await pick(page, "ask-once");
    await pickAgentOption(page, "Access level", "Ask first");
    await send(page, "Push the branch");
    const question = page.getByRole("group", { name: "Permission question" });
    await expect(question).toBeVisible();
    await shot(page, "permission-card");
    await question.getByRole("button", { name: "Approve" }).click();
    await expect(question).toHaveCount(0);

    // Steers: two follow-ups sent while the reply ran, each drawn where it arrived.
    await page.getByRole("button", { name: /^New thread/ }).click();
    await pick(page, "steer");
    await send(page, "Rename the export button to Download CSV.");
    await expect(conversation(page).getByText("Ready for steering.")).toBeVisible();
    await send(page, "Also keep the old label as a tooltip");
    await expect(conversation(page).getByText("Steered: Also keep the old label as a tooltip")).toBeVisible();
    await send(page, "Then run the tests");
    await expect(conversation(page).getByText("Then: Then run the tests")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await shot(page, "reply-steered");
  } finally {
    await context.close();
  }
});

async function unlinkGo(folder: string) {
  const { unlink } = await import("node:fs/promises");
  await unlink(join(folder, "go")).catch(() => {});
}

// The Profiles screen in flow order (TKM-261, 262, 264, 265): adding a Claude
// subscription, then a ChatGPT one, making profiles and dragging both in, the
// subscription details, and removing; signed in against the fake Claude and
// ChatGPT sign-ins. The Profiles and picker captures load the real plugins
// without the browser suite's fixture rail entries.
test("profiles screens", async ({ browser }) => {
  test.setTimeout(180_000);
  const fake = await startFakeCompanies();
  fake.addAccount("anthropic", "personal");
  const shared = process.env.TOKAMAK_PLUGIN_DIR!;
  const folder = await mkdtemp(join(dirname(shared), "profiles-"));
  const plugins = join(folder, "plugins");
  for (const id of ["chat", "ai", "code", "basic-auth"]) {
    await cp(join(shared, id), join(plugins, id), { recursive: true });
  }
  await cp(process.env.TOKAMAK_E2E_EXTRA_PLUGINS!, plugins, { recursive: true });
  // The server reads the addresses from the installation's .env.local, beside its plugins.
  await writeFile(
    join(folder, ".env.local"),
    `TOKAMAK_AGENT_PROXY_ADDRESSES='${JSON.stringify(fake.addresses)}'\n`,
  );
  const context = await browser.newContext(screen);
  let desktop: Awaited<ReturnType<typeof asDesktop>>;
  try {
    process.env.TOKAMAK_PLUGIN_DIR = plugins;
    try {
      desktop = await asDesktop(context);
    } finally {
      process.env.TOKAMAK_PLUGIN_DIR = shared;
    }
    // The catalog needs installed CLIs but no personal logins.
    await writeFile(
      join(desktop.bin, "claude"),
      `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.330 (Claude Code)'; else echo '{"loggedIn":false}'; fi
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(desktop.bin, "codex"),
      `#!/bin/sh
exec ${JSON.stringify(process.env.TOKAMAK_E2E_BUN)} ${JSON.stringify(join(process.cwd(), "tests/fake-agent/profile-codex.mjs"))} "$@"
`,
      { mode: 0o700 },
    );
    /** The sign-in page the dialog's "Open sign-in page" asks the desktop to open. */
    const signInPage = async () => {
      await dialog.getByRole("button", { name: "Open sign-in page" }).click();
      await expect.poll(() => desktop.opened.length).toBeGreaterThan(opened);
      return desktop.opened[opened++]!;
    };
    let opened = 0;
    const page = await context.newPage();
    await page.goto("/p/ai-profiles");
    const subscriptions = page.getByRole("region", { name: "Subscriptions" });
    await expect(subscriptions.getByRole("button", { name: "Add subscription" })).toBeVisible();
    // Blur the field typed in last and move the pointer off, so a shot shows no focus or hover.
    const rest = () =>
      Promise.all([
        page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()),
        page.mouse.move(5, 5),
      ]);

    await subscriptions.getByRole("button", { name: "Add subscription" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: /Anthropic/ })).toBeVisible();
    // The logos come from ai's agent list once the Runner answers.
    await expect(dialog.locator("[data-mark=agent]")).toHaveCount(2);
    await rest();
    await shot(page, "profiles-add-company");
    await dialog.getByRole("button", { name: /Anthropic/ }).click();
    await expect(dialog.getByRole("button", { name: /Claude subscription/ })).toBeVisible();
    await rest();
    await shot(page, "profiles-add-method");
    await dialog.getByRole("button", { name: /Claude subscription/ }).click();
    await expect(dialog.getByRole("button", { name: "Open sign-in page" })).toBeVisible();
    await rest();
    await shot(page, "profiles-add-sign-in");

    // The person signs in on Claude's page in their browser and ends on the callback link.
    const signedIn = await fetch(await signInPage(), { redirect: "manual" });
    const callback = signedIn.headers.get("location")!;
    // The address goes in the field the step shows, as on another device or when no return came.
    await dialog.getByRole("textbox", { name: /Address the sign-in ended on/ }).fill(callback);
    await rest();
    await shot(page, "profiles-add-sign-in-pasted");
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog.getByRole("heading", { name: "Connected" })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Label" }).fill("Personal");
    await rest();
    await shot(page, "profiles-add-connected");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(subscriptions.getByRole("article", { name: "Claude Pro, Personal" })).toBeVisible();
    await rest();
    await shot(page, "profiles-subscriptions");

    // A second sign-in, left waiting: the dialog closes and the card stays.
    await subscriptions.getByRole("button", { name: "Add subscription" }).click();
    await dialog.getByRole("button", { name: /Anthropic/ }).click();
    await dialog.getByRole("button", { name: /Claude subscription/ }).click();
    await expect(dialog.getByRole("button", { name: "Open sign-in page" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(subscriptions.getByRole("article", { name: "Claude, awaiting sign-in" })).toBeVisible();
    await rest();
    await shot(page, "profiles-awaiting");

    // The same steps for OpenAI (TKM-262), ending with a ChatGPT card beside the Claude one.
    // Starting it replaces the waiting Claude sign-in (one new sign-in waits at a time).
    fake.addAccount("openai", "chatgpt");
    await subscriptions.getByRole("button", { name: "Add subscription" }).click();
    await dialog.getByRole("button", { name: /OpenAI/ }).click();
    await expect(dialog.getByRole("button", { name: /ChatGPT subscription/ })).toBeVisible();
    await rest();
    await shot(page, "profiles-add-method-openai");
    await dialog.getByRole("button", { name: /ChatGPT subscription/ }).click();
    fake.nextSignIn("chatgpt");
    const returned = await fetch(await signInPage(), { redirect: "manual" });
    await dialog
      .getByRole("textbox", { name: /Address the sign-in ended on/ })
      .fill(returned.headers.get("location")!);
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog.getByRole("heading", { name: "Connected" })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Label" }).fill("Personal");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(subscriptions.getByRole("article", { name: "ChatGPT Plus, Personal" })).toBeVisible();
    await rest();
    await shot(page, "profiles-both-companies");

    // The Profiles section (TKM-264): two profiles made with "New profile", then
    // both cards dragged in with the mouse, as a person does it.
    const section = page.getByRole("region", { name: "Profiles" });
    async function newProfile(name: string, code: string, picture?: string) {
      await section.getByRole("button", { name: "New profile" }).click();
      const form = page.getByRole("dialog", { name: "New profile" });
      await form.getByRole("textbox", { name: "Name" }).fill(name);
      // Typed in lower case: the field shows it upper case.
      await form.getByRole("textbox", { name: "Code" }).fill(code);
      if (picture) {
        await rest();
        await shot(page, picture);
      }
      await form.getByRole("button", { name: "Create" }).click();
      await expect(form).toHaveCount(0);
    }
    await newProfile("Personal", "pers", "profiles-new-profile");
    await newProfile("Sandbox work", "sbox");
    const claude = subscriptions.getByRole("article", { name: "Claude Pro, Personal" });
    const chatgpt = subscriptions.getByRole("article", { name: "ChatGPT Plus, Personal" });
    const box = (code: string) => section.locator(`[data-profile][aria-label^="${code},"]`);
    /** Presses on a card's email line and carries it to the bottom of `code`'s box. */
    async function carry(card: typeof claude, code: string) {
      const from = (await card.boundingBox())!;
      await page.mouse.move(from.x + 48, from.y + 64);
      await page.mouse.down();
      const to = (await box(code).boundingBox())!;
      await page.mouse.move(to.x + to.width / 2, to.y + to.height - 8, { steps: 12 });
    }
    for (const [card, code] of [
      [claude, "PERS"],
      [chatgpt, "PERS"],
      [chatgpt, "SBOX"],
    ] as const) {
      await carry(card, code);
      await page.mouse.up();
    }
    await expect(box("PERS").getByRole("listitem")).toHaveCount(2);
    await expect(box("SBOX").getByRole("listitem")).toHaveCount(1);
    await rest();
    await shot(page, "profiles-profiles");

    const chat = await context.newPage();
    try {
      await chat.goto("/");
      await agentChip(chat).click();
      const menu = chat.getByRole("menu");
      const profile = menu.getByRole("group", { name: "Profile", exact: true });
      await profile.getByRole("menuitemradio", { name: "PERS", exact: true }).click();
      const codex = menu.getByRole("group", { name: "Codex", exact: true });
      await expect(codex.getByRole("menuitemradio", { name: "Fake GPT", exact: true })).toBeVisible();
      await expect(menu.getByRole("group", { name: "Claude", exact: true })).toBeVisible();
      await codex.getByRole("menuitemradio", { name: "Fake GPT", exact: true }).click();
      await chat.mouse.move(5, 5);
      await shot(chat, "profiles-codex-picker");
    } finally {
      await chat.close();
    }

    // Pointing at a profile dims the cards it does not hold: Claude's, for SBOX.
    await box("SBOX").hover();
    await expect(subscriptions.locator("article[data-dimmed]")).toHaveCount(1);
    await shot(page, "profiles-hover-profile");

    // Carrying the Claude card: the box that holds it fades and says "added"; the other
    // rings and shows where it would land.
    await carry(claude, "SBOX");
    await expect(box("PERS")).toHaveAttribute("data-added", "");
    await expect(box("SBOX")).toHaveAttribute("data-target", "");
    await shot(page, "profiles-dragging");
    await page.mouse.up();
    await expect(claude.getByText("SBOX")).toBeVisible();

    // The subscription details (TKM-265): one account, then a second added
    // through the same sign-in, then that one signed out. "Used by" names both profiles.
    await subscriptions.getByRole("button", { name: "Claude Pro, Personal details" }).click();
    const details = page.getByRole("region", { name: "Claude Pro details" });
    await expect(details.getByText("personal@example.test")).toBeVisible();
    await expect(details.getByRole("region", { name: "Used by" }).getByRole("listitem")).toHaveCount(2);
    await rest();
    await shot(page, "profiles-details");
    fake.addAccount("anthropic", "work");
    await details.getByRole("button", { name: "Add account" }).click();
    fake.nextSignIn("work");
    const added = await fetch(await signInPage(), { redirect: "manual" });
    await dialog
      .getByRole("textbox", { name: /Address the sign-in ended on/ })
      .fill(added.headers.get("location")!);
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(details.getByText("work@example.test")).toBeVisible();
    await rest();
    await shot(page, "profiles-details-two-accounts");
    await details.getByRole("listitem").filter({ hasText: "work@example.test" }).getByRole("button").click();
    await expect(details.getByText("Signed out")).toBeVisible();
    await rest();
    await shot(page, "profiles-details-signed-out");

    // Back to the cards, and the remove confirmation: it names the profiles that lose it.
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("button", { name: "Profiles" })
      .click();
    await subscriptions.getByRole("button", { name: "Remove Claude Pro, Personal" }).click();
    await expect(dialog.getByText(/PERS/)).toBeVisible();
    await rest();
    await shot(page, "profiles-remove");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  } finally {
    await context.close();
    await fake.stop();
    await unlink(join(folder, ".env.local"));
  }
});
