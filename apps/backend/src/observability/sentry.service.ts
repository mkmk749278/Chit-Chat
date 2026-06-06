/**
 * SentryService — initialises Sentry error reporting for the backend and exposes a
 * scrubbed capture path (Requirements 12.4, 12.5, 8.5).
 *
 * Lifecycle:
 *   - At startup (`onModuleInit`) the SDK is initialised from `SENTRY_DSN_BACKEND`
 *     read through the typed {@link AppConfigService} (Requirement 12.4). Sentry's
 *     default integrations install global `uncaughtException` / `unhandledRejection`
 *     handlers, so unhandled errors are reported automatically (Requirement 12.5).
 *   - A `beforeSend` hook routes every outbound event through {@link scrubEvent},
 *     stripping `Authorization`/`Bearer` credentials, secret-keyed fields, and any
 *     verbatim configured secret value, so tokens and secrets are never transmitted
 *     (Requirement 12.5, 13.2).
 *
 * Capture surface:
 *   - {@link captureException} lets callers report a handled error explicitly. It is
 *     the hook the Redis-cached `TokenVerificationService` (task 5.2) uses when
 *     Firebase is unreachable on a cache miss (Requirement 8.5); the same scrubbing
 *     applies, so no token reaches Sentry.
 *
 * When `SENTRY_DSN_BACKEND` is blank the service stays disabled and all capture
 * calls become no-ops, so the backend still runs in environments without Sentry
 * configured.
 */

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import * as Sentry from '@sentry/node';

import { AppConfigService } from '../config';

import { collectSecretValues, scrubEvent } from './sentry-scrub.util';

@Injectable()
export class SentryService implements OnModuleInit {
  private readonly logger = new Logger(SentryService.name);

  /** True once the SDK has been initialised with a DSN; gates every capture call. */
  private enabled = false;

  /** Literal secret values to redact from every event, resolved once at startup. */
  private secretValues: string[] = [];

  constructor(private readonly config: AppConfigService) {}

  /**
   * Initialise Sentry exactly once at startup. Wired to NestJS bootstrap so the
   * error reporter (and its global unhandled-error handlers) are live before the
   * application accepts traffic (Requirement 12.4, 12.5).
   */
  onModuleInit(): void {
    this.initialize();
  }

  /**
   * Configure the SDK from `SENTRY_DSN_BACKEND`. Resolves the secret values to
   * scrub first so the `beforeSend` hook can never transmit them, then installs
   * the SDK. A blank DSN leaves the service disabled (a logged warning, not a
   * fatal error) so non-production environments run without Sentry.
   */
  private initialize(): void {
    if (this.enabled) {
      return;
    }

    // Snapshot the secrets to redact from the same environment Sentry runs in.
    this.secretValues = collectSecretValues(process.env);

    const dsn = this.config.sentryDsnBackend?.trim();
    if (!dsn) {
      this.logger.warn(
        'SENTRY_DSN_BACKEND is empty; Sentry error reporting is disabled.',
      );
      return;
    }

    Sentry.init({
      dsn,
      // Every event — auto-captured unhandled errors and explicit captures alike —
      // is scrubbed of tokens and secrets before transmission (Req 12.5, 13.2).
      beforeSend: (event) => this.scrub(event),
    });

    this.enabled = true;
    this.logger.log('Sentry error reporting initialized');
  }

  /**
   * Report a handled error to Sentry with optional structured context. No-op when
   * Sentry is disabled. Used by `TokenVerificationService` to capture a Firebase
   * outage on a cache miss (Requirement 8.5). Returns the Sentry event id when an
   * event was queued, otherwise `undefined`.
   */
  captureException(error: unknown, context?: Record<string, unknown>): string | undefined {
    if (!this.enabled) {
      return undefined;
    }

    if (context !== undefined) {
      return Sentry.captureException(error, { extra: context });
    }
    return Sentry.captureException(error);
  }

  /**
   * Flush any queued events, giving in-flight reports a chance to send before the
   * process exits. No-op (resolves `true`) when Sentry is disabled.
   */
  async flush(timeoutMs = 2000): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }
    return Sentry.flush(timeoutMs);
  }

  /** Whether Sentry was initialised with a DSN and is actively reporting. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * The `beforeSend` hook: scrub the event of tokens and secrets. Exposed as a
   * method (rather than an inline closure) so it can be unit tested directly.
   */
  private scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
    return scrubEvent(event as unknown as Record<string, unknown>, this.secretValues) as unknown as Sentry.ErrorEvent;
  }
}
