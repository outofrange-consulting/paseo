import { PidLockError, type PidLockInfo } from "../src/server/pid-lock.js";

const HEALTHY_DAEMON_POLL_INTERVAL_MS = 1000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    ) {
      // Process exists but is owned by another user — still alive.
      return true;
    }
    return false;
  }
}

export interface AcquireLockDeps {
  acquire: (paseoHome: string, ownerPid: number) => Promise<void>;
  isAlive: (pid: number) => boolean;
  wait: (ms: number) => Promise<void>;
  log: (message: string) => void;
  pollIntervalMs?: number;
}

/**
 * Acquire the daemon PID lock for this process, yielding to an existing healthy
 * daemon instead of crash-exiting.
 *
 * Why this matters: under a process supervisor that restarts the launcher on
 * exit (e.g. an s6 `longrun`), having the supervisor entrypoint `process.exit(1)`
 * on `PidLockError` turns a *persistent* "another healthy daemon already owns the
 * lock" condition into a tight respawn storm. A fresh supervisor is spawned every
 * restart-throttle tick (~2s); each one re-reads the lock, sees the original
 * healthy daemon still owns it, prints "Another Paseo daemon is already running",
 * and exits 1 — burning CPU and flooding daemon.log indefinitely while the real
 * daemon keeps serving.
 *
 * Instead, when a healthy daemon already holds the lock we stay alive and wait
 * for that owner to exit, then take the lock over. This preserves double-start
 * protection (we never start a second competing daemon) while keeping the
 * supervised process "up" attached to the healthy daemon, so the external
 * supervisor has no reason to respawn us.
 *
 * A `PidLockError` that does NOT carry a live `existingLock` owner (e.g. a corrupt
 * lock or a race that left no running owner) is still treated as fatal and
 * re-thrown.
 */
export async function acquireLockOrYieldToHealthyDaemon(
  paseoHome: string,
  ownerPid: number,
  deps: AcquireLockDeps,
): Promise<void> {
  const pollIntervalMs = deps.pollIntervalMs ?? HEALTHY_DAEMON_POLL_INTERVAL_MS;
  let waitingForPid: number | null = null;

  for (;;) {
    try {
      await deps.acquire(paseoHome, ownerPid);
      return;
    } catch (error) {
      if (!(error instanceof PidLockError)) {
        throw error;
      }

      const existing: PidLockInfo | undefined = error.existingLock;
      // Without a concrete live owner we can't safely wait it out — fail loudly.
      if (!existing || !deps.isAlive(existing.pid)) {
        throw error;
      }

      if (existing.pid !== waitingForPid) {
        waitingForPid = existing.pid;
        deps.log(
          `${error.message}. This daemon is healthy; waiting for it to exit instead of restarting.`,
        );
      }

      await deps.wait(pollIntervalMs);
    }
  }
}
