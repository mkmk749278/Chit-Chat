import { randomUUID } from 'node:crypto';

/**
 * Framework-agnostic helpers for the structured request logger (Requirement 12.1,
 * 12.2, 12.6, 13.2). These functions hold the security-sensitive logic — request
 * id propagation, UID extraction, URL/query sanitisation, and the redaction path
 * list — so they can be unit/property tested without booting NestJS or pino.
 */

/** Header used to propagate a correlation id across services and back to clients. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Replacement string written in place of any redacted token/secret value. */
export const REDACTED = '[REDACTED]';

/**
 * Matches header names, query keys, or field names that may carry a token or
 * secret value. Used to scrub the request URL's query string and to build the
 * pino `redact` path list. Case-insensitive.
 */
export const SENSITIVE_KEY_PATTERN =
  /(authorization|token|secret|password|passwd|api[-_]?key|credential|cookie|session|bearer)/i;

/**
 * Minimal shape of the inbound request the logger reads from. Express/`http`
 * requests satisfy this structurally; `authContext` is the verified identity the
 * FirebaseAuthGuard attaches on authenticated routes (design.md → "Attach
 * AuthContext to the request object").
 */
export interface LoggableRequest {
  id?: string | number;
  method?: string;
  url?: string;
  originalUrl?: string;
  headers?: Record<string, unknown>;
  /** Populated by FirebaseAuthGuard / Realtime handshake on authenticated requests. */
  authContext?: { uid?: string } | null;
}

/**
 * The extra top-level properties merged into every completed-request log entry.
 *
 * Declared as a type alias (not an interface) so it carries an implicit index
 * signature and is therefore assignable to the `Record<string, unknown>` return
 * type pino-http requires from `customProps` (see `request-logger.config.ts`).
 */
export type RequestLogProps = {
  /** Sanitised request route (path + scrubbed query). Requirement 12.1. */
  route: string;
  /** Firebase UID, present only when the request was authenticated. Requirement 12.6. */
  uid?: string;
};

/** Generate a fresh correlation id. */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Resolve the request id: reuse an inbound `x-request-id` header when present
 * (propagation across the proxy/services), otherwise generate a new one.
 */
export function resolveRequestId(req: LoggableRequest): string {
  const header = req.headers?.[REQUEST_ID_HEADER];
  const candidate = Array.isArray(header) ? header[0] : header;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate;
  }
  return generateRequestId();
}

/**
 * Extract the Firebase UID from the request's attached AuthContext. Returns
 * `undefined` for unauthenticated requests so the logger omits the field
 * entirely rather than logging `uid: undefined`.
 */
export function extractUid(req: LoggableRequest): string | undefined {
  const uid = req.authContext?.uid;
  return typeof uid === 'string' && uid.length > 0 ? uid : undefined;
}

/**
 * Sanitise a request URL for logging: keep the path, and redact the *values* of
 * any query parameter whose key looks like a token or secret while preserving
 * non-sensitive keys for debuggability (Requirement 12.2, 13.2). A token passed
 * in the query string (e.g. the WebSocket handshake `?token=`) never reaches the
 * log in clear text.
 */
export function sanitizeUrl(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return '';
  }
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex === -1) {
    return rawUrl;
  }

  const path = rawUrl.slice(0, queryIndex);
  const query = rawUrl.slice(queryIndex + 1);
  if (query.length === 0) {
    return path;
  }

  const scrubbed = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      if (SENSITIVE_KEY_PATTERN.test(safeDecode(key))) {
        return `${key}=${REDACTED}`;
      }
      return pair;
    })
    .join('&');

  return `${path}?${scrubbed}`;
}

/**
 * Build the extra log properties for a completed request: the sanitised route
 * always, and the UID only when authenticated.
 */
export function buildRequestLogProps(req: LoggableRequest): RequestLogProps {
  const route = sanitizeUrl(req.originalUrl ?? req.url);
  const uid = extractUid(req);
  return uid === undefined ? { route } : { route, uid };
}

/**
 * Reduce the request to a safe set of fields for the `req` serializer: id,
 * method, and the sanitised route. Headers (which carry the `Authorization`
 * bearer token and cookies) are deliberately omitted so no token/secret value
 * can ever reach the log stream (Requirement 12.2, 13.2).
 */
export function serializeRequest(req: LoggableRequest): {
  id: string | number | undefined;
  method: string | undefined;
  route: string;
} {
  return {
    id: req.id,
    method: req.method,
    route: sanitizeUrl(req.originalUrl ?? req.url),
  };
}

/**
 * Defence-in-depth redaction paths for pino. Even though `serializeRequest`
 * already drops headers, these paths guarantee that any token/secret-bearing
 * header is censored if a future serializer or error path re-introduces them.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.Authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
];

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
