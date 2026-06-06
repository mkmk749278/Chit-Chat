/**
 * Stable names and label sets for the backend's Prometheus metrics (Req 12.3).
 * Kept in one place so the middleware, service, and any future dashboards agree
 * on the exact metric/label identifiers.
 */

/** Counter: total number of completed HTTP requests. */
export const HTTP_REQUESTS_TOTAL = 'http_requests_total';

/** Histogram: HTTP request latency in seconds. */
export const HTTP_REQUEST_DURATION_SECONDS = 'http_request_duration_seconds';

/** Label names applied to both HTTP metrics. */
export const HTTP_METRIC_LABELS = ['method', 'route', 'status'] as const;

/**
 * Latency histogram buckets (seconds). Chosen to straddle the §12.8 performance
 * targets — sub-millisecond through a few seconds — so dashboards can show the
 * p50/p95/p99 distribution against those targets from day one.
 */
export const HTTP_REQUEST_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];
