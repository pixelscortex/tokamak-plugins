import type { CallerActionContext } from "@tokamak/sdk";
import type { Run, TurnResult } from "plugin:ai/contracts";
import { approvals } from "./approvals";
import { turnHelpers } from "./helpers";
import { turnReports } from "./reports";
import { AppServer, isRecord, RpcError, type Event } from "./rpc";

type Thread = {
  thread: { id: string };
  model: string;
  reasoningEffort: string | null;
  collaborationMode?: { mode: "default" | "plan" };
};
type Turn = { id: string; status: string; error?: { message?: string } | null };
function input(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

export async function codexTurn(
  ctx: CallerActionContext,
  run: Run,
  launch?: ConstructorParameters<typeof AppServer>[2],
): Promise<TurnResult> {
  const app = new AppServer(ctx, run.folder, launch);
  const controls = registerTurnControls(app, run);
  let mustFlushSession = false;
  try {
    await app.initialize();
    const early: Event[] = [];
    app.listen((event) => early.push(event));
    const { thread, resumed } = await openThread(app, run);
    const sessionId = thread.thread.id;
    // Injected history can be buffered in the session file. A failed
    // handshake with no recorded work only needs a stop.
    mustFlushSession = !resumed && run.history.length > 0;
    run.sessionChanged(sessionId);
    app.listen((event) => {
      // A deployed app-server may notify turn/started before it answers turn/start.
      if (event.method === "turn/started" && event.params.threadId === sessionId) {
        const turn = event.params.turn;
        if (isRecord(turn) && typeof turn.id === "string") controls.bind({ sessionId, turnId: turn.id });
      }
      early.push(event);
    });
    // Once the turn is submitted Codex may record it before any event
    // arrives, so a failure from here on waits for the app-server to exit.
    mustFlushSession = true;
    const { turn } = await app.call<{ turn: Turn }>("turn/start", turnSettings(run, thread));
    controls.bind({ sessionId, turnId: turn.id });
    return await waitForTurn(app, run, sessionId, turn, resumed, early, controls);
  } finally {
    controls.close();
    if (mustFlushSession || launch) await app.close();
    else app.stop();
  }
}

function turnSettings(run: Run, thread: Thread) {
  // Explicit Default clears a previous Plan mode on resume.
  const mode = run.mode === "plan" ? "plan" : "default";
  return {
    threadId: thread.thread.id,
    input: input(run.prompt),
    ...(run.effort ? { effort: run.effort } : {}),
    ...(run.speed ? { serviceTierForTurn: run.speed } : {}),
    ...(mode !== "default" || thread.collaborationMode?.mode === "plan"
      ? {
          collaborationMode: {
            mode,
            settings: {
              model: thread.model,
              reasoning_effort: run.effort ?? thread.reasoningEffort,
              developer_instructions: null,
            },
          },
        }
      : {}),
    summary: "auto",
  };
}

function registerTurnControls(app: AppServer, run: Run) {
  type Target = { sessionId: string; turnId: string };
  let bind!: (target?: Target) => void;
  const ready = new Promise<Target | undefined>((resolve) => (bind = resolve));
  let stopped = false;
  let closed = false;
  async function control(method: "turn/steer" | "turn/interrupt", text?: string) {
    const target = await ready;
    if (!target || closed) return;
    const { sessionId: threadId, turnId } = target;
    try {
      await app.call(
        method,
        method === "turn/steer"
          ? { threadId, expectedTurnId: turnId, input: input(text ?? "") }
          : { threadId, turnId },
      );
    } catch (cause) {
      if (!closed) throw cause;
    }
  }
  run.onSteer((text) => (closed || stopped ? Promise.resolve() : control("turn/steer", text)));
  run.onStop(async () => {
    if (closed || stopped) return;
    stopped = true;
    await control("turn/interrupt");
  });
  return {
    bind,
    stopped: () => stopped,
    close() {
      closed = true;
      bind();
    },
  };
}

async function waitForTurn(
  app: AppServer,
  run: Run,
  sessionId: string,
  turn: Turn,
  resumed: boolean,
  early: Event[],
  controls: ReturnType<typeof registerTurnControls>,
): Promise<TurnResult> {
  const reports = turnReports(run, resumed);
  const helpers = turnHelpers(app, sessionId, (helper) => run.helper(helper));
  const permission = approvals(app, run);
  let finish!: (turn: Turn) => void;
  const completed = new Promise<Turn>((resolve) => (finish = resolve));
  let finished = false;
  let error: string | undefined;
  function dispatch({ id, method, params }: Event) {
    const ownThread = params.threadId === sessionId;
    const ownTurn = ownThread && (params.turnId === undefined || params.turnId === turn.id);
    const helper =
      typeof params.threadId === "string" && helpers.has(params.threadId) ? params.threadId : undefined;
    if (id !== undefined) {
      if ((ownTurn || helper) && !finished) permission.request(id, method, params);
      else app.reject(id, "No matching Tokamak turn");
      return;
    }
    if (finished) return;
    if (method === "thread/started" && isRecord(params.thread)) helpers.thread(params.thread);
    if ((ownTurn || helper) && method === "serverRequest/resolved") permission.resolved(params.requestId);
    // The parent's helper item is its report. Do not stream the child thread's own work into this reply.
    if (helper) helpers.childEvent(helper, method, params);
    if (!ownThread) return;
    if (!ownTurn) {
      if (method === "thread/tokenUsage/updated") reports.previousUsage(params);
      return;
    }
    if ((method === "item/started" || method === "item/completed") && isRecord(params.item))
      helpers.parentItem(params.item);
    if (method === "error" && params.willRetry === false && isRecord(params.error))
      error = typeof params.error.message === "string" ? params.error.message : error;
    if (method === "turn/completed" && isRecord(params.turn) && params.turn.id === turn.id) {
      finished = true;
      controls.close();
      permission.close();
      finish(params.turn as Turn);
      return;
    }
    reports.report(method, params);
  }
  const raise = (cause: Error): never => {
    throw cause;
  };
  let result: Turn | undefined;
  try {
    app.listen(dispatch);
    for (const event of early) dispatch(event);
    early.length = 0;
    result = await Promise.race([completed, permission.failed.then(raise), app.closed.then(raise)]);
  } finally {
    permission.close();
    await helpers.finish(result?.status === "completed" ? "done" : "failed");
  }
  if (result.status === "interrupted" && (controls.stopped() || permission.cancelled()))
    return { sessionId, stopped: true };
  if (result.status !== "completed")
    throw new Error(result.error?.message ?? error ?? `Codex turn ${result.status}`);
  return { sessionId };
}

async function openThread(app: AppServer, run: Run) {
  const options = {
    cwd: run.folder,
    ...(run.model !== "default" && { model: run.model }),
    ...(run.access === "full"
      ? { sandbox: "danger-full-access", approvalPolicy: "never" }
      : // Ask first: writes inside the folder are allowed by the sandbox, so an approved
        // command or edit actually lands; "untrusted" still asks before anything beyond safe reads.
        { sandbox: "workspace-write", approvalPolicy: "untrusted", approvalsReviewer: "user" }),
  };
  if (run.sessionId) {
    try {
      const thread = await app.call<Thread>("thread/resume", {
        ...options,
        threadId: run.sessionId,
        excludeTurns: true,
      });
      return { thread, resumed: true };
    } catch (cause) {
      run.sessionChanged(undefined);
      // Starting again after any other error could drop history or hide a policy failure.
      if (
        !(
          cause instanceof RpcError &&
          cause.code === -32600 &&
          /^no rollout found for thread id\b/i.test(cause.message)
        )
      )
        throw cause;
    }
  }
  const thread = await app.call<Thread>("thread/start", options);
  if (run.history.length) {
    await app.call("thread/inject_items", {
      threadId: thread.thread.id,
      items: run.history.map(({ role, name, text }) => ({
        type: "message",
        role: role === "agent" ? "assistant" : "user",
        content: [{ type: role === "agent" ? "output_text" : "input_text", text: `${name}: ${text}` }],
      })),
    });
  }
  return { thread, resumed: false };
}
