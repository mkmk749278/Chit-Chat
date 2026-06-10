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

import { Injectable, NotFoundException } from '@nestjs/common';
import type { ResolvePhoneResponse } from '@chat-app/types';

import { TransactionService, UserEntity } from '../database';

@Injectable()
export class DirectoryService {
  constructor(private readonly transactions: TransactionService) {}

  /**
   * Resolve an E.164 phone number to the registered owner's Firebase UID.
   *
   * @param phoneNumber - the recipient phone number in E.164 form.
   * @returns the canonical Firebase UID of the user registered with that number.
   * @throws NotFoundException (HTTP 404) when no user with that number has a device.
   */
  async resolvePhone(phoneNumber: string): Promise<ResolvePhoneResponse> {
    return this.transactions.runInTransaction(async (manager) => {
      // Require an existing device so the resolved UID is actually messageable: a sender's
      // next step (GET /api/keys/:uid) needs a registered device or it would 404 anyway.
      const user = await manager
        .createQueryBuilder(UserEntity, 'user')
        .innerJoin('user.devices', 'device')
        .where('user.phone_number = :phoneNumber', { phoneNumber })
        .select('user.firebase_uid', 'firebaseUid')
        .limit(1)
        .getRawOne<{ firebaseUid: string }>();

      if (user === undefined) {
        throw new NotFoundException('No registered user found for that phone number');
      }
      return { uid: user.firebaseUid };
    });
  }
}
