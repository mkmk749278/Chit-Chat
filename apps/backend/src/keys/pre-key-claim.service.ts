/**
 * PreKeyClaimService — design Backend Component A (Phase 1, Requirement 5.1).
 *
 * Serves a recipient's PUBLIC prekey bundle to a sender so a libsignal session can be
 * established to the recipient's device, atomically consuming one of the recipient's
 * unconsumed one-time prekeys. This is the write/read half of `GET /api/keys/:uid`
 * (the guarded controller is task 4.2); this service owns the business logic only.
 *
 * Claim semantics (Requirement 5.1):
 *   1. Resolve `recipientUid` (a Firebase UID) → its single device row (Phase 1 assumes
 *      exactly one device per user). A missing user or device is surfaced as a 404 via
 *      {@link NotFoundException}.
 *   2. Read the device's PUBLIC identity key and its active signed prekey (public key +
 *      signature).
 *   3. Atomically claim one unconsumed one-time prekey: `SELECT ... WHERE consumed_at IS
 *      NULL ... FOR UPDATE SKIP LOCKED LIMIT 1` (riding the partial index
 *      `idx_onetime_prekeys_device_unconsumed`), then set `consumed_at = now()` on the
 *      claimed row. `SKIP LOCKED` lets concurrent senders each claim a *different* unused
 *      prekey without blocking, and the row lock guarantees no two senders claim the same
 *      one. When the device's one-time prekeys are exhausted the claim yields `null` and
 *      the sender falls back to the signed prekey only.
 *
 * The whole claim runs inside {@link TransactionService.runInTransaction} so the locking
 * SELECT and the consuming UPDATE execute on one PgBouncer-leased connection — the row
 * lock taken by `FOR UPDATE` is only meaningful for the lifetime of the transaction that
 * holds it (Requirement 4.4).
 *
 * Every key field returned is PUBLIC `bytea` material, base64-encoded for transport; no
 * field path reads or returns private key material (Requirements 2.4, 2.5, 8.1).
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { PreKeyBundleResponse } from '@chat-app/types';

import {
  DeviceEntity,
  OneTimePreKeyEntity,
  SignedPreKeyEntity,
  TransactionService,
  UserEntity,
} from '../database';

@Injectable()
export class PreKeyClaimService {
  constructor(private readonly transactions: TransactionService) {}

  /**
   * Claims a public prekey bundle for the recipient's (single, Phase 1) device.
   *
   * @param recipientUid - Canonical Firebase UID of the recipient.
   * @returns The recipient device's identity key + active signed prekey, plus one claimed
   *   one-time prekey, or `oneTimePreKey: null` when the device's one-time prekeys are
   *   exhausted.
   * @throws NotFoundException when the recipient has no registered device (or no fully
   *   registered key material), surfaced by the controller as HTTP 404.
   */
  async claimForUser(recipientUid: string): Promise<PreKeyBundleResponse> {
    return this.transactions.runInTransaction(async (manager) => {
      const device = await this.resolveDevice(manager, recipientUid);
      const signedPreKey = await this.loadActiveSignedPreKey(manager, device.id);
      const oneTimePreKey = await this.claimOneTimePreKey(manager, device.id);

      return {
        deviceId: device.id,
        registrationId: device.registrationId,
        // PUBLIC identity key only — raw bytes re-encoded to base64 for transport.
        identityKey: device.identityKey.toString('base64'),
        signedPreKey: {
          keyId: signedPreKey.keyId,
          publicKey: signedPreKey.publicKey.toString('base64'),
          signature: signedPreKey.signature.toString('base64'),
        },
        oneTimePreKey: oneTimePreKey
          ? {
              keyId: oneTimePreKey.keyId,
              publicKey: oneTimePreKey.publicKey.toString('base64'),
            }
          : null,
      };
    });
  }

  /**
   * Resolves `recipientUid` → its single device row. Throws {@link NotFoundException}
   * when the user is unknown or has no registered device (Requirement 5.1 → 404).
   */
  private async resolveDevice(
    manager: EntityManager,
    recipientUid: string,
  ): Promise<DeviceEntity> {
    const user = await manager.findOneBy(UserEntity, { firebaseUid: recipientUid });
    if (!user) {
      throw new NotFoundException('Recipient has no registered device');
    }

    // Phase 1: a single device per user. Pick deterministically (earliest registered)
    // in case stale rows exist, so the bundle resolves to a stable device.
    const device = await manager.findOne(DeviceEntity, {
      where: { userId: user.id },
      order: { createdAt: 'ASC' },
    });
    if (!device) {
      throw new NotFoundException('Recipient has no registered device');
    }
    return device;
  }

  /**
   * Loads the device's active signed prekey (public key + signature). Registration
   * always replaces the signed prekey, so exactly one row is expected; the most recent
   * is chosen defensively. A missing signed prekey means the device is not fully
   * registered and is surfaced as a 404 (Requirement 5.1).
   */
  private async loadActiveSignedPreKey(
    manager: EntityManager,
    deviceId: string,
  ): Promise<SignedPreKeyEntity> {
    const signedPreKey = await manager.findOne(SignedPreKeyEntity, {
      where: { deviceId },
      order: { createdAt: 'DESC' },
    });
    if (!signedPreKey) {
      throw new NotFoundException('Recipient has no registered device');
    }
    return signedPreKey;
  }

  /**
   * Atomically claims one unconsumed one-time prekey for the device, or returns `null`
   * when none remain (Requirement 5.1).
   *
   * Uses a locking SELECT — `WHERE consumed_at IS NULL ... FOR UPDATE SKIP LOCKED LIMIT 1`
   * (partial index `idx_onetime_prekeys_device_unconsumed`) — so concurrent senders skip
   * rows already locked by another in-flight claim and never hand out the same prekey
   * twice. The claimed row is then marked `consumed_at = now()` within the same
   * transaction, on the same pooled connection that holds the lock.
   */
  private async claimOneTimePreKey(
    manager: EntityManager,
    deviceId: string,
  ): Promise<OneTimePreKeyEntity | null> {
    const claimed = await manager
      .createQueryBuilder(OneTimePreKeyEntity, 'otp')
      .where('otp.deviceId = :deviceId', { deviceId })
      .andWhere('otp.consumedAt IS NULL')
      .orderBy('otp.keyId', 'ASC')
      .limit(1)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getOne();

    if (!claimed) {
      // One-time prekeys exhausted: the sender falls back to the signed prekey only.
      return null;
    }

    await manager.update(
      OneTimePreKeyEntity,
      { id: claimed.id },
      { consumedAt: () => 'now()' },
    );

    return claimed;
  }
}
