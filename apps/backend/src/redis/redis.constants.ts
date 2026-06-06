/**
 * Dependency-injection tokens for the three distinct `ioredis` connections the
 * Redis speed layer provides (Requirement 7.1):
 *
 * - command client   — cache reads/writes, presence registry, rate-limit counters
 * - subscriber client — dedicated pub/sub subscriber (ioredis enters subscriber
 *   mode on a connection and cannot issue normal commands while subscribed)
 * - publisher client — dedicated pub/sub publisher, kept separate so publishing is
 *   never blocked by the subscriber connection's mode
 *
 * Consumers inject a client with `@Inject(REDIS_COMMAND_CLIENT)` etc. Tokens are
 * `Symbol`s so they never collide with other string-keyed providers.
 */
export const REDIS_COMMAND_CLIENT = Symbol('REDIS_COMMAND_CLIENT');
export const REDIS_SUBSCRIBER_CLIENT = Symbol('REDIS_SUBSCRIBER_CLIENT');
export const REDIS_PUBLISHER_CLIENT = Symbol('REDIS_PUBLISHER_CLIENT');

/**
 * Internal token holding the validated `REDIS_URL` string. The three client
 * factories depend on it so the URL is resolved and validated exactly once at
 * module initialization (Requirement 7.6).
 */
export const REDIS_CONNECTION_URL = Symbol('REDIS_CONNECTION_URL');
