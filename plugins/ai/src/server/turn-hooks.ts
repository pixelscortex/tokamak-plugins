import { isFailure, type CallerActionContext } from "@tokamak/sdk";
import { turnHooks, type TurnHooks, type TurnInfo } from "../contracts";
import { errorText } from "../shared/turn-shared";

const HOOK_DEADLINE_MS = 60_000;
const BEFORE_TIMEOUT = "The turn could not start: a before hook timed out.";
const AFTER_TIMEOUT = "A turn after hook timed out.";
const AFTER_INTERRUPTED = "A turn after hook was interrupted.";

export function hooksFor(ctx: CallerActionContext, turn: Omit<TurnInfo, "signal">) {
  const controller = new AbortController();
  const input: TurnInfo = { ...turn, signal: controller.signal };
  const notices = new Set<string>();
  const pending = new Set<TurnHooks>();
  let beforeCalls: AbortController | undefined;
  let interrupt: ((reason: string) => void) | undefined;
  let stopped = false;

  function afterNotice(fallback: string) {
    return (
      [...new Set([...pending].map((hook) => hook.afterTimeoutNotice ?? fallback))].join("\n") || fallback
    );
  }

  function cancel(reason: string) {
    interrupt?.(reason);
    beforeCalls?.abort();
    controller.abort();
  }

  function notice() {
    return notices.size ? [...notices].join("\n") : undefined;
  }

  async function withinDeadline<T>(operation: () => T | Promise<T>, timeout: () => string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          interrupt = (reason) => reject(new Error(reason));
          timer = setTimeout(() => cancel(timeout()), HOOK_DEADLINE_MS);
        }),
        Promise.resolve().then(operation),
      ]);
    } finally {
      clearTimeout(timer);
      interrupt = undefined;
    }
  }

  const lookup = (signal = input.signal) =>
    turnHooks.list(ctx, {
      signal,
      inputSignal: input.signal,
      onUnavailable: ({ message, notice }) => notices.add(notice ?? message),
    });

  return {
    async before(): Promise<string | undefined> {
      const calls = (beforeCalls = new AbortController());
      try {
        const timeout = () => BEFORE_TIMEOUT;
        const hooks = await withinDeadline(() => lookup(calls.signal), timeout);
        for (const hook of hooks) {
          if (calls.signal.aborted) break;
          if (!hook.before) continue;
          const result = await withinDeadline(() => hook.before?.(input), timeout);
          if (calls.signal.aborted) break;
          if (!isFailure(result)) continue;
          const data = result.data;
          if (typeof data === "object" && data && "reason" in data && typeof data.reason === "string") {
            return data.reason;
          }
          return `The turn could not start: ${result.kind}`;
        }
      } catch (cause) {
        if (!stopped) return errorText(cause);
      } finally {
        beforeCalls = undefined;
      }
    },
    async after(): Promise<string | undefined> {
      if (input.signal.aborted) return notice();
      try {
        // Every after hook starts together and has the same deadline.
        await withinDeadline(
          async () => {
            // Refresh the route for providers rebuilt while the agent ran.
            for (const hook of await lookup()) if (hook.after) pending.add(hook);
            if (input.signal.aborted) return;
            await Promise.all(
              [...pending].map(async (hook) => {
                try {
                  await hook.after?.(input);
                } catch (cause) {
                  if (!input.signal.aborted) notices.add(errorText(cause));
                } finally {
                  pending.delete(hook);
                }
              }),
            );
          },
          () => afterNotice(AFTER_TIMEOUT),
        );
      } catch (cause) {
        notices.add(errorText(cause));
      }
      return notice();
    },
    notice,
    get stoppedBefore() {
      return stopped;
    },
    stopBefore() {
      if (beforeCalls) {
        stopped = true;
        beforeCalls.abort();
      }
    },
    cancel,
    skipAfter() {
      if (interrupt) cancel(afterNotice(AFTER_INTERRUPTED));
      else controller.abort();
    },
  };
}
