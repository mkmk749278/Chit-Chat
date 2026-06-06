import { Global, Inject, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';

import { PresenceRegistryService } from './presence-registry.service';
import { RateLimiterService } from './rate-limiter.service';
import {
  REDIS_COMMAND_CLIENT,
  REDIS_PUBLISHER_CLIENT,
  REDIS_SUBSCRIBER_CLIENT,
} from './redis.constants';
import { redisProviders } from './redis.providers';
import { TokenCacheService } from './token-cache.service';

/**
 * RedisModule — the Redis speed-layer wiring (design Component 6, Requirement 7).
 *
 * Provides the three distinct `ioredis` connections — a command client, a dedicated
 * subscriber, and a dedicated publisher — all built from `REDIS_URL` with exponential
 * reconnection backoff (500 ms → 30 s cap, jittered), and fails initialization when
 * `REDIS_URL` is absent or unparseable (Requirements 7.1, 7.2, 7.6).
 *
 * On top of the connections it exposes the speed-layer helpers: the
 * {@link TokenCacheService} (`fbtoken:{sha256(token)}` cache, Requirements 7.3,
 * 7.5, 13.2), the {@link PresenceRegistryService} (`presence:{uid}` connection
 * registry, Requirement 7.3), and the {@link RateLimiterService} (`ratelimit:{scope}:{id}`
 * fixed-window counter, Requirement 5.x) built in task 4.3.
 *
 * Marked `@Global` and exporting the client tokens and helpers so AuthModule,
 * RealtimeModule, DevicesModule, and HealthModule can inject them without
 * re-declaring providers.
 */
@Global()
@Module({
  providers: [...redisProviders, TokenCacheService, PresenceRegistryService, RateLimiterService],
  exports: [
    REDIS_COMMAND_CLIENT,
    REDIS_SUBSCRIBER_CLIENT,
    REDIS_PUBLISHER_CLIENT,
    TokenCacheService,
    PresenceRegistryService,
    RateLimiterService,
  ],
})
export class RedisModule implements OnModuleDestroy {
  private readonly logger = new Logger(RedisModule.name);

  constructor(
    @Inject(REDIS_COMMAND_CLIENT) private readonly commandClient: Redis,
    @Inject(REDIS_SUBSCRIBER_CLIENT) private readonly subscriberClient: Redis,
    @Inject(REDIS_PUBLISHER_CLIENT) private readonly publisherClient: Redis,
  ) {}

  /**
   * Gracefully closes all three connections on application shutdown so the process
   * can exit cleanly and Redis releases the sockets. `quit()` drains pending commands;
   * any failure is logged but never rethrown so one client's close cannot block the
   * others.
   */
  async onModuleDestroy(): Promise<void> {
    const clients: ReadonlyArray<readonly [string, Redis]> = [
      ['command', this.commandClient],
      ['subscriber', this.subscriberClient],
      ['publisher', this.publisherClient],
    ];

    await Promise.all(
      clients.map(async ([role, client]) => {
        try {
          await client.quit();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to gracefully quit Redis ${role} client: ${message}`);
        }
      }),
    );
  }
}
