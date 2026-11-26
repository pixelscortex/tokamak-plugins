type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

function tauri() {
  // The same globals used by @tauri-apps/api/core. Plugin window code cannot
  // import the app's host wrappers; there is no shell capability in the SDK.
  const window = globalThis as typeof globalThis & {
    isTauri?: boolean;
    __TAURI_INTERNALS__?: { invoke?: Invoke };
  };
  const internals = window.__TAURI_INTERNALS__;
  return window.isTauri && typeof internals?.invoke === "function" ? internals : undefined;
}

export const hasDesktopSignIn = () => tauri() !== undefined;

type ReturnResult =
  | { status: "returned"; address: string }
  | { status: "busy" | "cancelled" | "expired" | "unavailable" };

export async function listenForSignInReturn(args: {
  port: number;
  path: string;
  expectedState: string;
  requestId: string;
  timeoutMs: number;
}): Promise<ReturnResult> {
  return (await tauri()?.invoke?.<ReturnResult>("sign_in_return_listen", args)) ?? { status: "unavailable" };
}

export async function cancelSignInReturn(port: number, requestId: string): Promise<void> {
  await tauri()?.invoke?.("sign_in_return_cancel", { port, requestId });
}

export async function openSignInBrowser(url: string): Promise<"opened" | "unavailable"> {
  const desktop = tauri();
  if (!desktop) return "unavailable";
  await desktop.invoke?.("sign_in_open_browser", { url });
  return "opened";
}
