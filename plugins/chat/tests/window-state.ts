// Stands in for the host's window state binding: window tests keep chat's
// `state` in memory, the way a window does before anything is kept.
import { createWindowState } from "@tokamak/sdk/window-state-host";

export default createWindowState();
