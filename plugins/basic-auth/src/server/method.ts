import { fail, internalAction, provide } from "@tokamak/sdk";
import * as auth from "plugin:auth/contracts";
import { internal } from "./_generated/internal";
import { changePassword, createAccount, createOwner, resetPassword, signInFields } from "./accounts";
import { MAX_PASSWORD_LENGTH, normalize } from "./credentials";

const signIn = internalAction({
  args: signInFields,
  async handler(ctx, { usernameOrEmail, password }) {
    if ([...password].length > MAX_PASSWORD_LENGTH) return fail("WrongPassword", null);
    const account = await ctx.runQuery(internal.accounts.lookup, { login: normalize(usernameOrEmail) });
    if (!account) {
      // Keep the cost of an unknown login comparable to a wrong password as defaults change.
      await ctx.crypto.hashPassword(password);
      return fail("WrongPassword", null);
    }
    const { valid, replacementHash } = await ctx.crypto.verifyAndRehashPassword(
      password,
      account.passwordHash,
    );
    if (!valid) return fail("WrongPassword", null);
    if (
      replacementHash &&
      !(await ctx.runMutation(internal.accounts.replaceHash, {
        accountId: account.accountId,
        previousHash: account.passwordHash,
        replacementHash,
      }))
    )
      return fail("WrongPassword", null);
    return {
      accountId: account.accountId,
      ...(account.temporary && { passwordChangeRequired: true as const }),
    };
  },
});

const accountForm = { username: "text", email: "email", password: "password" } as const;

export default provide(auth.method, {
  id: "basic-auth",
  name: "Password",
  form: { usernameOrEmail: "text", password: "password" },
  loginField: "usernameOrEmail",
  signIn,
  setupOwnerForm: accountForm,
  setupOwner: createOwner,
  createAccountForm: accountForm,
  createAccount,
  resetPassword,
  changePassword,
});
