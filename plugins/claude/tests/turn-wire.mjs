import assert from "node:assert/strict";
import { within } from "../../../tests/fake-agent/harness.mjs";

/** Intercept only the reply from the real server; other calls and writes keep flowing. */
export function turnWire() {
  const writes = new Map();
  let hold;
  function observeMutation(frame) {
    if (frame.type !== "op" || frame.name !== "plugin.call" || frame.payload.kind !== "mutation") return;
    const { name, args } = frame.payload;
    if (name === "ai/turns:write") {
      writes.set(args.turnId, (writes.get(args.turnId) ?? 0) + 1);
      if (hold && hold.id === undefined && args.text === hold.text) {
        hold.id = frame.id;
        hold.turnId = args.turnId;
      }
    }
    if (hold && name === "ai/turns:finish" && args.turnId === hold.turnId) hold.finished = true;
  }

  return {
    observe(plugin, frame, direction) {
      if (plugin !== "ai") return;
      if (direction === "fromWorker") {
        observeMutation(frame);
      } else if (hold && frame.type === "opResult" && frame.id === hold.id) {
        assert.equal(frame.error, undefined);
        hold.ready.resolve();
        return hold.release.promise;
      }
    },
    writes: (turnId) => writes.get(turnId) ?? 0,
    hold(text) {
      const ready = Promise.withResolvers();
      const release = Promise.withResolvers();
      const current = { text, ready, release, finished: false };
      hold = current;
      return {
        finishSent: () => current.finished,
        pending: () => within(ready.promise, "the server wrote the reply and its acknowledgement is held"),
        release() {
          hold = undefined;
          release.resolve();
        },
      };
    },
  };
}
