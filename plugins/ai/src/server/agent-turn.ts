import {
  AGENT_TURN_PROTOCOL,
  agentTurnHistory,
  checkedHelper,
  checkedTasks,
  checkedText,
  checkedTool,
  checkedUsage,
  openLocalChannel,
} from "@tokamak/sdk/agent-turn";
import type {
  AgentTurnAsk,
  AgentTurnReport,
  AgentTurnStart,
  Question,
  TurnAddress,
  TurnAnswer,
  TurnResult,
} from "@tokamak/sdk/agent-turn";
import type { Agent, Run } from "../contracts";
import type { turnControl } from "./controls";

type Questions = { ask(question: Question): Promise<TurnAnswer>; cancel(): Promise<void>; expire(): void };
type Control = ReturnType<typeof turnControl>;
type Reports = Pick<
  Run,
  "text" | "thinking" | "plan" | "tasks" | "tool" | "helper" | "usage" | "sessionChanged"
>;
const FORCE_DRAIN_MS = 750;

function channelEnded(error: unknown): boolean {
  return error instanceof Error && error.message === "Local contract channel ended";
}

/** A linked start owns every message of one turn, even across an agent reload. */
export function startAgent(
  provider: Agent,
  request: AgentTurnStart,
  reports: Reports,
  questions: Questions,
  control: Control,
) {
  const { threadId, turnId } = request;
  // The server budgets the history without seeing the caller's launch settings.
  const history = request.launchSettings ? agentTurnHistory(request) : request.history;
  if (!history) throw new Error("The prompt and launch settings do not fit in the agent turn.");
  const address: TurnAddress = { threadId, turnId };
  let accepting = true;
  const channel = openLocalChannel(
    provider,
    "start",
    { ...request, history, version: AGENT_TURN_PROTOCOL },
    async (method, value) => {
      const target = value as unknown as TurnAddress;
      if (!accepting || target?.threadId !== threadId || target.turnId !== turnId)
        return method === "ask" ? "cancel" : null;
      switch (method) {
        case "ask":
          return questions.ask((value as unknown as AgentTurnAsk).question);
        case "report":
          applyReports((value as unknown as AgentTurnReport).events, reports, () =>
            control.onSteer(async (text) => {
              await channel!.send("steer", { ...address, text });
            }),
          );
          return null;
        default:
          throw new Error(`Unknown agent turn message: ${method}`);
      }
    },
  );
  if (!channel) throw new Error("The agent does not provide a turn channel");

  control.onStop(async () => {
    await channel.send("stop", { ...address });
  });
  let forcing = false;
  let ended = false;
  const result = channel.result
    .then(
      (value) => (forcing ? undefined : (value as unknown as TurnResult)),
      (error: unknown) => {
        if (forcing) return undefined;
        const prefix = `Too many ${provider.id} turns are running (`;
        if (error instanceof Error && error.message.startsWith(prefix))
          throw new Error(
            `Too many ${provider.name} turns are running (${error.message.slice(prefix.length)}`,
          );
        throw error;
      },
    )
    .finally(() => {
      ended = true;
      accepting = false;
      questions.expire();
    });
  return control.run(
    () => result,
    async () => {
      forcing = true;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!ended) {
          await questions.cancel();
          // A responsive provider seals and flushes its reports before the native kill.
          await Promise.race([
            channel.send("forceStop", { ...address }).catch(() => {}),
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, FORCE_DRAIN_MS);
            }),
          ]);
        }
        await channel.stopPrograms();
      } catch (error) {
        if (!ended && !channelEnded(error)) throw error;
      } finally {
        clearTimeout(timeout);
        accepting = false;
        await channel.close().catch((error: unknown) => {
          if (!channelEnded(error)) throw error;
        });
      }
    },
  );
}

function validateReports(events: AgentTurnReport["events"]) {
  if (!Array.isArray(events)) throw new TypeError("Invalid agent turn report batch");
  // Validate the whole batch before a report can write to the thread or
  // register a control. The writer still checks its own inputs.
  for (const event of events) {
    switch (event?.kind) {
      case "text":
      case "thinking":
      case "plan":
        checkedText(event.value, `invalid ${event.kind} report`);
        break;
      case "tasks":
        checkedTasks(event.value);
        break;
      case "tool":
        checkedTool(event.value);
        break;
      case "helper":
        checkedHelper(event.value);
        break;
      case "usage":
        checkedUsage(event.value);
        break;
      case "session":
        if (event.value !== null) checkedText(event.value, "invalid session report");
        break;
      case "steerReady":
        break;
      default:
        throw new Error(`Unknown agent turn report event: ${(event as { kind?: unknown })?.kind}`);
    }
  }
}

function applyReports(events: AgentTurnReport["events"], reports: Reports, steerReady: () => void) {
  validateReports(events);
  for (const event of events) {
    switch (event.kind) {
      case "text":
        reports.text(event.value);
        break;
      case "thinking":
        reports.thinking(event.value);
        break;
      case "plan":
        reports.plan(event.value);
        break;
      case "tasks":
        reports.tasks(event.value);
        break;
      case "tool":
        reports.tool(event.value);
        break;
      case "helper":
        reports.helper(event.value);
        break;
      case "usage":
        reports.usage(event.value);
        break;
      case "session":
        reports.sessionChanged(event.value ?? undefined);
        break;
      case "steerReady":
        steerReady();
        break;
    }
  }
}
