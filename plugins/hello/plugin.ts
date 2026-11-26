// The plugin's descriptor: its id, version and what it needs. The id is also the
// folder name in the app's plugins folder; install.sh reads `depends` from here
// to build and reload owners before the plugins that use them.
import { definePlugin } from "@tokamak/sdk";

export default definePlugin({
  id: "hello",
  version: "0.1.0",
  name: "Hello",
  description: "The smallest plugin: one server function and one page that shows its result.",
  permissions: [],
});
