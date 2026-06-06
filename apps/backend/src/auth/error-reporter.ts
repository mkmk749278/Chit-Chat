/**
 * Error-reporting seam used by the auth layer to capture infrastructure failures
 * (Requirement 8.5 — "capture the error in Sentry").
 *
 * Phase 0 builds Sentry initialisation in a later slice (task 9.3). To satisfy the
 * "capture in Sentry" requirement now without coupling this module to an
 * uninitialised SDK, the {@link TokenVerificationService} reports through this small
 * abstraction. The default binding is a {@link LoggingErrorReporter} that records the
 * failure via the Nest logger; once Sentry is wired (task 9.3) a Sentry-backed
 * implementation can be bound to {@link ERROR_REPORTER} with no change to callers.
 */

import { Injectable, Logger } from '@nestjs/common';

/**
 * Minimal contract for capturing a server-side error to the error-tracking backend.
 * Implementations MUST never throw — capturing an error must not itself break the
 * request path.
 */
export interface ErrorReporter {
  /**
   * Capture an exception for later inspection.
   *
   * @param error   - the error to report.
   * @param context - optional structured context (no token or secret values).
   */
  captureException(error: unknown, context?: Record<string, unknown>): void;
}

/** DI token for the {@link ErrorReporter} binding. */
export const ERROR_REPORTER = Symbol('ERROR_REPORTER');

/**
 * Default {@link ErrorReporter} that logs the captured error through the Nest logger.
 *
 * This is a stand-in until Sentry is initialised (task 9.3); it preserves the capture
 * call site and guarantees the requirement's "capture the error" behaviour is exercised
 * even before the Sentry SDK is present. It swallows any logging failure so capturing
 * can never disrupt the caller.
 */
@Injectable()
export class LoggingErrorReporter implements ErrorReporter {
  private readonly logger = new Logger(LoggingErrorReporter.name);

  captureException(error: unknown, context?: Record<string, unknown>): void {
    try {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        context ? `${message} ${JSON.stringify(context)}` : message,
        stack,
      );
    } catch {
      // Capturing an error must never throw.
    }
  }
}
