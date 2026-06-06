/**
 * Framework-agnostic helpers for the HTTP request metrics (Requirement 12.3).
 *
 * These pure functions derive the label values recorded against the HTTP request
 * counter and latency histogram. They are kept separate from the NestJS
 * middleware so the (cardinality-sensitive) labelling logic can be unit tested in
 * isolation.
 */

/** Minimal shape of the inbound request the metrics layer reads from. */
export interface MetricsRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  baseUrl?: string;
  /** Express attaches the *matched* route (e.g. `{ path: '/devices/register' }`). */
  route?: { path?: string | string[] } | null;
}

/** The client source address used for the monitoring-network access check. */
export interface IpBearingRequest {
  ip?: string;
  socket?: { remoteAddress?: string } | null;
  connection?: { remoteAddress?: string } | null;
}

/**
 * Resolve the `route` label for a completed request.
 *
 * To keep label cardinality bounded, the matched route *pattern* is preferred
 * (e.g. `/api/devices/:id` rather than `/api/devices/abc-123`). When no matched
 * route is available (unmatched URLs / 404s, or middleware that runs before
 * routing), the path portion of the URL is used with the query string stripped so
 * tokens passed as query parameters never become a metric label.
 */
export function resolveRouteLabel(req: MetricsRequest): string {
  const routePath = req.route?.path;
  const pattern = Array.isArray(routePath) ? routePath[0] : routePath;
  if (typeof pattern === 'string' && pattern.length > 0) {
    const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
    const combined = `${base}${pattern}`;
    return combined.length > 0 ? combined : '/';
  }

  const rawUrl = req.originalUrl ?? req.url ?? '';
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  return path.length > 0 ? path : '/';
}

/** Normalise the HTTP method to an upper-case label, defaulting to `UNKNOWN`. */
export function resolveMethodLabel(method: string | undefined): string {
  return typeof method === 'string' && method.length > 0 ? method.toUpperCase() : 'UNKNOWN';
}

/** Normalise the HTTP status code to a numeric string label. */
export function resolveStatusLabel(status: number | undefined): string {
  return typeof status === 'number' && Number.isFinite(status) ? String(status) : '0';
}

/**
 * Extract the transport source IP for the monitoring-network access check.
 *
 * Deliberately reads the real socket address rather than `X-Forwarded-For`: the
 * access decision must not trust a client-controllable header. `req.ip` is used
 * only as a last resort (it equals the socket address when proxy trust is off,
 * which is the backend's configuration).
 */
export function extractClientIp(req: IpBearingRequest): string | undefined {
  return (
    req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? req.ip ?? undefined
  );
}
