/**
 * Push sender port (Phase 2, Requirement 6.2/6.3).
 *
 * Abstracts the platform push transport (FCM) behind a narrow interface so the content-free
 * wake-push logic ({@link PushNotificationService}) is testable and provider-agnostic. The REAL
 * FCM HTTP v1 binding (which needs service-account credentials) lands with the mobile FCM
 * integration (task 6.3); until then {@link NoopPushSender} is wired, so the token-storage and
 * enqueue-trigger plumbing is complete and exercised without any external dependency.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

/** DI token for the {@link PushSender}, so the FCM binding can be swapped in (task 6.3) or faked. */
export const PUSH_SENDER = Symbol('PUSH_SENDER');

/** A content-free data push: routing metadata only — never message text or sender plaintext (6.2). */
export interface PushSender {
  /**
   * Deliver a content-free data push to each token. `data` carries ONLY routing metadata
   * sufficient for the client to wake, connect, and fetch+decrypt locally (Req 6.3) — it MUST
   * NOT contain message text or sender plaintext. Best-effort: implementations swallow per-token
   * failures (e.g. an unregistered token) rather than throwing.
   */
  send(tokens: string[], data: Record<string, string>): Promise<void>;
}

/**
 * Default {@link PushSender} used until the FCM binding is configured (task 6.3): it logs the
 * count (never the tokens or any payload) and sends nothing. This keeps the pipeline wired and
 * green in every environment, including CI and self-hosted deployments without FCM credentials.
 */
@Injectable()
export class NoopPushSender implements PushSender {
  private readonly logger = new Logger(NoopPushSender.name);

  // `@Optional` so the provider resolves even though it takes no real dependencies.
  constructor(@Optional() @Inject(PUSH_SENDER) _unused?: never) {}

  async send(tokens: string[], _data: Record<string, string>): Promise<void> {
    if (tokens.length > 0) {
      this.logger.debug(`Push not configured; skipped wake-push to ${tokens.length} token(s)`);
    }
  }
}
