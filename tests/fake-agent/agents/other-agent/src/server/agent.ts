import { provide } from "@tokamak/sdk";
import * as ai from "plugin:ai/contracts";
import { fakeAgent } from "./factory";

/** "Other agent": levels and speeds, no modes; for switching agents inside a thread. */
export default provide(
  ai.agent,
  fakeAgent({
    id: "other-agent",
    name: "Other agent",
    efforts: ["low", "high"],
    speeds: ["standard", "fast"],
  }),
);
