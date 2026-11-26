import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon, Row } from "@tokamak/ui";
import type { MessageProps } from "plugin:chat/client";
import { changeOf, openReview, type ReplyChange } from "../lib/changes";
import { chevronRightIcon, fileCodeIcon } from "../lib/icons";
import { Counts, filesLabel } from "./counts";

/**
 * Under the last reply of a turn that changed something (Paper "Coding ·
 * threads + review", "Summary · changed files"): the turn's counts, and the
 * way into the review panel. The first turn after Git appeared says how many
 * files tracking started with; with no change of its own it opens nothing.
 */
export function ChangeCard(props: MessageProps): JSX.Element {
  return (
    <Show when={changeOf(props)}>
      {(change) => (
        <Show
          when={change().files > 0}
          fallback={
            <div class="flex h-8 w-full items-center gap-2 rounded-sm px-2 surface-card">
              <Icon path={fileCodeIcon} class="text-ink" />
              <CardText change={change()} />
            </div>
          }
        >
          <div class="density-dense rounded-sm surface-card">
            <Row
              as="button"
              variant="card"
              aria-label={`Review turn ${change().number}`}
              onClick={() => openReview(props.threadId, change().turnId)}
              lead={<Icon path={fileCodeIcon} />}
              trail={
                <>
                  <span>open in review</span>
                  <Icon path={chevronRightIcon} size={14} />
                </>
              }
            >
              <span class="flex items-center gap-2">
                <CardText change={change()} />
              </span>
            </Row>
          </div>
        </Show>
      )}
    </Show>
  );
}

function CardText(props: { change: ReplyChange }): JSX.Element {
  return (
    <>
      <span class="text-row font-medium text-ink">
        {props.change.tracking === null
          ? filesLabel(props.change.files)
          : `Started tracking · ${filesLabel(props.change.tracking)}`}
      </span>
      <Show when={props.change.files > 0}>
        <Show
          when={props.change.added + props.change.removed > 0}
          fallback={
            // No line to count ("1 file 0 0" said nothing): binary files say so; an empty file or a
            // mode change shows only its file count.
            <Show when={props.change.binary === props.change.files}>
              <span class="text-label text-ink-3">· binary</span>
            </Show>
          }
        >
          <Counts added={props.change.added} removed={props.change.removed} />
        </Show>
      </Show>
    </>
  );
}
