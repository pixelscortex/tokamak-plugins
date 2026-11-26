import { createFunctions, fail, onMember, v, type ModelFromSchema, type QueryContext } from "@tokamak/sdk";
import * as auth from "plugin:auth/contracts";
import { internal } from "./_generated/internal";
import schema from "./schema";
import { MAX_PASSWORD_LENGTH, normalize } from "./credentials";

const { internalAction, internalMutation, internalQuery } = createFunctions(schema);

const ownerAccount = "owner";

async function byLogin({ db }: Pick<QueryContext<ModelFromSchema<typeof schema>>, "db">, login: string) {
  // Usernames cannot contain @, so it unambiguously selects the email index.
  return login.includes("@")
    ? db
        .query("accounts")
        .withIndex("by_email", (q) => q.eq("email", login))
        .first()
    : db
        .query("accounts")
        .withIndex("by_username", (q) => q.eq("username", login))
        .first();
}

export const lookup = internalQuery({
  args: { login: v.string() },
  handler: (ctx, { login }) => byLogin(ctx, login),
});

export const lookupId = internalQuery({
  args: { accountId: v.string() },
  handler: (ctx, { accountId }) =>
    ctx.db
      .query("accounts")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
});

export const save = internalMutation({
  args: {
    accountId: v.string(),
    username: v.string(),
    email: v.string(),
    passwordHash: v.string(),
    temporary: v.boolean(),
  },
  async handler(ctx, account) {
    for (const login of [account.username, account.email]) {
      const existing = await byLogin(ctx, login);
      if (existing && existing.accountId !== account.accountId) return fail("LoginTaken", null);
    }
    const current = await ctx.db
      .query("accounts")
      .withIndex("by_account", (q) => q.eq("accountId", account.accountId))
      .first();
    // Bootstrap setup can retry if the plugin write finished before the core bound it.
    if (current && account.accountId === ownerAccount) await ctx.db.replace(current._id, account);
    else if (current) return fail("AccountAlreadyExists", null);
    else await ctx.db.insert("accounts", account);
    return { accountId: account.accountId };
  },
});

export const replaceHash = internalMutation({
  args: {
    accountId: v.string(),
    previousHash: v.string(),
    replacementHash: v.string(),
    temporary: v.optional(v.boolean()),
  },
  async handler(ctx, { accountId, previousHash, replacementHash, temporary }) {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    if (!account || account.passwordHash !== previousHash) return false;
    await ctx.db.patch(account._id, {
      passwordHash: replacementHash,
      ...(temporary === undefined ? {} : { temporary }),
    });
    return true;
  },
});

export const credentialFields = { username: v.string(), email: v.string(), password: v.string() };
export const signInFields = { usernameOrEmail: v.string(), password: v.string() };

function validateAccount(input: { username: string; email: string; password: string }) {
  const username = normalize(input.username);
  const email = normalize(input.email);
  if ([...username].length > 100 || !/^[\p{L}\p{N}._-]+$/u.test(username))
    return fail("InvalidUsername", null);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("InvalidEmail", null);
  if (!validPassword(input.password)) return fail("InvalidPassword", null);
  return { username, email };
}

function validPassword(password: string) {
  const length = [...password].length;
  return length >= 8 && length <= MAX_PASSWORD_LENGTH;
}

export const createOwner = internalAction({
  args: credentialFields,
  async handler(ctx, input) {
    const login = validateAccount(input);
    if ("failed" in login) return login;
    const passwordHash = await ctx.crypto.hashPassword(input.password);
    const account = await ctx.runMutation(internal.accounts.save, {
      ...login,
      accountId: ownerAccount,
      passwordHash,
      temporary: false,
    });
    if (account.failed) return account;
    return { ...account, displayName: input.username.trim() };
  },
});

export const createAccount = internalAction({
  args: { memberId: v.string(), fields: v.object(credentialFields) },
  async handler(ctx, { memberId, fields }) {
    const login = validateAccount(fields);
    if ("failed" in login) return login;
    const account = await ctx.runMutation(internal.accounts.save, {
      ...login,
      accountId: memberId,
      passwordHash: await ctx.crypto.hashPassword(fields.password),
      temporary: true,
    });
    if (account.failed) return account;
    return { ...account, displayName: fields.username.trim() };
  },
});

export const resetPassword = internalAction({
  args: { accountId: v.string(), password: v.string() },
  async handler(ctx, { accountId, password }) {
    if (!validPassword(password)) return fail("InvalidPassword", null);
    const account = await ctx.runQuery(internal.accounts.lookupId, { accountId });
    if (!account) return fail("AccountNotLinked", null);
    if (await ctx.crypto.verifyPassword(password, account.passwordHash))
      return fail("PasswordUnchanged", null);
    const updated = await ctx.runMutation(internal.accounts.replaceHash, {
      accountId,
      previousHash: account.passwordHash,
      replacementHash: await ctx.crypto.hashPassword(password),
      temporary: true,
    });
    return updated ? { accountId } : fail("PasswordChanged", null);
  },
});

export const changePassword = internalAction({
  args: { accountId: v.string(), fields: v.object(signInFields), newPassword: v.string() },
  async handler(ctx, { accountId, fields, newPassword }) {
    if (!validPassword(newPassword)) return fail("InvalidPassword", null);
    if (newPassword === fields.password) return fail("PasswordUnchanged", null);
    const account = await ctx.runQuery(internal.accounts.lookup, {
      login: normalize(fields.usernameOrEmail),
    });
    if (
      !account?.temporary ||
      account.accountId !== accountId ||
      !(await ctx.crypto.verifyPassword(fields.password, account.passwordHash))
    )
      return fail("WrongPassword", null);
    const updated = await ctx.runMutation(internal.accounts.replaceHash, {
      accountId,
      previousHash: account.passwordHash,
      replacementHash: await ctx.crypto.hashPassword(newPassword),
      temporary: false,
    });
    return updated ? { accountId } : fail("PasswordChanged", null);
  },
});

export const cleanUpMemberAccount = onMember(auth.memberRemoved, async (ctx, { id }) => {
  // The core's member ID identifies the provider account even if the binding was never saved.
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_account", (q) => q.eq("accountId", id))
    .first();
  if (account) await ctx.db.delete(account._id);
});
