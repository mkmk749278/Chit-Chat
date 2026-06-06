/**
 * SentryExceptionFilter — the global exception handling path that reports
 * unhandled errors to Sentry (Requirements 12.5, 8.5).
 *
 * Why this exists
 * ---------------
 * Sentry's default integrations install process-level `uncaughtException` /
 * `unhandledRejection` handlers, but errors thrown inside a NestJS request handler
 * never reach those handlers: Nest catches them in its own exception layer and
 * turns them into an HTTP response. Without an application-level filter, a 500 (or
 * the Firebase-unreachable 503 from Req 8.5) raised while serving a request would
 * be returned to the client but never reported to Sentry.
 *
 * This filter closes that gap. It extends {@link BaseExceptionFilter} so the
 * client-facing HTTP response is produced by Nest's exact default behaviour
 * (status, body shape, logging) — it only adds a Sentry capture for *server-side*
 * failures before delegating. Token and secret values are stripped by the
 * `beforeSend` scrubber configured in {@link SentryService}, so nothing sensitive
 * is transmitted even though request context is attached.
 *
 * Reporting policy
 * ----------------
 * Only unhandled / server-fault errors are reported, so Sentry is not flooded with
 * routine client errors:
 *   - any non-`HttpException` (an unexpected throw) is reported;
 *   - an `HttpException` is reported only when its status is ≥ 500 — this captures
 *     the Firebase-unreachable 503 path (Req 8.5) while ignoring 4xx client faults
 *     such as 400/401/404.
 */

import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

import { SentryService } from './sentry.service';

@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter implements ExceptionFilter {
  constructor(private readonly sentry: SentryService) {
    super();
  }

  /**
   * Capture server-side failures to Sentry, then defer to Nest's default handling
   * to produce the HTTP response unchanged.
   */
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (this.shouldReport(exception)) {
      this.sentry.captureException(exception, this.buildContext(host));
    }
    super.catch(exception, host);
  }

  /**
   * Report unhandled throws and any HTTP error with a 5xx status; skip 4xx client
   * faults. Keeps Sentry focused on server-side problems (including the Req 8.5
   * 503 path).
   */
  private shouldReport(exception: unknown): boolean {
    if (exception instanceof HttpException) {
      return exception.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR;
    }
    return true;
  }

  /**
   * Build minimal, non-sensitive request context for the Sentry event. Any token
   * or secret that happens to appear here is still removed by the `beforeSend`
   * scrubber before transmission.
   */
  private buildContext(host: ArgumentsHost): Record<string, unknown> | undefined {
    if (host.getType() !== 'http') {
      return undefined;
    }
    const request = host.switchToHttp().getRequest<{ method?: string; url?: string }>();
    if (!request) {
      return undefined;
    }
    return {
      method: request.method,
      url: request.url,
    };
  }
}
