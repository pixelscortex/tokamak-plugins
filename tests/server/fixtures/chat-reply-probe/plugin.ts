import { definePlugin } from "@tokamak/sdk";

// Writes replies into chat threads the way `ai` will: through chat's plugin-only API.
export default definePlugin({ id: "reply-probe", version: "1.0.0", depends: ["chat"] });
