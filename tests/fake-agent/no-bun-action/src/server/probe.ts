import { action } from "@tokamak/sdk";

export const run = action({ handler: () => ({ ran: true, bun: "Bun" in globalThis }) });
