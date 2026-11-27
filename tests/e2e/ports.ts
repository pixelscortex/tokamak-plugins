const preview = Number(process.env.TOKAMAK_E2E_PORT ?? "1420");
export const browserPorts = { preview, secondPreview: 1421, local: 43123, hosted: 43124 };
if (!Number.isInteger(preview) || preview < 1 || preview > 65535 ||
    new Set(Object.values(browserPorts)).size !== 4) {
  throw new Error("TOKAMAK_E2E_PORT must be a valid port distinct from 1421, 43123 and 43124");
}
