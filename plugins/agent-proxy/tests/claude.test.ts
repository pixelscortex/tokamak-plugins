import { createServer } from "node:http";
import { expect, test } from "vitest";
import type { Addresses } from "../src/server/addresses";
import { SignInError, exchange, readPasted, renew } from "../src/server/claude";

// The parts of Claude's sign-in that a real server test cannot reach with the
// fake: what a person may paste, and answers the fake never gives.

test("a paste is read whether the state is a parameter, after the code, in the fragment, or absent", () => {
  const base = "http://localhost:54545/callback";
  expect(readPasted(`${base}?code=abc&state=xyz`)).toEqual({ code: "abc", state: "xyz" });
  expect(readPasted(`${base}?code=abc%23xyz`)).toEqual({ code: "abc", state: "xyz" });
  expect(readPasted(`${base}?code=abc#xyz`)).toEqual({ code: "abc", state: "xyz" });
  expect(readPasted(`${base}?code=abc#state=xyz`)).toEqual({ code: "abc", state: "xyz" });
  expect(readPasted(`  abc#xyz `)).toEqual({ code: "abc", state: "xyz" });
  expect(readPasted("abc")).toEqual({ code: "abc", state: undefined });
  expect(readPasted(`${base}?error=access_denied`)).toHaveProperty("error");
  expect(readPasted("")).toHaveProperty("error");
});

/** A token endpoint that answers every request with `answer`. */
async function endpoint(answer: { status: number; body: string; headers?: Record<string, string> }) {
  const server = createServer((_request, response) => {
    response.writeHead(answer.status, answer.headers);
    response.end(answer.body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  const addresses = {
    anthropic: { authorize: url, token: url, api: url },
    openai: { authorize: url, token: url, api: url },
  } as Addresses;
  return { addresses, stop: () => new Promise<void>((done) => server.close(() => done())) };
}

test("an unreadable 200 is 'try again', and a login without expires_in is not born expired", async () => {
  const broken = await endpoint({ status: 200, body: "<html>maintenance</html>" });
  try {
    const failure = await exchange(broken.addresses, { code: "c", state: "s" }, "v").catch((error) => error);
    expect(failure).toBeInstanceOf(SignInError);
    expect(failure).toMatchObject({ kind: "Unreachable" });
  } finally {
    await broken.stop();
  }
  const bare = await endpoint({
    status: 200,
    body: JSON.stringify({ access_token: "a", refresh_token: "r" }),
  });
  try {
    const { login } = await exchange(bare.addresses, { code: "c", state: "s" }, "v");
    expect(login.expiresAt).toBeGreaterThan(Date.now() + 59 * 60_000);
  } finally {
    await bare.stop();
  }
});

test("only 400 and 401 refuse a renewal; 429 keeps its Retry-After, 403 and 5xx wait", async () => {
  const cases: [number, Record<string, string>, unknown][] = [
    [400, {}, { kind: "refused" }],
    [401, {}, { kind: "refused" }],
    [403, {}, { kind: "later" }],
    [503, {}, { kind: "later" }],
    [429, { "retry-after": "120" }, { kind: "later", afterMs: 120_000 }],
  ];
  for (const [status, headers, expected] of cases) {
    const company = await endpoint({ status, headers, body: "{}" });
    try {
      expect(await renew(company.addresses, "r")).toEqual(expected);
    } finally {
      await company.stop();
    }
  }
});
