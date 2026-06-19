/**
 * `@chat-app/crypto` — pure unlock rate-limit / lockout policy.
 *
 * Signature Features 1 & 4 (`private-chat-app-requirements.md` §3.1, §6.2): hidden-chat secret
 * entry and the app PIN must rate-limit guessing — "5 wrong attempts per 10 minutes → 30-minute
 * lockout", with timing-only feedback and no visible attempt counter (§3.1). The decoy PIN passes
 * the same logic (§6.2).
 *
 * This module is pure and clock-injected: it takes the timestamps of recent FAILED attempts plus
 * the current time and decides whether entry is currently locked, so it can be unit-tested without
 * real timers and reused by both the hidden-chat gate and the PIN gate. The caller owns persistence
 * of the failure list (in the encrypted vault) and feeds it back in.
 */

/** Tunable lockout thresholds. */
export interface LockoutPolicy {
  /** Sliding window over which failures are counted, in ms. */
  windowMs: number;
  /** Failures within the window that trigger a lockout. */
  maxFailures: number;
  /** Lockout duration once tripped, in ms. */
  lockoutMs: number;
}

/** Default policy: 5 failures / 10 min → 30 min lockout (§3.1). */
export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = {
  windowMs: 10 * 60 * 1000,
  maxFailures: 5,
  lockoutMs: 30 * 60 * 1000,
};

/** The current lockout decision. */
export interface LockoutState {
  /** `true` while entry is locked and an attempt must be refused. */
  locked: boolean;
  /** Unix-ms time the lock lifts, or `null` when not locked. */
  lockedUntil: number | null;
  /** Failures counted within the window (internal; NOT to be shown to the user, §3.1). */
  failuresInWindow: number;
  /** Milliseconds until the lock lifts, or `0` when not locked. */
  msUntilUnlock: number;
}

/**
 * Evaluate whether entry is locked given the FAILED-attempt timestamps and `now`.
 *
 * A lockout trips once `maxFailures` failures fall within the trailing `windowMs`; the lock then
 * lasts `lockoutMs` measured from the most recent of those failures. The window is a sliding count,
 * so once the offending failures age out (and the lock duration elapses) entry unlocks on its own.
 * Failures at or before `now` are considered; future timestamps are ignored.
 */
export function evaluateLockout(
  failureTimestamps: readonly number[],
  now: number,
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): LockoutState {
  const windowStart = now - policy.windowMs;
  const recent = failureTimestamps
    .filter((t) => t <= now && t > windowStart)
    .sort((a, b) => a - b);

  const failuresInWindow = recent.length;
  if (failuresInWindow >= policy.maxFailures) {
    const lastFailure = recent[recent.length - 1];
    const lockedUntil = lastFailure + policy.lockoutMs;
    if (now < lockedUntil) {
      return {
        locked: true,
        lockedUntil,
        failuresInWindow,
        msUntilUnlock: lockedUntil - now,
      };
    }
  }
  return { locked: false, lockedUntil: null, failuresInWindow, msUntilUnlock: 0 };
}

/**
 * Prune failure timestamps that can no longer affect any future lockout decision, so the persisted
 * list does not grow without bound. Keeps anything within the window OR still inside an active
 * lockout tail; drops the rest.
 */
export function pruneFailures(
  failureTimestamps: readonly number[],
  now: number,
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): number[] {
  const horizon = now - Math.max(policy.windowMs, policy.lockoutMs);
  return failureTimestamps.filter((t) => t > horizon).sort((a, b) => a - b);
}
