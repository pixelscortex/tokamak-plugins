import { definePlugin } from "@tokamak/sdk";

export default definePlugin({
  id: "basic-auth",
  version: "0.1.0",
  name: "Password",
  description: "Sign in with a username or email and password.",
  depends: ["auth"],
  permissions: [],
});
