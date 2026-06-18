/**
 * PresenceService — opt-in online/last-seen reads (Phase 2, Requirement 5.1, 5.2, 5.4).
 *
 * Combines the durable opt-in flag on the `users` row with the live `presence:{uid}` connection
 * registry and the `lastseen:{uid}` timestamp (both in Redis) to answer "is this peer online,
 * and when were they last seen?" — but ONLY for users who have opted in.
 *
 * Privacy is the default (Req 5.1): a user who has not opted in is reported as
 * `{ online: null, lastSeen: null }`, indistinguishable from an unknown UID, so opting out never
 * leaks activity. Last-seen is coarsened to a 5-minute bucket so it is never exact-to-the-second
 * (Req 5.4), and is omitted entirely while the user is currently online.
 */

import { Injectable } from '@nestjs/common';
import type { PresenceResponse } from '@chat-app/types';

import { UserEntity, TransactionService } from '../database';
import { PresenceRegistryService } from '../redis';

/** Last-seen granularity: round down to the nearest 5 minutes (Req 5.4). */
const LAST_SEEN_BUCKET_MS = 5 * 60 * 1000;

@Injectable()
export class PresenceService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly registry: PresenceRegistryService,
  ) {}

  /**
   * Set the caller's presence opt-in. Upserts the `users` row so it works whether or not the
   * user has registered a device yet.
   */
  async setEnabled(uid: string, enabled: boolean): Promise<void> {
    await this.transactions.runInTransaction(async (manager) => {
      await manager.upsert(UserEntity, { firebaseUid: uid, presenceEnabled: enabled }, ['firebaseUid']);
    });
  }

  /**
   * Resolve a user's presence as seen by a peer. Returns `{ online: null, lastSeen: null }` for a
   * user who has not opted in (or is unknown). For an opted-in user, `online` reflects the live
   * connection registry and `lastSeen` is a coarse timestamp (omitted while online).
   */
  async getPresence(uid: string): Promise<PresenceResponse> {
    const optedIn = await this.transactions.runInTransaction(async (manager) => {
      const user = await manager.findOne(UserEntity, { where: { firebaseUid: uid } });
      return user?.presenceEnabled === true;
    });
    if (!optedIn) {
      return { uid, online: null, lastSeen: null };
    }

    const online = await this.registry.isOnline(uid);
    if (online) {
      return { uid, online: true, lastSeen: null };
    }

    const lastSeenRaw = await this.registry.getLastSeen(uid);
    const lastSeen =
      lastSeenRaw === null ? null : Math.floor(lastSeenRaw / LAST_SEEN_BUCKET_MS) * LAST_SEEN_BUCKET_MS;
    return { uid, online: false, lastSeen };
  }
}
