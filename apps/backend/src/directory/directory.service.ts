/**
 * DirectoryService — phone→UID contact discovery (design Backend directory surface).
 *
 * Implements `resolvePhone(phoneNumber)`, the read half of `POST /api/directory/resolve`.
 * Given an E.164 phone number it returns the canonical Firebase UID of a user who (a) has
 * that phone number on record and (b) has at least one registered device — i.e. a user a
 * sender can actually claim a prekey bundle for and message. When no such user exists it
 * throws {@link NotFoundException} (HTTP 404), so a caller cannot distinguish "not a user"
 * from "user without a device" beyond "cannot start a chat".
 *
 * Phone numbers are matched against the value captured from the recipient's own verified
 * Firebase token at device registration (never a client-supplied claim), so a match means
 * the owner of that number authenticated and registered a device themselves.
 *
 * Privacy note: this is, by design, an enumerable lookup (an authenticated caller can test
 * whether a given number is registered). That tradeoff was an explicit product decision for
 * phone-based discovery; the surface is authenticated and per-uid rate-limited to blunt bulk
 * enumeration. A future privacy-preserving contact-discovery scheme can replace this service
 * behind the same controller without changing clients.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ResolvePhoneResponse } from '@chat-app/types';

import { DeviceEntity, TransactionService, UserEntity } from '../database';
import { normalizeE164 } from './phone.util';

@Injectable()
export class DirectoryService {
  private readonly logger = new Logger(DirectoryService.name);

  constructor(private readonly transactions: TransactionService) {}

  /**
   * Resolve an E.164 phone number to the registered owner's Firebase UID.
   *
   * Both the stored number and the query are reduced to canonical E.164 ({@link normalizeE164})
   * so a match never depends on formatting. The user row and its device count are looked up as
   * two simple queries (no relations join), avoiding any `findOne`+OneToMany pagination quirk —
   * the previous relation/raw-builder forms silently matched nothing on the live DB.
   *
   * @returns the canonical Firebase UID of the user registered with that number.
   * @throws NotFoundException (HTTP 404) when no user with that number has a device.
   */
  async resolvePhone(phoneNumber: string): Promise<ResolvePhoneResponse> {
    const normalized = normalizeE164(phoneNumber);
    return this.transactions.runInTransaction(async (manager) => {
      const user = await manager.findOne(UserEntity, { where: { phoneNumber: normalized } });
      if (user === null) {
        throw new NotFoundException('No registered user found for that phone number');
      }
      const deviceCount = await manager.count(DeviceEntity, { where: { userId: user.id } });
      if (deviceCount === 0) {
        throw new NotFoundException('No registered user found for that phone number');
      }
      return { uid: user.firebaseUid, displayName: user.displayName ?? null };
    });
  }

  /**
   * Set the signed-in user's display name (shown to peers instead of their UID). Upserts the
   * `users` row so it works whether or not the user has registered a device yet.
   */
  async setDisplayName(uid: string, displayName: string): Promise<void> {
    await this.transactions.runInTransaction(async (manager) => {
      await manager.upsert(UserEntity, { firebaseUid: uid, displayName }, ['firebaseUid']);
    });
  }

  /**
   * Resolve a user's PUBLIC profile (display name) by their Firebase UID — the reverse of
   * phone→UID discovery. Used so a recipient can show an inbound sender by name instead of a
   * raw UID, even when they never started the chat themselves (the sender's UID is known from
   * the inbound envelope, but its display name is not).
   *
   * Only the public display name is returned; no phone number or other account detail leaves
   * the looked-up user's row. A UID with no user row (or no name set) yields `displayName: null`
   * rather than a 404, so the caller can fall back to the UID without treating "no name" as an
   * error.
   *
   * @returns `{ uid, displayName }` for the requested UID; `displayName` is `null` when unknown.
   */
  async getProfile(uid: string): Promise<{ uid: string; displayName: string | null }> {
    return this.transactions.runInTransaction(async (manager) => {
      const user = await manager.findOne(UserEntity, { where: { firebaseUid: uid } });
      return { uid, displayName: user?.displayName ?? null };
    });
  }

  /**
   * Diagnostic: report what the server has on record for the authenticated caller — the
   * phone number STORED on their `users` row and how many devices they have registered.
   * Compared against the phone the caller's TOKEN carries (read in the controller), this
   * pinpoints whether a discovery miss is a token problem, a storage problem, or simply a
   * not-registered peer. No PII leaves the caller's own account.
   */
  async whoAmI(
    uid: string,
  ): Promise<{
    storedPhone: string | null;
    displayName: string | null;
    deviceCount: number;
    presenceEnabled: boolean;
    selfLookup: string;
  }> {
    const base = await this.transactions.runInTransaction(async (manager) => {
      const user = await manager.findOne(UserEntity, { where: { firebaseUid: uid } });
      if (user === null) {
        return {
          storedPhone: null as string | null,
          displayName: null as string | null,
          deviceCount: 0,
          presenceEnabled: false,
        };
      }
      const deviceCount = await manager.count(DeviceEntity, { where: { userId: user.id } });
      return {
        storedPhone: user.phoneNumber ?? null,
        displayName: user.displayName ?? null,
        deviceCount,
        presenceEnabled: user.presenceEnabled === true,
      };
    });

    // Server-side self-lookup: resolve our OWN stored phone in-process. This bypasses the
    // HTTP layer, rate limiter, and the client entirely, so its outcome is the ground truth
    // of whether discovery works for this user. `ok:<uid>` ⇒ discovery works.
    let selfLookup: string;
    if (base.storedPhone === null) {
      selfLookup = 'no stored phone';
    } else {
      try {
        const resolved = await this.resolvePhone(base.storedPhone);
        selfLookup = `ok:${resolved.uid}`;
      } catch (err) {
        selfLookup = `fail:${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return { ...base, selfLookup };
  }
}
