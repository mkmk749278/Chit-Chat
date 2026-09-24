/**
 * FcmPushSender — the real {@link PushSender} backed by Firebase Cloud Messaging (Phase 2, Req
 * 6.2/6.3; production-readiness roadmap P0 "offline push").
 *
 * It reuses the SAME Firebase Admin app the backend already initializes for token verification
 * (`FirebaseAdminService`, named {@link FIREBASE_APP_NAME}) — the project that powers phone-OTP auth
 * — so no extra credentials are needed beyond the existing `FIREBASE_*` secrets. It resolves that
 * app by name via `getApps()` and sends through `firebase-admin/messaging`.
 *
 * Content-free by contract: it forwards ONLY the routing `data` map it is given (e.g. `{type:'wake'}`)
 * as a DATA-ONLY message — never a `notification` block, never message text or sender plaintext
 * (cross-cutting invariant C1). The client wakes, connects, and drains the encrypted offline queue.
 *
 * Self-degrading + best-effort: if the Firebase app is not initialized (e.g. CI / a self-hosted
 * deployment without `FIREBASE_*` creds), or the FCM call fails, it logs a count-only line and
 * returns — it NEVER throws, so it can never break message relay/enqueue (mirrors {@link PushSender}
 * and {@link NoopPushSender}). This makes it safe to wire unconditionally: it activates when Firebase
 * is configured and no-ops otherwise.
 */

import { Injectable, Logger } from '@nestjs/common';
import { getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import { FIREBASE_APP_NAME } from '../auth/firebase-admin.service';
import type { PushSendResult, PushSender } from './push-sender';

/**
 * FCM error codes that mean the token will never work again, so it should be removed rather than
 * retried on every future message.
 */
const PERMANENT_TOKEN_ERRORS = new Set<string>([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/**
 * Android collapse key for wake pushes: while a device is unreachable FCM keeps only the newest
 * wake for it, so a burst of messages to an offline user becomes one wake instead of N.
 */
const WAKE_COLLAPSE_KEY = 'wake';

/**
 * How long FCM keeps trying to deliver a wake to an unreachable device. Matches the inbox
 * retention, so a device that comes back within that window is still woken.
 */
const WAKE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class FcmPushSender implements PushSender {
  private readonly logger = new Logger(FcmPushSender.name);

  /** @inheritdoc */
  async send(tokens: string[], data: Record<string, string>): Promise<PushSendResult | void> {
    if (tokens.length === 0) {
      return;
    }
    // Resolve the SAME Admin app FirebaseAdminService initialized (by name). When it isn't
    // initialized (no FIREBASE_* creds, e.g. CI), self-degrade to a no-op rather than throwing.
    const app = getApps().find((candidate) => candidate.name === FIREBASE_APP_NAME);
    if (app === undefined) {
      this.logger.debug(`Firebase not initialized; skipped wake-push to ${tokens.length} token(s)`);
      return;
    }
    try {
      // DATA-ONLY multicast (no `notification` block) so the payload stays content-free and the
      // client handles it in its background message handler. High priority so Android wakes promptly.
      const result = await getMessaging(app).sendEachForMulticast({
        tokens,
        data,
        android: { priority: 'high', collapseKey: WAKE_COLLAPSE_KEY, ttl: WAKE_TTL_MS },
        apns: { headers: { 'apns-collapse-id': WAKE_COLLAPSE_KEY } },
      });
      const invalidTokens: string[] = [];
      (result.responses ?? []).forEach((response, index) => {
        const code = response.error?.code;
        if (!response.success && code !== undefined && PERMANENT_TOKEN_ERRORS.has(code)) {
          const token = tokens[index];
          if (token !== undefined) {
            invalidTokens.push(token);
          }
        }
      });
      if (result.failureCount > 0) {
        // Count-only diagnostics — never log tokens or payload (Req 8.2 / invariant C1).
        this.logger.debug(
          `Wake-push delivered to ${result.successCount}/${tokens.length} token(s); ${result.failureCount} failed (${invalidTokens.length} invalid)`,
        );
      }
      return { invalidTokens };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`FCM wake-push failed: ${message}`);
    }
  }
}
