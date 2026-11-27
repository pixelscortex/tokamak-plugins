import { append } from "@tokamak/sdk/client";
import * as chat from "plugin:chat/client";

/**
 * A line under each finished fake-agent reply. It shares the message footer
 * with `code`'s change card, so browser tests can see that a second plugin
 * still adds to the same footer.
 */
export const Replayed = append(
  chat.find("footer"),
  () => <p class="text-label text-ink-3">Replayed by the fake agent</p>,
  {
    when: (m) => m.message.author?.id === "agent:fake-agent" && m.message.status !== "streaming",
  },
);
