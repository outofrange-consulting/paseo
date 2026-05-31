import { describe, expect, test, vi } from "vitest";

import { PidLockError, type PidLockInfo } from "../src/server/pid-lock.js";
import {
  acquireLockOrYieldToHealthyDaemon,
  type AcquireLockDeps,
} from "./acquire-daemon-lock.js";

function makeLock(pid: number): PidLockInfo {
  return {
    pid,
    startedAt: "2026-01-01T00:00:00.000Z",
    hostname: "test-host",
    uid: 1000,
    listen: "0.0.0.0:6767",
  };
}

describe("acquireLockOrYieldToHealthyDaemon", () => {
  test("acquires immediately when the lock is free", async () => {
    const acquire = vi.fn().mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const deps: AcquireLockDeps = {
      acquire,
      isAlive: () => true,
      wait,
      log,
      pollIntervalMs: 1,
    };

    await acquireLockOrYieldToHealthyDaemon("/tmp/paseo", 123, deps);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  // Regression: under s6 longrun, a healthy existing daemon used to cause the
  // entrypoint to print "already running" and process.exit(1) every ~2s forever.
  // Now we wait the healthy owner out instead of crash-exiting, then take over.
  test("waits for a healthy existing daemon instead of crash-exiting, then takes over", async () => {
    const existing = makeLock(158);
    const acquire = vi
      .fn()
      .mockRejectedValueOnce(new PidLockError("Another Paseo daemon is already running", existing))
      .mockRejectedValueOnce(new PidLockError("Another Paseo daemon is already running", existing))
      .mockResolvedValueOnce(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const deps: AcquireLockDeps = {
      acquire,
      isAlive: () => true,
      wait,
      log,
      pollIntervalMs: 1,
    };

    await acquireLockOrYieldToHealthyDaemon("/tmp/paseo", 999, deps);

    expect(acquire).toHaveBeenCalledTimes(3);
    // It polled while waiting rather than exiting the process.
    expect(wait).toHaveBeenCalledTimes(2);
    // It logged the "waiting" notice exactly once for the single healthy owner.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("waiting for it to exit");
  });

  test("re-throws when the existing lock owner is not actually alive (stale/corrupt)", async () => {
    const acquire = vi
      .fn()
      .mockRejectedValue(new PidLockError("Failed to acquire PID lock due to race condition"));
    const wait = vi.fn().mockResolvedValue(undefined);
    const deps: AcquireLockDeps = {
      acquire,
      isAlive: () => false,
      wait,
      log: vi.fn(),
      pollIntervalMs: 1,
    };

    await expect(acquireLockOrYieldToHealthyDaemon("/tmp/paseo", 999, deps)).rejects.toBeInstanceOf(
      PidLockError,
    );
    expect(wait).not.toHaveBeenCalled();
  });

  test("re-throws non-PidLock errors unchanged", async () => {
    const boom = new Error("disk on fire");
    const acquire = vi.fn().mockRejectedValue(boom);
    const deps: AcquireLockDeps = {
      acquire,
      isAlive: () => true,
      wait: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
      pollIntervalMs: 1,
    };

    await expect(acquireLockOrYieldToHealthyDaemon("/tmp/paseo", 999, deps)).rejects.toBe(boom);
  });
});
