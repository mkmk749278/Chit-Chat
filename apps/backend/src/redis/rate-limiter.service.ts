import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_COMMAND_CLIENT } from './redis.constants';

/**
 * Redis key prefix for the fixed-window rate-limit counters. The full key is
 * `ratelimit:{scope}:{id}` per the design's Redis key model (§12.3); callers build the
 * `{scope}:{id}` portion (e.g. `register:{uid}`) and pass it to {@link RateLimiterService.hit}.
 */
const RATE_LIMIT_KEY_PREFIX = 'ratelimit:';

/**
 * Inclusive bounds for a configured rate-limit window, in seconds (Requirement 5.6):
 * at least 1 second and at most 86,400 seconds (24 hours).
 */
export const MIN_WINDOW_SECONDS = 1;
export const MAX_WINDOW_SECONDS = 86_400;

/**
 * Inclusive bounds for a configured rate-limit count (Requirement 5.6): at least 1
 * request and at most 1,000,000 requests per window.
 */
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 1_000_000;

/**
 * The outcome of a single {@link RateLimiterService.hit} call (design Component 6
 * `RateLimitResult`).
 */
export interface RateLimitResult {
  /** `true` while the window's count is within `limit`; `false` once it is exceeded. */
  allowed: boolean;
  /** Remaining allowed hits in the current window (never negative). */
  remaining: number;
  /** Seconds until the current window's counter expires and resets. */
  resetSeconds: number;
}

/**
 * Thrown when a rate-limit configuration falls outside the permitted ranges
 * (Requirement 5.6). Surfaces that wire the limiter validate their configured
 * `limit`/`windowSeconds` at startup via {@link RateLimiterService.assertValidConfig};
 * an out-of-range value raises this error so the Backend_API refuses to start with a
 * clear configuration error rather than silently mis-limiting a protected surface.
 */
export class RateLimitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitConfigError';
  }
}

/**
 * Atomic fixed-window evaluation (Requirements 5.1–5.5).
 *
 * The script reads the current count first. While the count is still below `limit`
 * (`ARGV[1]`) it `INCR`s the counter — creating it on the first hit of the window and
 * applying the `EXPIRE` (`ARGV[2]`) in the same script so the TTL is set exactly once
 * per window (or repaired if the key somehow lost its TTL), avoiding the race where a
 * separate `INCR` then `EXPIRE` could leave a counter with no expiry. Once the count has
 * already reached `limit`, the hit is rejected without touching the counter or its TTL
 * (Requirement 5.4: "retaining the counter value and its remaining time-to-live
 * unchanged"), so a rejected hit neither grows the counter unbounded nor slides the
 * window. Returns `{count, ttl, allowed}` where `allowed` is `1` for an accepted hit and
 * `0` for a rejected one.
 */
const FIXED_WINDOW_SCRIPT = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local current = tonumber(redis.call('GET', KEYS[1])) or 0
if current >= limit then
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then
    ttl = window
  end
  return {current, ttl, 0}
end
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], window)
  ttl = window
end
return {count, ttl, 1}
`;

/**
 * RateLimiterService — the Redis fixed-window rate limiter (Requirement 5; design
 * Component 6 `RateLimiter` + Redis key model).
 *
 * Maintains a per-surface counter under `ratelimit:{scope}:{id}` whose TTL equals the
 * configured window in seconds (Requirement 5.1). Each {@link hit} evaluates the
 * counter and reports whether the caller is still within `limit` for the active window
 * (Requirement 5.2, 5.3): while the count is below `limit` the counter is incremented
 * and the hit is allowed; once the count has reached `limit` the result is
 * `allowed=false` and the counter and its existing TTL are left untouched, so a rejected
 * hit neither slides the window nor grows the counter unbounded (Requirement 5.4). When
 * the window's TTL expires Redis drops the key, so the next hit starts a fresh window
 * from zero (Requirement 5.5).
 *
 * Configuration is range-checked: a window must be in `1..86400` seconds and a limit in
 * `1..1000000` requests, otherwise {@link RateLimitConfigError} is raised so a
 * mis-configured surface refuses to start (Requirement 5.6).
 *
 * Operates purely against Redis — it never reads or writes PostgreSQL (§12.3).
 */
@Injectable()
export class RateLimiterService {
  constructor(@Inject(REDIS_COMMAND_CLIENT) private readonly redis: Redis) {}

  /**
   * Validates a configured rate-limit `limit`/`windowSeconds` pair against the
   * permitted ranges (Requirement 5.6). Call this at startup wherever the limiter is
   * applied to a surface so an out-of-range configuration fails fast.
   *
   * @throws {RateLimitConfigError} when `limit` or `windowSeconds` is not an integer
   *   within its inclusive range.
   */
  static assertValidConfig(limit: number, windowSeconds: number): void {
    if (!Number.isInteger(windowSeconds) || windowSeconds < MIN_WINDOW_SECONDS || windowSeconds > MAX_WINDOW_SECONDS) {
      throw new RateLimitConfigError(
        `Rate-limit window must be an integer between ${MIN_WINDOW_SECONDS} and ${MAX_WINDOW_SECONDS} seconds, received ${windowSeconds}.`,
      );
    }
    if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
      throw new RateLimitConfigError(
        `Rate-limit limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT} requests, received ${limit}.`,
      );
    }
  }

  /**
   * Records one hit against `ratelimit:{scope}:{id}` and evaluates it against `limit`
   * for the current fixed window.
   *
   * The configuration is validated first (Requirement 5.6); while the current count is
   * below `limit` the counter is then incremented atomically and given a TTL of
   * `windowSeconds` on the first hit of the window (Requirement 5.1). The hit is allowed
   * while the resulting count is at or below `limit` and rejected once the count has
   * reached `limit`; a rejected hit leaves the counter value and its remaining TTL
   * unchanged (Requirements 5.2–5.4). The counter resets automatically when its TTL
   * expires (Requirement 5.5).
   *
   * @param key           - the `{scope}:{id}` portion of the rate-limit key (the
   *                        `ratelimit:` prefix is added here).
   * @param limit         - max allowed hits per window (`1..1000000`).
   * @param windowSeconds - window length in seconds (`1..86400`).
   * @returns the {@link RateLimitResult} for this hit.
   * @throws {RateLimitConfigError} when `limit` or `windowSeconds` is out of range.
   */
  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    RateLimiterService.assertValidConfig(limit, windowSeconds);

    const redisKey = `${RATE_LIMIT_KEY_PREFIX}${key}`;
    const [count, ttl, allowedFlag] = (await this.redis.eval(
      FIXED_WINDOW_SCRIPT,
      1,
      redisKey,
      limit,
      windowSeconds,
    )) as [number, number, number];

    const allowed = allowedFlag === 1;
    const remaining = Math.max(0, limit - count);
    // TTL is guaranteed non-negative by the script (it (re)sets EXPIRE when missing).
    const resetSeconds = ttl >= 0 ? ttl : windowSeconds;

    return { allowed, remaining, resetSeconds };
  }
}
