import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { installFakeAgent, startRunner } from "../../fake-agent/local.mjs";

/** What the test desktop adds to the page. */
interface DesktopWindow {
  isTauri: boolean;
  __TAURI_INTERNALS__: unknown;
  __tokamakDesktop(command: string, args: Record<string, unknown>): Promise<unknown>;
  __tokamakDesktopEvent(channel: number, payload: unknown): void;
}

/**
 * Makes the app in `context` run as the desktop app does: the window's Tauri
 * calls are answered by this test process, which starts a private Runner with
 * a disposable workspace and every fake agent's command on its PATH. Returns the person's home folder
 * and the PATH folder holding those commands (unlink one to "uninstall" it).
 */
export async function asDesktop(
  context: BrowserContext,
  options: { plugins?: string; beforeConfirm?: (page: Page) => Promise<void> } = {},
): Promise<{
  home: string;
  bin: string;
  readonly endpoint: { ws: string; token: string };
  /** Reopens the same workspace after the simulated app quit. */
  restart(): Promise<void>;
  /** Quits the app as the menu or Cmd+Q would (app/src-tauri/src/quit.rs). */
  requestQuit(): Promise<void>;
  /** The window's answers so far: "hold", "cancel", "confirm". */
  readonly quitAnswers: readonly string[];
  /** The pages "Open sign-in page" asked the system browser to open, oldest first. */
  readonly opened: readonly string[];
  /** How many times Settings → Plugins asked to reveal the plugins folder. */
  readonly revealed: number;
}> {
  // Inside the run's folder, which the runner removes at the end.
  const plugins = options.plugins ?? process.env.TOKAMAK_PLUGIN_DIR!;
  const scratch = await mkdtemp(join(dirname(process.env.TOKAMAK_PLUGIN_DIR!), "desktop-"));
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  await mkdir(home);
  await installFakeAgent(bin);
  const binary = process.env.TOKAMAK_TEST_RUNNER_BIN!;
  const boot = () =>
    startRunner({
      binary,
      plugins,
      directory: join(scratch, "app-data"),
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    });
  let runner = await boot();
  context.once("close", () => void runner.stop());
  let quitChannel: ((message: unknown) => Promise<void>) | undefined;
  const quitAnswers: string[] = [];
  const opened: string[] = [];
  let revealed = 0;
  /** Return listeners the window opened, each ended by its cancel. */
  const listening = new Map<string, () => void>();

  await context.exposeBinding(
    "__tokamakDesktop",
    async ({ page }, command: string, args: { events: number; url?: string }) => {
      switch (command) {
        case "tokamak_endpoint":
          return runner.endpoint;
        case "quit_listen": {
          let index = 0;
          quitChannel = (message) =>
            page.evaluate(
              ([id, payload]) => (window as unknown as DesktopWindow).__tokamakDesktopEvent(id, payload),
              [args.events, { index: index++, message }] as const,
            );
          return null;
        }
        case "quit_hold":
        case "quit_cancel":
          quitAnswers.push(command.slice("quit_".length));
          return null;
        case "quit_confirm":
          await options.beforeConfirm?.(page);
          await runner.stop();
          quitAnswers.push("confirm");
          return null;
        // The sign-in return (app/src-tauri/src/sign_in_return.rs): the test desktop opens no
        // browser, and its listener waits until cancelled without a return ever coming, so the
        // dialog shows the desktop's wording and the test finishes each sign-in by pasting.
        case "reveal_plugins_folder":
          revealed++;
          return null;
        case "sign_in_open_browser":
          opened.push(args.url!);
          return "opened";
        case "sign_in_return_listen": {
          const { requestId } = args as unknown as { requestId: string };
          return new Promise((done) => listening.set(requestId, () => done({ status: "cancelled" })));
        }
        case "sign_in_return_cancel": {
          const { requestId } = args as unknown as { requestId: string };
          listening.get(requestId)?.();
          listening.delete(requestId);
          return null;
        }
        default:
          throw new Error(`The test desktop has no ${command}`);
      }
    },
  );

  await context.addInitScript(() => {
    const callbacks = new Map<number, (payload: unknown) => void>();
    let id = 0;
    const scope = window as unknown as DesktopWindow;
    scope.isTauri = true;
    // Desktop tests open their target view directly instead of going through the welcome page.
    localStorage.setItem("tokamak.welcomed", "1");
    scope.__tokamakDesktopEvent = (channel: number, payload: unknown) => callbacks.get(channel)?.(payload);
    scope.__TAURI_INTERNALS__ = {
      transformCallback(callback: (payload: unknown) => void) {
        callbacks.set(++id, callback);
        return id;
      },
      unregisterCallback(channel: number) {
        callbacks.delete(channel);
      },
      invoke(command: string, args: Record<string, unknown> = {}) {
        // A Channel travels as its callback id, as Tauri serialises it.
        const plain = Object.fromEntries(
          Object.entries(args).map(([key, value]) => [
            key,
            value && typeof value === "object" && "toJSON" in value
              ? (value as unknown as { id: number }).id
              : value,
          ]),
        );
        return scope.__tokamakDesktop(command, plain);
      },
    };
  });
  return {
    home,
    bin,
    get endpoint() {
      return runner.endpoint;
    },
    async restart() {
      await runner.stop();
      runner = await boot();
    },
    async requestQuit() {
      if (!quitChannel) throw new Error("The window is not listening for quit");
      await quitChannel({ type: "quit" });
    },
    quitAnswers,
    opened,
    get revealed() {
      return revealed;
    },
  };
}
