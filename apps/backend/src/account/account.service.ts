/**
 * AccountService — permanent account deletion (Google Play account-deletion policy; GDPR
 * right to erasure).
 *
 * Deletes everything the server holds for a user:
 *   1. Postgres: the `users` row, which cascades to `devices`, `signed_prekeys`, and
 *      `one_time_prekeys` (ON DELETE CASCADE) — the phone number, display name, public keys, and
 *      push tokens go with it.
 *   2. Redis: the undelivered-message inbox (and any pre-v2 offline list), presence, last-seen,
 *      the attachment quota counter, and the wake-push debounce marker. Attachment blobs are not
 *      indexed by uploader; they are opaque ciphertext and expire on their own TTL (7 days).
 *   3. Firebase Auth: the sign-in identity itself, so the phone number no longer maps to this
 *      account (a later sign-in creates a brand-new account).
 *
 * Idempotent and ordered so a retry always converges: our own data first, the Firebase identity
 * last. If Firebase is unreachable the call fails (the client shows "try again") and a retry
 * finds nothing left in Postgres/Redis and only has to finish step 3.
 *
 * Message CONTENT was never stored server-side (end-to-end encrypted, inbox ciphertext only), and
 * conversation history lives on the user's devices, which the client wipes itself.
 */

import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { FirebaseAdminService } from '../auth';
import { TransactionService, UserEntity } from '../database';
import { REDIS_COMMAND_CLIENT } from '../redis';

/** Per-user Redis keys holding account state (see the owning services for each prefix). */
const USER_KEY_PREFIXES = [
  'inbox:',
  'offline:',
  'presence:',
  'lastseen:',
  'blob-quota:',
  'push-wake:',
] as const;

@Injectable()
export class AccountService {
  constructor(
    private readonly transactions: TransactionService,
    @Inject(REDIS_COMMAND_CLIENT) private readonly redis: Redis,
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {}

  /**
   * Permanently delete `uid`'s account and server-side data.
   *
   * @throws when a step fails (typically Firebase unreachable); safe to retry.
   */
  async deleteAccount(uid: string): Promise<void> {
    await this.transactions.runInTransaction(async (manager) => {
      await manager.delete(UserEntity, { firebaseUid: uid });
    });
    await this.redis.del(...USER_KEY_PREFIXES.map((prefix) => `${prefix}${uid}`));
    await this.firebaseAdmin.deleteUser(uid);
  }
}
