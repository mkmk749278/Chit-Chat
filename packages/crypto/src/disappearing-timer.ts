/**
 * `@chat-app/crypto` — disappearing-message expiry math (Phase 2, Requirement 4).
 *
 * Pure, platform-agnostic helpers that decide WHEN a timed or view-once message should be
 * removed from the on-device store. The shared core owns only the decision; the platform store
 * performs the actual deletion (overwriting the row's plaintext as a best-effort secure erase —
 * task 4.2) and the UI surfaces it. Keeping the decision here makes it deterministic and
 * unit-testable with an injected clock, and identical across web and mobile.
 *
 * Model: each timed entry carries a precomputed absolute `expiresAt` (unix ms). How `expiresAt`
 * is derived is the caller's concern and differs by role/feature:
 *   - disappearing timer: `expiresAt = startedAt + ttlMs`, where `startedAt` is send time for the
 *     sender and read time for the recipient (so the clock starts when each side "has" it);
 *   - view-once: `expiresAt = displayedAt` (it disappears the instant it is first shown, Req 4.3).
 * Use {@link computeExpiresAt} for the timer case. A non-positive `ttlMs` means "no timer".
 */

/** Sentinel returned by {@link computeExpiresAt} when there is no timer (ttl ≤ 0). */
export const NO_EXPIRY = Number.POSITIVE_INFINITY;

/** A message that may expire, identified by id and its absolute expiry instant (unix ms). */
export interface ExpiringEntry {
  /** Stable message id to purge when expired. */
  id: string;
  /** Absolute expiry instant in unix ms; {@link NO_EXPIRY} (or ≤ now never set) means no timer. */
  expiresAt: number;
}

/**
 * Absolute expiry instant for a disappearing message, or {@link NO_EXPIRY} when `ttlMs ≤ 0`
 * (timer disabled). `startedAt` is when the clock begins (send time for the sender, read time
 * for the recipient).
 */
export function computeExpiresAt(startedAt: number, ttlMs: number): number {
  return ttlMs > 0 ? startedAt + ttlMs : NO_EXPIRY;
}

/**
 * The ids of every entry that has reached its expiry instant at `now` (i.e. `now >= expiresAt`).
 * Entries with a non-finite `expiresAt` (no timer) are never selected.
 */
export function selectExpired(entries: readonly ExpiringEntry[], now: number): string[] {
  const expired: string[] = [];
  for (const entry of entries) {
    if (Number.isFinite(entry.expiresAt) && now >= entry.expiresAt) {
      expired.push(entry.id);
    }
  }
  return expired;
}

/**
 * Milliseconds until the NEXT entry expires (for scheduling a single purge timer), or `null`
 * when nothing is pending. Already-expired entries yield `0` so the caller purges immediately
 * rather than waiting. Never returns a negative value.
 */
export function msUntilNextExpiry(entries: readonly ExpiringEntry[], now: number): number | null {
  let soonest = NO_EXPIRY;
  for (const entry of entries) {
    if (Number.isFinite(entry.expiresAt) && entry.expiresAt < soonest) {
      soonest = entry.expiresAt;
    }
  }
  if (!Number.isFinite(soonest)) {
    return null;
  }
  return Math.max(0, soonest - now);
}
