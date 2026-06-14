/**
 * DevicesService — transactional device registration (design Component 4).
 *
 * Implements `registerDevice(uid, dto)`, the write half of `POST /api/devices/register`
 * (Section 15.3). The whole registration is one atomic unit of work executed through
 * {@link TransactionService.runInTransaction}, so every statement runs on a single
 * PgBouncer-leased connection and the transaction either commits in full or rolls back
 * in full — no partial device state ever survives a mid-write failure or a
 * unique-constraint conflict (Requirements 4.1–4.3, 2.5, 6.7).
 *
 * Within the transaction the service:
 * 1. Upserts the `users` row keyed by `firebase_uid`, so a returning user reuses their
 *    single row and exactly one user row exists per UID (Requirement 2.4).
 * 2. Upserts the `devices` row keyed by `(user_id, registration_id)`, so re-registering
 *    the same device updates it in place rather than creating a duplicate — exactly one
 *    device row per `(user, registrationId)` (Requirement 2.4).
 * 3. Replaces the device's signed prekey: the previous signed prekey rows for the device
 *    are removed and the supplied one is inserted in their place.
 * 4. Replaces the device's one-time prekeys: the previous batch is removed and the new
 *    batch inserted, keeping registration idempotent across reinstalls/token refreshes.
 *
 * All base64 key fields are decoded to {@link Buffer} and persisted as PUBLIC `bytea`
 * material only — identity key, signed prekey public key + signature, and one-time
 * prekey public keys. No field path accepts or stores a private key (Requirement 2.3,
 * 13.4); the DTO and global ValidationPipe guarantee only these public fields reach
 * this service.
 */

import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { RegisterDeviceResponse } from '@chat-app/types';

import {
  DeviceEntity,
  OneTimePreKeyEntity,
  SignedPreKeyEntity,
  TransactionService,
  UserEntity,
} from '../database';
import { RegisterDeviceDto } from './dto';
import { normalizeE164 } from '../directory/phone.util';

@Injectable()
export class DevicesService {
  constructor(private readonly transactions: TransactionService) {}

  /**
   * Registers (or re-registers) a device and publishes its public prekey bundle.
   *
   * @param uid - Canonical Firebase UID from a verified token (the caller's identity).
   * @param dto - Validated registration payload carrying PUBLIC key material only.
   * @returns The server-issued `deviceId` for the persisted device.
   *
   * The entire write runs inside one transaction (Requirements 4.1–4.3): on any failure
   * — including a unique-constraint conflict — every statement is rolled back and no
   * partial rows remain (Requirements 2.5, 6.7).
   */
  async registerDevice(
    uid: string,
    dto: RegisterDeviceDto,
    phoneNumber?: string,
  ): Promise<RegisterDeviceResponse> {
    return this.transactions.runInTransaction(async (manager) => {
      const userId = await this.upsertUser(manager, uid, phoneNumber);
      const deviceId = await this.upsertDevice(manager, userId, dto);

      await this.replaceSignedPreKey(manager, deviceId, dto);
      await this.replaceOneTimePreKeys(manager, deviceId, dto);

      // Postcondition: exactly one user row for `uid`, exactly one device row for
      // `(user, registrationId)`, and the device's prekey bundle is fully replaced.
      return { deviceId };
    });
  }

  /**
   * Upserts the `users` row keyed by `firebase_uid` and returns its id. Idempotent for
   * returning users — exactly one row per UID (Requirement 2.4).
   *
   * When the verified token carries a phone number it is persisted so the directory
   * (`POST /api/directory/resolve`) can resolve a phone to this UID for contact discovery.
   * A token WITHOUT a phone claim leaves any previously-stored number untouched (the field
   * is simply omitted from the upsert), so re-registering never blanks a known number.
   */
  private async upsertUser(
    manager: EntityManager,
    uid: string,
    phoneNumber?: string,
  ): Promise<string> {
    const row =
      phoneNumber !== undefined
        ? { firebaseUid: uid, phoneNumber: normalizeE164(phoneNumber) }
        : { firebaseUid: uid };
    await manager.upsert(UserEntity, row, ['firebaseUid']);
    const user = await manager.findOneByOrFail(UserEntity, { firebaseUid: uid });
    return user.id;
  }

  /**
   * Upserts the `devices` row keyed by `(user_id, registration_id)`, replacing the
   * device's public identity key and name on conflict, and returns its id. Re-registering
   * the same `(user, registrationId)` updates the existing row (Requirement 2.4).
   */
  private async upsertDevice(
    manager: EntityManager,
    userId: string,
    dto: RegisterDeviceDto,
  ): Promise<string> {
    await manager.upsert(
      DeviceEntity,
      {
        userId,
        registrationId: dto.registrationId,
        // PUBLIC identity key only — decoded from base64 to raw bytes (Requirement 2.3, 13.4).
        identityKey: Buffer.from(dto.identityKey, 'base64'),
        deviceName: dto.deviceName,
      },
      ['userId', 'registrationId'],
    );

    const device = await manager.findOneByOrFail(DeviceEntity, {
      userId,
      registrationId: dto.registrationId,
    });
    return device.id;
  }

  /**
   * Replaces the device's signed prekey: removes any existing signed prekey rows for the
   * device, then inserts the supplied one. `public_key` and `signature` are PUBLIC `bytea`
   * material only (Requirement 2.3, 13.4).
   */
  private async replaceSignedPreKey(
    manager: EntityManager,
    deviceId: string,
    dto: RegisterDeviceDto,
  ): Promise<void> {
    await manager.delete(SignedPreKeyEntity, { deviceId });
    await manager.insert(SignedPreKeyEntity, {
      deviceId,
      keyId: dto.signedPreKey.keyId,
      publicKey: Buffer.from(dto.signedPreKey.publicKey, 'base64'),
      signature: Buffer.from(dto.signedPreKey.signature, 'base64'),
    });
  }

  /**
   * Replaces the device's one-time prekeys: removes the previous batch, then inserts the
   * new one. Every inserted prekey references this device and carries a PUBLIC `public_key`
   * only (Requirement 2.3, 13.4).
   */
  private async replaceOneTimePreKeys(
    manager: EntityManager,
    deviceId: string,
    dto: RegisterDeviceDto,
  ): Promise<void> {
    await manager.delete(OneTimePreKeyEntity, { deviceId });

    // Loop/map invariant: every row belongs to `deviceId` and holds public key bytes only.
    const rows = dto.oneTimePreKeys.map((pk) => ({
      deviceId,
      keyId: pk.keyId,
      publicKey: Buffer.from(pk.publicKey, 'base64'),
    }));
    await manager.insert(OneTimePreKeyEntity, rows);
  }
}
