import { Logger, type Provider } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';

import { AppConfigService } from '../config';
import {
  REDIS_COMMAND_CLIENT,
  REDIS_CONNECTION_URL,
  REDIS_PUBLISHER_CLIENT,
  REDIS_SUBSCRIBER_CLIENT,
} from './redis.constants';
import { createRedisRetryStrategy } from './redis-retry-strategy';
import { validateRedisUrl } from './redis-url';

/**
 * Human-readable role for each connection, used only in log lines so reconnection
 * activity can be attributed to the right client.
 */
export type RedisClientRole = 'command' | 'subscriber' | 'publisher';

/**
 * Builds the shared ioredis options applied to every connection.
 *
 * The {@link createRedisRetryStrategy} backoff (Requirement 7.2) is the key piece;
 * `maxRetriesPerRequest: null` keeps in-flight commands queued across reconnects
 * rather than failing them immediately, so the exponential backoff governs recovery.
 */
function buildRedisOptions(role: RedisClientRole): RedisOptions {
  return {
    // Exponential backoff: 500 ms → 30 s cap, with jitter (Requirement 7.2).
    retryStrategy: createRedisRetryStrategy(),
    // Let the retryStrategy drive reconnection instead of erroring out commands.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Names surface in `CLIENT LIST` / Redis logs, easing per-role diagnosis.
    connectionName: `chat-backend:${role}`,
  };
}

/**
 * Constructs a single ioredis connection for the given role. Each call opens a
 * distinct TCP connection to the Redis server (Requirement 7.1), so the command,
 * subscriber, and publisher never share a socket — required because a subscriber
 * connection cannot issue ordinary commands while in subscribe mode.
 */
function createRedisClient(url: string, role: RedisClientRole): Redis {
  const logger = new Logger(`RedisClient:${role}`);
  const client = new Redis(url, buildRedisOptions(role));

  client.on('error', (err: Error) => {
    // Errors are logged (not thrown) so a transient outage triggers backoff/reconnect
    // rather than crashing the process; the retryStrategy handles recovery.
    logger.error(`Redis ${role} client error: ${err.message}`);
  });

  return client;
}

/**
 * Provider for the validated `REDIS_URL`. The value is sourced from the typed
 * {@link AppConfigService} (the canonical config accessor) and then parse-validated
 * here, so the whole module fails fast at initialization if the URL is missing or
 * unparseable (Requirement 7.6), before any client connection is attempted.
 */
const redisUrlProvider: Provider = {
  provide: REDIS_CONNECTION_URL,
  useFactory: (config: AppConfigService): string => validateRedisUrl(config.redisUrl),
  inject: [AppConfigService],
};

/** Command client: cache, presence registry, and rate-limit counters. */
const commandClientProvider: Provider = {
  provide: REDIS_COMMAND_CLIENT,
  useFactory: (url: string): Redis => createRedisClient(url, 'command'),
  inject: [REDIS_CONNECTION_URL],
};

/** Dedicated pub/sub subscriber connection. */
const subscriberClientProvider: Provider = {
  provide: REDIS_SUBSCRIBER_CLIENT,
  useFactory: (url: string): Redis => createRedisClient(url, 'subscriber'),
  inject: [REDIS_CONNECTION_URL],
};

/** Dedicated pub/sub publisher connection. */
const publisherClientProvider: Provider = {
  provide: REDIS_PUBLISHER_CLIENT,
  useFactory: (url: string): Redis => createRedisClient(url, 'publisher'),
  inject: [REDIS_CONNECTION_URL],
};

/**
 * All providers contributed by the RedisModule. The URL provider is internal; the
 * three client providers are exported for other modules to inject.
 */
export const redisProviders: Provider[] = [
  redisUrlProvider,
  commandClientProvider,
  subscriberClientProvider,
  publisherClientProvider,
];
