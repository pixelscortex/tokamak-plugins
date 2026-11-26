import { TIMED_OUT, within, type CallerActionContext, type RunningProcess } from "@tokamak/sdk";

const CLOSE_GRACE_MS = 2_000;

/** Codex app-server uses newline-delimited JSON-RPC without the jsonrpc field. */
export type RpcId = number | string;
export type Params = Record<string, unknown>;
export type Event = { method: string; params: Params; id?: RpcId };

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export class AppServer {
  readonly #process: RunningProcess;
  readonly #pending = new Map<RpcId, Pending>();
  #failure?: Error;
  #next = 0;
  #onEvent?: (event: Event) => void;
  readonly closed: Promise<Error>;

  constructor(
    ctx: CallerActionContext,
    cwd?: string,
    launch?: { args: readonly string[]; env: Readonly<Record<string, string>> },
  ) {
    // Omit env: ctx.proc would replace the client's environment and lose the
    // user's PATH, home, and any forwarded CODEX_HOME.
    const process = launch
      ? ctx.proc(["codex", "app-server", ...launch.args], { cwd, env: launch.env })
      : ctx.proc(["codex", "app-server"], cwd === undefined ? undefined : { cwd });
    this.#process = process;
    void this.#process.exited.catch(() => {});
    // Drain stderr; Codex may print credentials or private paths in logs.
    void (async () => {
      for await (const _line of process.stderr) {
        // Only protocol messages from stdout reach the thread.
      }
    })().catch(() => {});
    this.closed = this.#read();
  }

  async initialize(timeout?: number) {
    await this.call(
      "initialize",
      {
        clientInfo: { name: "tokamak", title: "Tokamak", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
      timeout,
    );
    this.#write({ method: "initialized" });
  }

  listen(handler: (event: Event) => void) {
    this.#onEvent = handler;
  }

  async call<Result>(method: string, params: Params, timeout = 30_000): Promise<Result> {
    if (this.#failure) throw this.#failure;
    const id = ++this.#next;
    const answer = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    const timer = setTimeout(
      () => this.#pending.get(id)?.reject(new Error(`Codex did not answer ${method}`)),
      timeout,
    );
    try {
      this.#write({ id, method, params });
      return (await answer) as Result;
    } finally {
      clearTimeout(timer);
      this.#pending.delete(id);
    }
  }

  answer(id: RpcId, result: Params) {
    this.#write({ id, result });
  }

  reject(id: RpcId, message: string) {
    this.#write({ id, error: { code: -32601, message } });
  }

  stop() {
    this.#process.stop();
  }

  async close() {
    this.#process.closeInput();
    const exited = this.#process.exited.catch(() => undefined);
    // Let app-server flush the session on EOF before a queued turn resumes it.
    if ((await within(exited, CLOSE_GRACE_MS)) === TIMED_OUT) {
      this.#process.stop("SIGKILL");
      await exited;
    }
  }

  #write(frame: Params) {
    if (this.#failure) throw this.#failure;
    this.#process.write(JSON.stringify(frame) + "\n");
  }

  async #read(): Promise<Error> {
    let error: Error;
    try {
      for await (const line of this.#process.stdout) {
        if (!line.trim()) continue;
        const frame: unknown = JSON.parse(line);
        if (!isRecord(frame)) throw new Error("Invalid Codex app-server message");
        const { id, method, params } = frame;
        const requestId = typeof id === "number" || typeof id === "string" ? id : undefined;
        if (typeof method === "string") {
          const event = { method, params: isRecord(params) ? params : {}, id: requestId };
          if (this.#onEvent) this.#onEvent(event);
          else if (requestId !== undefined) this.reject(requestId, "Tokamak is not running a turn");
        } else if (requestId !== undefined) {
          const pending = this.#pending.get(requestId);
          if (isRecord(frame.error)) {
            pending?.reject(
              new RpcError(
                typeof frame.error.code === "number" ? frame.error.code : -32603,
                typeof frame.error.message === "string" ? frame.error.message : "Codex request failed",
              ),
            );
          } else {
            pending?.resolve(frame.result);
          }
        }
      }
      error = new Error("Codex app-server closed before the request or turn ended");
    } catch (cause) {
      error = cause instanceof SyntaxError ? new Error("Invalid JSON from Codex app-server") : asError(cause);
    }
    this.#failure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    return error;
  }
}

export function isRecord(value: unknown): value is Params {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function lookup<T>(values: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === "string" && Object.hasOwn(values, key) ? values[key] : undefined;
}

export function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
