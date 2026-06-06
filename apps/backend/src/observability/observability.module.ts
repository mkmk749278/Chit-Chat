import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { MetricsController } from './metrics.controller';
import { MetricsMiddleware } from './metrics.middleware';
import { MetricsService } from './metrics.service';
import { MonitoringNetworkGuard } from './monitoring-network.guard';
import { buildRequestLoggerOptions } from './request-logger.config';
import { SentryExceptionFilter } from './sentry-exception.filter';
import { SentryService } from './sentry.service';

/**
 * ObservabilityModule — wires the backend's observability stack from day one
 * (design.md → "Component 8: ObservabilityModule").
 *
 * Phase 0 builds this module up across three tasks:
 *   - Task 9.1: structured JSON request logging via `nestjs-pino`.
 *   - Task 9.2: the Prometheus `/metrics` endpoint, restricted to the
 *     monitoring network.
 *   - Task 9.3 (this task): Sentry initialisation with token/secret scrubbing.
 *
 * Request logging (Requirements 12.1, 12.2, 12.6, 13.2)
 * -----------------------------------------------------
 * `LoggerModule.forRoot` installs pino as the application logger and registers
 * the `pino-http` middleware that emits exactly one structured JSON entry per
 * completed HTTP request — carrying the request id, route, HTTP status, latency
 * in milliseconds, and (only when authenticated) the Firebase UID — while
 * excluding all token and secret values. The behaviour-bearing options live in
 * `buildRequestLoggerOptions` so they can be unit/property tested without booting
 * Nest.
 *
 * Prometheus metrics (Requirements 12.3, 12.7, 13.6)
 * --------------------------------------------------
 * `MetricsService` owns a prom-client registry seeded with the default
 * process/runtime metrics plus a custom HTTP request counter and latency
 * histogram (labelled by method / route / status). `MetricsMiddleware` records
 * one observation per completed request across every route, and `MetricsController`
 * exposes `GET /metrics` in the Prometheus text exposition format. That route is
 * network-gated by `MonitoringNetworkGuard`, which rejects any request whose real
 * source IP falls outside the configured monitoring CIDR allowlist (defaulting to
 * private/loopback ranges) so no metrics data leaves the monitoring network.
 *
 * Sentry error reporting (Requirements 12.4, 12.5, 8.5, 13.2)
 * ----------------------------------------------------------
 * `SentryService` initialises the Sentry SDK from `SENTRY_DSN_BACKEND` at startup
 * (Req 12.4). Sentry's default integrations install global unhandled-error handlers
 * so uncaught exceptions and unhandled rejections are reported automatically
 * (Req 12.5), and a `beforeSend` hook routes every event through a scrubber that
 * strips `Authorization`/`Bearer` credentials, secret-keyed fields, and verbatim
 * configured secret values before transmission (Req 12.5, 13.2). It is exported so
 * the Redis-cached `TokenVerificationService` (task 5.2) can capture a Firebase
 * outage on a cache miss (Req 8.5).
 *
 * Errors thrown inside a request handler never reach Sentry's process-level
 * handlers, so `SentryExceptionFilter` is registered globally (`APP_FILTER`) to
 * report server-side failures (any non-HTTP throw and every 5xx, including the
 * Firebase-unreachable 503 of Req 8.5) while leaving Nest's default HTTP response
 * untouched.
 *
 * Exported so the root AppModule (task 10.1) can import a single module to gain
 * the full observability surface.
 */
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: buildRequestLoggerOptions(),
    }),
  ],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    MonitoringNetworkGuard,
    SentryService,
    { provide: APP_FILTER, useClass: SentryExceptionFilter },
  ],
  exports: [MetricsService, SentryService],
})
export class ObservabilityModule implements NestModule {
  /**
   * Register the metrics middleware for every route so HTTP request count and
   * latency are recorded for all traffic, including `/metrics`, `/health`, and
   * unmatched (404) requests.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(MetricsMiddleware).forRoutes('*');
  }
}
