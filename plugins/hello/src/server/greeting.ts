// The server part. Every exported function in src/server becomes a reference in
// `_generated/api.ts`, named by file and export: this one is `api.greeting.get`.
import { query } from "@tokamak/sdk";

// The text the page shows. Change it and run `./install.sh hello` to see the
// running app pick up the new build without a restart.
const message = "Hello from the hello plugin";

/**
 * A query reads and never writes. It runs on the server, and the page
 * receives only what it returns.
 */
export const get = query({
  handler: () => ({ text: message }),
});
