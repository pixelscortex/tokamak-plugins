import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useClient } from "@tokamak/sdk/client";
import type { MessageProps } from "plugin:chat/client";
import { modelLabel } from "../lib/agents";
import { useTurn } from "../lib/replies";
import { AgentMark } from "./agent-mark";

/**
 * Above an agent's reply: the agent's mark and the model the turn used, and
 * nothing else ("✳ Fable 5.2"): the mark already names the agent, so its name
 * is not repeated, and there is no persona and no time (Paper "Stage ·
 * thread", agent header). The mark's label names the agent for screen readers.
 */
export function ReplyHeader(props: MessageProps): JSX.Element {
  const turn = useTurn(useClient(), props);
  const agentName = () => turn()?.agent.name ?? props.message.author?.name;
  const model = () => modelLabel(agentName(), turn()?.modelName ?? turn()?.model);
  return (
    <header role="group" aria-label="Reply from" class="flex h-5 items-center gap-2">
      <AgentMark
        agentId={turn()?.agent.id ?? props.message.author?.id.replace(/^agent:/, "")}
        modelId={turn()?.model}
        label={agentName()}
        class="text-ink"
      />
      <Show when={model()} fallback={<span class="text-label text-ink-3">{agentName()}</span>}>
        {(name) => <span class="text-data text-ink-3">{name()}</span>}
      </Show>
    </header>
  );
}
