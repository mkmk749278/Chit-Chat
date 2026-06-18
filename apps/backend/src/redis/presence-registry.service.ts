import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_COMMAND_CLIENT } from './redis.constants';

/**
 * Redis key prefix for the per-user connection/session registry. The full key is
 * `presence:{uid}` and holds a hash mapping each live connection id to the backend
 * node that owns it (`{connId -> nodeId}`), per the design's Redis key model (§12.3).
 */
const PRESENCE_KEY_PREFIX = 'presence:';

/**
 * Redis key prefix for a user's coarse last-seen timestamp (unix ms), written on disconnect.
 * The full key is `lastseen:{uid}`. Kept separate from the connection registry so it survives
 * after the user goes offline (the `presence:{uid}` hash is deleted when the last connection
 * drops). Expires after {@link LAST_SEEN_TTL_SECONDS} so it is not retained indefinitely.
 */
const LAST_SEEN_KEY_PREFIX = 'lastseen:';

/** Retention for a stored last-seen timestamp: 30 days. */
const LAST_SEEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The connections registered for a single user: a mapping of `connId -> nodeId`, i.e.
 * the raw shape of the `presence:{uid}` hash returned by `HGETALL`. An empty object
 * means the user has no live connection (offline).
 */
export type PresenceEntries = Record<string, string>;

/**
 * PresenceRegistryService — the `presence:{uid}` connection-registry helper
 * (Requirement 7.3; design Component 5 `ConnectionRegistry` + Redis key model).
 *
 * Tracks which backend node holds which of a user's live WebSocket connections by
 * storing a Redis hash per uid: field = `connId`, value = `nodeId`. The Realtime
 * gateway (task 7.x) calls {@link add} on a successful handshake, {@link remove} on
 * disconnect, and {@link lookup} when Phase 1 needs to route to a user's nodes.
 *
 * Only opaque identifiers (uid, connId, nodeId) are stored — never tokens or any
 * secret material — so the registry carries no sensitive data.
 */
@Injectable()
export class PresenceRegistryService {
  constructor(@Inject(REDIS_COMMAND_CLIENT) private readonly redis: Redis) {}

  /**
   * Registers a connection for `uid` as `connId -> nodeId` in the `presence:{uid}`
   * hash. Idempotent: re-adding the same `connId` overwrites it with the supplied
   * `nodeId` (design Component 5 postconditions).
   *
   * @param uid    - the connection owner's canonical Firebase UID.
   * @param connId - the connection id, unique for the socket's lifetime.
   * @param nodeId - the backend node holding the connection.
   */
  async add(uid: string, connId: string, nodeId: string): Promise<void> {
    await this.redis.hset(PresenceRegistryService.presenceKey(uid), connId, nodeId);
  }

  /**
   * Removes a single connection (`connId`) from the user's `presence:{uid}` hash.
   * Removing the last remaining connection leaves the hash empty, which Redis treats
   * as a deleted key, so the user is implicitly marked offline. Removing a `connId`
   * that is not present is a no-op.
   *
   * @param uid    - the connection owner's canonical Firebase UID.
   * @param connId - the connection id to remove.
   */
  async remove(uid: string, connId: string): Promise<void> {
    await this.redis.hdel(PresenceRegistryService.presenceKey(uid), connId);
  }

  /**
   * Looks up every live connection registered for `uid`.
   *
   * @param uid - the canonical Firebase UID to look up.
   * @returns a `connId -> nodeId` mapping; an empty object when the user is offline.
   */
  async lookup(uid: string): Promise<PresenceEntries> {
    return this.redis.hgetall(PresenceRegistryService.presenceKey(uid));
  }

  /**
   * Whether `uid` currently holds at least one live connection (online). Derived from the
   * `presence:{uid}` registry, so it reflects real connection state without any extra writes.
   */
  async isOnline(uid: string): Promise<boolean> {
    const count = await this.redis.hlen(PresenceRegistryService.presenceKey(uid));
    return count > 0;
  }

  /**
   * Record `uid`'s last-seen instant (now, unix ms) for opted-in presence (Req 5.2/5.4). Called
   * on disconnect. Best-effort and TTL-bounded; stored separately from the connection registry so
   * it persists after the user goes offline. The caller gates this on the user's opt-in.
   */
  async recordLastSeen(uid: string, atMs: number): Promise<void> {
    await this.redis.set(
      PresenceRegistryService.lastSeenKey(uid),
      String(atMs),
      'EX',
      LAST_SEEN_TTL_SECONDS,
    );
  }

  /** Read `uid`'s stored last-seen unix-ms timestamp, or `null` when none is recorded. */
  async getLastSeen(uid: string): Promise<number | null> {
    const raw = await this.redis.get(PresenceRegistryService.lastSeenKey(uid));
    if (raw === null) {
      return null;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Builds the registry key `presence:{uid}`. */
  private static presenceKey(uid: string): string {
    return `${PRESENCE_KEY_PREFIX}${uid}`;
  }

  /** Builds the last-seen key `lastseen:{uid}`. */
  private static lastSeenKey(uid: string): string {
    return `${LAST_SEEN_KEY_PREFIX}${uid}`;
  }
}
