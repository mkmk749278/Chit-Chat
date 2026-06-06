/**
 * `REDIS_URL` resolution and validation.
 *
 * Requirement 7.6: if `REDIS_URL` is absent or cannot be parsed into a valid
 * connection target, the Redis_Module must fail initialization at startup with an
 * error identifying the missing or invalid configuration, and must not serve any
 * cache, presence, pub/sub, or rate-limit request. This module performs that check
 * once, before any `ioredis` client is constructed.
 */

/** Redis URL schemes ioredis understands (`rediss:` is the TLS variant). */
const VALID_REDIS_PROTOCOLS: ReadonlySet<string> = new Set(['redis:', 'rediss:']);

/**
 * Resolves and validates the Redis connection URL from the environment.
 *
 * @param env - the environment to read from (defaults to `process.env`); injectable
 *              for testing without mutating the real process environment.
 * @returns the validated `REDIS_URL` string, suitable for `new Redis(url, ...)`.
 * @throws {Error} if `REDIS_URL` is absent/blank, is not a parseable URL, or does not
 *                 use the `redis:`/`rediss:` scheme.
 */
export function resolveRedisUrl(env: NodeJS.ProcessEnv = process.env): string {
  return validateRedisUrl(env.REDIS_URL);
}

/**
 * Validates a raw `REDIS_URL` value into a usable connection string.
 *
 * Separated from {@link resolveRedisUrl} so the value can be sourced from the typed
 * `AppConfigService` (the canonical config accessor) while keeping the same
 * fail-fast parse/scheme/host checks (Requirement 7.6). `AppConfigService` only
 * guarantees the variable is present, not that it parses into a valid connection
 * target — this function closes that gap before any `ioredis` client is constructed.
 *
 * @param raw - the candidate `REDIS_URL` value (possibly absent/blank/malformed).
 * @returns the validated `REDIS_URL` string, suitable for `new Redis(url, ...)`.
 * @throws {Error} if `raw` is absent/blank, is not a parseable URL, or does not use
 *                 the `redis:`/`rediss:` scheme, or omits a host.
 */
export function validateRedisUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'RedisModule: REDIS_URL environment variable is required but is absent or empty. ' +
        'Set REDIS_URL to a redis:// or rediss:// connection string.',
    );
  }

  const value = raw.trim();

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `RedisModule: REDIS_URL is not a valid connection URL. ` +
        `Expected a redis:// or rediss:// URL but could not parse the provided value.`,
    );
  }

  if (!VALID_REDIS_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `RedisModule: REDIS_URL must use the "redis:" or "rediss:" scheme but received ` +
        `"${parsed.protocol}". Provide a redis:// or rediss:// connection string.`,
    );
  }

  if (parsed.hostname === '') {
    throw new Error(
      'RedisModule: REDIS_URL must include a host. ' +
        'Provide a redis:// or rediss:// connection string with a hostname.',
    );
  }

  return value;
}
