import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { AuthContext } from '@chat-app/types';

import { REDIS_COMMAND_CLIENT } from './redis.constants';

/**
 * Redis key prefix for cached Firebase token-verification results. The full key is
 * `fbtoken:{sha256(token)}` — only the SHA-256 hash of the raw token ever appears in
 * the key, never the token itself (Requirement 13.2 / §11.2).
 */
const TOKEN_CACHE_KEY_PREFIX = 'fbtoken:';

/**
 * TokenCacheService — the `fbtoken:{sha256(token)}` cache helper (Requirements 7.3,
 * 7.5, 13.2; design Component 2 + "Cached token verification").
 *
 * Backs the cached-verification path of the auth layer: a verified {@link AuthContext}
 * is stored as JSON under a key derived from the SHA-256 hash of the raw Firebase ID
 * token, with a caller-supplied TTL (`exp - now`) applied via `SETEX` so a cache entry
 * can never outlive the token. Reads return the parsed `AuthContext` on a hit, `null`
 * on a miss.
 *
 * Security invariant (Requirement 13.2): the raw token is NEVER used as a Redis key or
 * stored as a value. Only its SHA-256 hash is used to construct the key, and only the
 * derived `AuthContext` (uid + claims, no token) is stored as the value.
 *
 * This helper performs no Firebase verification itself; the auth layer (task 5.x) owns
 * the verify-on-miss flow and calls {@link set} with the resulting context and TTL.
 */
@Injectable()
export class TokenCacheService {
  private readonly logger = new Logger(TokenCacheService.name);

  constructor(@Inject(REDIS_COMMAND_CLIENT) private readonly redis: Redis) {}

  /**
   * Looks up a cached {@link AuthContext} for the given raw token.
   *
   * @param token - the raw Firebase ID token (used only to derive the SHA-256 key).
   * @returns the cached `AuthContext` on a hit, or `null` on a miss / unparseable entry.
   */
  async get(token: string): Promise<AuthContext | null> {
    const key = TokenCacheService.cacheKey(token);
    const cached = await this.redis.get(key);
    if (cached === null) {
      return null;
    }

    try {
      return JSON.parse(cached) as AuthContext;
    } catch (err) {
      // A corrupt/unparseable entry is treated as a miss so the caller falls back to
      // authoritative verification rather than throwing. The key is hash-derived, so
      // logging it leaks no token material.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Discarding unparseable token cache entry ${key}: ${message}`);
      return null;
    }
  }

  /**
   * Caches a verified {@link AuthContext} for the given raw token with the supplied TTL.
   *
   * The entry is written with `SETEX` so it auto-expires; callers pass `exp - now`
   * (clamped to a small positive minimum) so the cache entry never outlives the token.
   * When `ttlSeconds <= 0` the write is skipped entirely — there is nothing to cache for
   * an already-expired token.
   *
   * @param token       - the raw Firebase ID token (used only to derive the SHA-256 key).
   * @param authContext - the verified identity to cache (stored as JSON, no token bytes).
   * @param ttlSeconds  - cache lifetime in seconds; values `<= 0` skip the write.
   */
  async set(token: string, authContext: AuthContext, ttlSeconds: number): Promise<void> {
    // An expired/zero TTL has nothing worth caching — skip rather than error.
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return;
    }

    const key = TokenCacheService.cacheKey(token);
    // SETEX takes an integer TTL; floor any fractional seconds (still >= 1 here).
    const ttl = Math.floor(ttlSeconds);
    await this.redis.setex(key, ttl, JSON.stringify(authContext));
  }

  /**
   * Builds the cache key `fbtoken:{sha256(token)}`. Only the hex SHA-256 digest of the
   * token is embedded — the raw token never appears in a key (Requirement 13.2).
   */
  private static cacheKey(token: string): string {
    const hash = createHash('sha256').update(token).digest('hex');
    return `${TOKEN_CACHE_KEY_PREFIX}${hash}`;
  }
}
