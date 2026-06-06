/**
 * Public surface of the backend ObservabilityModule.
 *
 * Task 9.1 ships the structured request logging slice. Task 9.2 adds the
 * Prometheus `/metrics` endpoint (metrics service + middleware + controller +
 * monitoring-network guard). Task 9.3 adds Sentry error reporting (service +
 * scrubbing utility).
 */

export { ObservabilityModule } from './observability.module';
export { buildRequestLoggerOptions } from './request-logger.config';
export { MetricsService } from './metrics.service';
export { MetricsController } from './metrics.controller';
export { MetricsMiddleware } from './metrics.middleware';
export { MonitoringNetworkGuard } from './monitoring-network.guard';
export { SentryService } from './sentry.service';
export { SentryExceptionFilter } from './sentry-exception.filter';
export {
  HTTP_REQUESTS_TOTAL,
  HTTP_REQUEST_DURATION_SECONDS,
  HTTP_METRIC_LABELS,
  HTTP_REQUEST_DURATION_BUCKETS,
} from './metrics.constants';
export {
  DEFAULT_MONITORING_CIDRS,
  isIpAllowed,
  normalizeIp,
  parseCidr,
  parseMonitoringCidrs,
} from './monitoring-network.util';
export {
  extractClientIp,
  resolveMethodLabel,
  resolveRouteLabel,
  resolveStatusLabel,
} from './http-metrics.util';
export type { IpBearingRequest, MetricsRequest } from './http-metrics.util';
export {
  REDACTED as SENTRY_REDACTED,
  SENTRY_SENSITIVE_KEY_PATTERN,
  BEARER_TOKEN_PATTERN,
  SECRET_BEARING_ENV_VARS,
  collectSecretValues,
  scrubString,
  scrubEvent,
} from './sentry-scrub.util';
export {
  REDACTED,
  REDACT_PATHS,
  REQUEST_ID_HEADER,
  SENSITIVE_KEY_PATTERN,
  buildRequestLogProps,
  extractUid,
  generateRequestId,
  resolveRequestId,
  sanitizeUrl,
  serializeRequest,
} from './request-log.util';
export type { LoggableRequest, RequestLogProps } from './request-log.util';
