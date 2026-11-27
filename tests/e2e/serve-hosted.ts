// A shared server for the general browser suite, isolated from any installed tools or data.
import { startHostedFixture } from "./hosted-fixture";

const server = await startHostedFixture({ port: 43124, ownerKey: process.env.TOKAMAK_E2E_HOSTED_TOKEN! });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, server.stop);
process.exitCode = await server.exited;
