// Stands in for the host's window state binding: ai keeps its last picks
// per device, so these tests give it an in-memory device store.
import { createWindowState } from "@tokamak/sdk/window-state-host";
import type { JsonValue } from "@tokamak/sdk";

const device = new Map<string, JsonValue>();

export default createWindowState({
  device: {
    read: (key) => (device.has(key) ? { value: device.get(key)! } : null),
    write: (key, value) => void device.set(key, value),
  },
  me: {
    read: async () => null,
    write: async () => null,
  },
  report(error) {
    throw error;
  },
});
