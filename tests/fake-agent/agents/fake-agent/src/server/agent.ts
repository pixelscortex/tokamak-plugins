import { provide } from "@tokamak/sdk";
import * as ai from "plugin:ai/contracts";
import { fakeAgent } from "./factory";

/** "Fake agent": no levels or speeds; a Mode picker, like Codex's plan mode. */
export default provide(
  ai.agent,
  fakeAgent({ id: "fake-agent", name: "Fake agent", modes: ["default", "plan"] }),
);
