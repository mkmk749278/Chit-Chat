/**
 * Exponential reconnection backoff with jitter for the Redis clients.
 *
 * Requirement 7.2: the command, subscriber, and publisher clients apply exponential
 * reconnection backoff that starts at 500 ms, is capped at 30 seconds, and includes
 * randomised jitter. This is exposed as a pure factory so the curve is unit-testable
 * without constructing a real connection.
 */

/** First-attempt backoff floor, in milliseconds (Requirement 7.2). */
export const REDIS_RETRY_BASE_DELAY_MS = 500;

/** Hard upper bound on any computed backoff, in milliseconds (Requirement 7.2). */
export const REDIS_RETRY_MAX_DELAY_MS = 30_000;

/** Maximum jitter added on top of the capped delay, as a fraction of that delay. */
const REDIS_RETRY_JITTER_RATIO = 0.2;

/**
 * Builds an ioredis `retryStrategy` function implementing exponential backoff with
 * jitter.
 *
 * The base delay doubles each attempt — 500 ms, 1 s, 2 s, 4 s, … — and is clamped to
 * {@link REDIS_RETRY_MAX_DELAY_MS}. Randomised jitter (up to
 * {@link REDIS_RETRY_JITTER_RATIO} of the capped delay) is then added to avoid a
 * thundering herd of simultaneous reconnects, with the final value never exceeding
 * the 30 s cap.
 *
 * @param random - source of randomness in `[0, 1)` (defaults to `Math.random`);
 *                 injectable so tests can assert exact, deterministic delays.
 * @returns a function mapping the 1-based reconnection attempt number to a delay in ms.
 */
export function createRedisRetryStrategy(
  random: () => number = Math.random,
): (attempt: number) => number {
  return (attempt: number): number => {
    // ioredis passes a 1-based attempt counter; guard against 0/negative just in case.
    const exponent = Math.max(0, attempt - 1);

    // Exponential growth from the 500 ms floor, clamped to the 30 s ceiling.
    const exponential = REDIS_RETRY_BASE_DELAY_MS * 2 ** exponent;
    const capped = Math.min(exponential, REDIS_RETRY_MAX_DELAY_MS);

    // Add randomised jitter, keeping the total within the cap.
    const jitter = capped * REDIS_RETRY_JITTER_RATIO * random();
    return Math.min(REDIS_RETRY_MAX_DELAY_MS, Math.round(capped + jitter));
  };
}
