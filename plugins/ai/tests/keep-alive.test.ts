import { afterEach, expect, test, vi } from "vitest";
import type { Id, CallerActionContext } from "@tokamak/sdk";
import { keepAlive } from "../src/server/keep-alive";
import { BEAT_MS, SILENCE_MS } from "../src/shared/turn-timing";

afterEach(() => vi.useRealTimers());

test("an active turn survives sleep and keeps sending beats", async () => {
  vi.useFakeTimers();
  const started = Date.now();
  const runMutation = vi.fn(async () => true);
  const ended = vi.fn();
  const alive = keepAlive(
    { runMutation } as unknown as CallerActionContext,
    "turns:test" as Id<"turns">,
    ended,
  );
  try {
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    vi.setSystemTime(started + 3 * SILENCE_MS);
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(runMutation).toHaveBeenCalledTimes(3);
    expect(ended).not.toHaveBeenCalled();
  } finally {
    alive.stop();
  }
});

test("after sleep an unreachable server gets a new silence window, but a server that ended the turn stops it", async () => {
  vi.useFakeTimers();
  const started = Date.now();
  const runMutation = vi.fn(async () => true);
  const ended = vi.fn();
  const alive = keepAlive(
    { runMutation } as unknown as CallerActionContext,
    "turns:test" as Id<"turns">,
    ended,
  );
  try {
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    runMutation.mockRejectedValue(new Error("offline"));
    vi.setSystemTime(started + 3 * SILENCE_MS);
    await vi.advanceTimersByTimeAsync(4 * BEAT_MS);
    expect(ended).not.toHaveBeenCalled();
    runMutation.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(ended).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledWith(expect.stringContaining("ended the turn"));
  } finally {
    alive.stop();
  }
});
