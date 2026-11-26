declare module "virtual:chat-probe" {
  export const manifest: import("@tokamak/sdk").JsonObject & {
    plugin: { id: string };
    entries: { ui: { code: string } };
  };
  export function loadActions(): Promise<Record<string, unknown>>;
}
