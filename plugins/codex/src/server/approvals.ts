import type { Answer, Question, Run } from "plugin:ai/contracts";
import { asError, isRecord, type AppServer, type Params, type RpcId } from "./rpc";

const decisions = {
  approve: "accept",
  approveSession: "acceptForSession",
  decline: "decline",
  cancel: "cancel",
} as const;

type ApprovalKind = "command" | "patch" | "permissions";
const approvalKinds = new Map<string, ApprovalKind>([
  ["item/commandExecution/requestApproval", "command"],
  ["item/fileChange/requestApproval", "patch"],
  ["item/permissions/requestApproval", "permissions"],
]);

/** Reply to server requests without blocking the stdout reader. Stop and
 * serverRequest/resolved still need to work while the person is thinking. */
export function approvals(app: AppServer, run: Pick<Run, "access" | "ask">) {
  const active = new Set<RpcId>();
  let stopped = false;
  let cancelled = false;
  let fail!: (cause: Error) => void;
  const failed = new Promise<Error>((resolve) => (fail = resolve));
  let queue = Promise.resolve();

  return {
    failed,
    cancelled: () => cancelled,
    resolved(id: unknown) {
      if (typeof id === "string" || typeof id === "number") active.delete(id);
    },
    close() {
      stopped = true;
      active.clear();
    },
    request(id: RpcId, method: string, params: Params) {
      const kind = approvalKinds.get(method);
      if (!kind) {
        app.reject(id, "This Codex request is not supported by Tokamak");
        return;
      }
      active.add(id);
      queue = queue
        .then(async () => {
          if (stopped || !active.has(id)) return;
          let answer: Answer = "approve";
          if (run.access === "ask") {
            const question = await describeQuestion(kind, params);
            if (stopped || !active.has(id)) return;
            answer = await run.ask(question);
          }
          if (stopped || !active.delete(id)) return;
          if (answer === "cancel") cancelled = true;
          if (kind === "permissions") {
            app.answer(id, permissionGrant(params, answer));
            if (answer === "cancel" && typeof params.turnId === "string")
              await app.call("turn/interrupt", { threadId: params.threadId, turnId: params.turnId });
          } else {
            app.answer(id, { decision: decisions[answer] ?? "decline" });
          }
        })
        .catch((cause) => fail(asError(cause)));
    },
  };
}

function describeQuestion(kind: ApprovalKind, params: Params): Promise<Question> {
  if (isRecord(params.networkApprovalContext)) {
    const { host, protocol } = params.networkApprovalContext;
    return question("access", typeof host === "string" ? host : "the network", [protocol, host]);
  }
  if (kind === "command" && typeof params.command === "string")
    return question("run", params.command, [params.cwd, params.command, params.additionalPermissions]);
  if (kind === "patch" && typeof params.grantRoot === "string")
    return question("edit", params.grantRoot, [params.grantRoot]);

  const { action, defaultSubject } = {
    command: { action: "run", defaultSubject: "a command" },
    patch: { action: "edit", defaultSubject: "file changes" },
    permissions: { action: "grant", defaultSubject: "additional permissions" },
  }[kind];
  return question(action, typeof params.reason === "string" ? params.reason : defaultSubject, [
    params.itemId,
    params.permissions,
  ]);
}

async function question(action: string, subject: string, scope: unknown[]): Promise<Question> {
  // Remember only the same command in the same directory, or the same
  // permission scope. Hash it so the remembered key doesn't contain arguments.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(scope)));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { kind: `codex:${action}:${hash}`, action, subject };
}

function permissionGrant(params: Params, answer: Answer): Params {
  const approved = answer === "approve" || answer === "approveSession";
  const requested = approved && isRecord(params.permissions) ? params.permissions : {};
  return {
    permissions: Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== null)),
    scope: answer === "approveSession" ? "session" : "turn",
  };
}
