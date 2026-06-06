/**
 * Public surface of the Redis speed-layer module.
 *
 * Other backend modules import the DI tokens to inject a client, e.g.:
 *
 * ```ts
 * constructor(@Inject(REDIS_COMMAND_CLIENT) private readonly redis: Redis) {}
 * ```
 */
export { RedisModule } from './redis.module';
export {
  REDIS_COMMAND_CLIENT,
  REDIS_SUBSCRIBER_CLIENT,
  REDIS_PUBLISHER_CLIENT,
} from './redis.constants';
export {
  createRedisRetryStrategy,
  REDIS_RETRY_BASE_DELAY_MS,
  REDIS_RETRY_MAX_DELAY_MS,
} from './redis-retry-strategy';
export { resolveRedisUrl, validateRedisUrl } from './redis-url';
export { TokenCacheService } from './token-cache.service';
export { PresenceRegistryService, type PresenceEntries } from './presence-registry.service';
export {
  RateLimiterService,
  RateLimitConfigError,
  type RateLimitResult,
  MIN_WINDOW_SECONDS,
  MAX_WINDOW_SECONDS,
  MIN_LIMIT,
  MAX_LIMIT,
} from './rate-limiter.service';
