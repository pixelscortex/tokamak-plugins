import type { Run, Task, Tool, Usage } from "plugin:ai/contracts";
import { isRecord, lookup, type Params } from "./rpc";

export function turnReports(run: Run, resumed: boolean) {
  const streamed = new Set<string>();
  const summaries = new Set<string>();
  const plans = new Map<string, string>();
  let thinkingBlock: { itemId: string; part: number } | undefined;
  let messageItem: string | undefined;
  /** A steer or a tool call ends one message and starts another. Keep them apart in the reply. */
  function message(itemId: string, text: string) {
    if (messageItem !== undefined && messageItem !== itemId) run.text("\n\n");
    messageItem = itemId;
    run.text(text);
  }
  let baseline: Usage | undefined;
  let previous: Usage | undefined;
  return {
    /** Codex counts the entire session. A resume can replay the previous
     * turn's cumulative usage before emitting the new turn's counts. */
    previousUsage(params: Params) {
      previous = readUsage(params) ?? previous;
    },
    report(method: string, params: Params) {
      const { delta, itemId } = params;
      switch (method) {
        case "item/agentMessage/delta":
          if (typeof itemId === "string" && typeof delta === "string") {
            streamed.add(itemId);
            if (delta) message(itemId, delta);
          }
          break;
        case "item/reasoning/summaryTextDelta":
          if (typeof itemId === "string" && typeof delta === "string" && delta) {
            summaries.add(itemId);
            const part = typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
            think(itemId, part, delta);
          }
          break;
        case "item/plan/delta":
          if (typeof itemId === "string" && typeof delta === "string") {
            const plan = (plans.get(itemId) ?? "") + delta;
            plans.set(itemId, plan);
            run.plan(plan);
          }
          break;
        case "turn/plan/updated":
          if (Array.isArray(params.plan)) {
            run.tasks(
              params.plan.flatMap((step): Task[] =>
                isRecord(step) && typeof step.step === "string"
                  ? [
                      {
                        text: step.step,
                        state: lookup(taskStates, step.status) ?? "pending",
                      },
                    ]
                  : [],
              ),
            );
          }
          break;
        case "thread/tokenUsage/updated": {
          const total = readUsage(params);
          if (!total) break;
          // The last field is only the last model request, not the whole turn. If
          // a resume did not replay its previous usage, use the first observed total.
          baseline ??= resumed ? (previous ?? total) : ZERO;
          run.usage(subtract(total, baseline));
          break;
        }
        case "item/started":
        case "item/completed": {
          const completed = method === "item/completed";
          const item = params.item;
          if (!isRecord(item) || typeof item.id !== "string") break;
          if (item.type === "agentMessage") {
            if (completed && !streamed.has(item.id) && typeof item.text === "string" && item.text)
              message(item.id, item.text);
          } else if (item.type === "reasoning") {
            if (completed && !summaries.has(item.id) && Array.isArray(item.summary)) {
              for (const [index, part] of item.summary.entries()) {
                if (typeof part === "string" && part) think(item.id, index, part);
              }
            }
          } else if (item.type === "plan") {
            if (completed && typeof item.text === "string") run.plan(item.text);
            if (completed) plans.delete(item.id);
          } else {
            for (const tool of describeTools(item, item.id, completed)) run.tool(tool);
          }
          break;
        }
      }
    },
  };

  function think(itemId: string, part: number, delta: string) {
    if (thinkingBlock && (thinkingBlock.itemId !== itemId || thinkingBlock.part !== part))
      run.thinking("\n\n");
    thinkingBlock = { itemId, part };
    run.thinking(delta);
  }
}

const taskStates = { pending: "pending", inProgress: "running", completed: "done" } as const;
const executionStates = {
  inProgress: "running",
  completed: "done",
  failed: "failed",
  declined: "failed",
} as const;
const callStates = { inProgress: "running", completed: "done", failed: "failed" } as const;

const ZERO = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

function readUsage(params: Params): Usage | undefined {
  const breakdown = isRecord(params.tokenUsage) ? params.tokenUsage.total : undefined;
  if (
    !isRecord(breakdown) ||
    typeof breakdown.inputTokens !== "number" ||
    typeof breakdown.outputTokens !== "number"
  )
    return;
  return {
    inputTokens: breakdown.inputTokens,
    outputTokens: breakdown.outputTokens,
    cachedInputTokens: typeof breakdown.cachedInputTokens === "number" ? breakdown.cachedInputTokens : 0,
  };
}

function subtract(total: Usage, previous: Usage): Usage {
  return {
    inputTokens: Math.max(0, total.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - previous.outputTokens),
    cachedInputTokens: Math.max(0, (total.cachedInputTokens ?? 0) - (previous.cachedInputTokens ?? 0)),
  };
}

function titleOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function describeTools(item: Params, id: string, completed: boolean): Tool[] {
  const terminal = completed ? "done" : "running";
  switch (item.type) {
    case "commandExecution":
      return [
        {
          id,
          kind: "command",
          title: titleOf(item.command, "Command"),
          state: lookup(executionStates, item.status) ?? terminal,
        },
      ];
    case "fileChange": {
      const state = lookup(executionStates, item.status) ?? terminal;
      // One patch can touch several files, and completion can list them in a different order.
      return Array.isArray(item.changes)
        ? item.changes.flatMap((change) =>
            isRecord(change) && typeof change.path === "string"
              ? [{ id: `${id}:${change.path}`, kind: "edit", title: change.path, state }]
              : [],
          )
        : [];
    }
    case "mcpToolCall":
      return [
        {
          id,
          kind: "other",
          title: `${titleOf(item.server, "MCP")}: ${titleOf(item.tool, "Tool")}`,
          state: lookup(callStates, item.status) ?? terminal,
        },
      ];
    case "dynamicToolCall":
      return [
        {
          id,
          kind: "other",
          title: titleOf(item.tool, "Tool"),
          state: lookup(callStates, item.status) ?? terminal,
        },
      ];
    case "webSearch":
      return [{ id, kind: "web", title: titleOf(item.query, "Web search"), state: terminal }];
    default:
      return [];
  }
}
