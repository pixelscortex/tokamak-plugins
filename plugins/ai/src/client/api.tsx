/**
 * ai's window entry: it extends chat through the elements chat publishes and
 * imports no agent plugin. Agents reach `ai` only through `plugin:ai/contracts`.
 */
import { after, append, before, prepend, layer, useClient } from "@tokamak/sdk/client";
import { Show } from "solid-js";
import * as chat from "plugin:chat/client";
import { AgentRow } from "./ui/agent-row";
import { SteeredBody } from "./ui/turn-steers";
import { hasSteers } from "./lib/steers";
import { StopButton } from "./ui/turn-controls";
import { refreshAgents } from "./lib/agents";
import { newThreadChoices } from "./lib/choices";
import { ReplyCards } from "./ui/reply-cards";
import { ReplyHeader } from "./ui/reply-header";
import { ReplyWork } from "./ui/reply-work";
import { isAgentReply, shownTurn } from "./lib/replies";
import { PermissionCard } from "./ui/permission-card";
import { activeFor } from "./lib/turn-controls";
import { listenForSends } from "./lib/turn";
import { questionFor } from "./lib/questions";
import { isWorking, statusOf } from "./lib/thread-status";
import { ThreadDetail, ThreadHelpers, ThreadStatusIcon } from "./ui/thread-status";

listenForSends();

/** The agent row sits under the composer box, inside the composer's tray. */
export const Agent = after(chat.find("box"), AgentRow);
/** "What should Claude work on?" in place of "Start a conversation". */
export const Heading = layer(chat.find("heading"), (_props, Original) => {
  void refreshAgents(useClient());
  return (
    <Show when={newThreadChoices()?.agent} fallback={<Original />}>
      {(agent) => <Original>What should {agent().name} work on?</Original>}
    </Show>
  );
});
/** The permission question, on the composer's tray above the prompt, while the sender's turn waits. */
export const Permission = prepend(chat.find("top"), PermissionCard, {
  when: (composer) => questionFor(composer.threadId) !== undefined,
});

/** An agent's reply: "✳ Claude  opus 5.5" in place of chat's author line. */
export const ReplyAuthor = layer(chat.find("header"), ReplyHeader, { when: isAgentReply });
/** Above the reply's text: thinking, the actions line and helper rows. */
export const Work = before(chat.find("body"), ReplyWork, { when: isAgentReply });
/** Under the reply's text: Tasks, the plan card and usage. */
export const Cards = after(chat.find("body"), ReplyCards, { when: isAgentReply });
export const Stop = layer(chat.find("SendButton"), StopButton, {
  when: (props) => Boolean(activeFor(props.threadId)),
});

/**
 * A reply the person steered: its text cut where each follow-up arrived, the
 * follow-up drawn between as their own message. Other replies keep chat's body.
 */
export const Steers = layer(chat.find("body"), SteeredBody, {
  when: (props) => isAgentReply(props) && hasSteers(shownTurn(props)),
});

/** The status icon before each thread's title in chat's list. */
export const ThreadStatus = prepend(chat.find("status"), ThreadStatusIcon);
/** The second line (agent, model, folder), only while the thread's turn runs or waits. */
export const ThreadWork = append(chat.find("detail"), ThreadDetail, {
  when: (row) => isWorking(statusOf(row.thread._id)),
});
/** The working turn's helper agents, as small rows under the thread. */
export const Helpers = after(chat.find("detail"), ThreadHelpers, {
  when: (row) => isWorking(statusOf(row.thread._id)) && (statusOf(row.thread._id)?.helpers.length ?? 0) > 0,
});

export { hasLiveThreadDetail, SavedAgentDetail } from "./ui/thread-status";
