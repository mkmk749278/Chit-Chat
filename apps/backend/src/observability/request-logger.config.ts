import type { Options } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  REDACTED,
  REDACT_PATHS,
  REQUEST_ID_HEADER,
  buildRequestLogProps,
  resolveRequestId,
  serializeRequest,
  type LoggableRequest,
} from './request-log.util';

/**
 * Build the `pino-http` options that turn pino into the structured request logger
 * required by Requirements 12.1, 12.2, 12.6, and 13.2.
 *
 * `pino-http` (the engine behind `nestjs-pino`) emits **exactly one** JSON log
 * entry per completed HTTP request via its `autoLogging` path. That single entry
 * carries, by construction:
 *   - the request id      → `req.id` (set by `genReqId`)           — Req 12.1
 *   - the route           → `route` (added by `customProps`)        — Req 12.1
 *   - the HTTP status     → `res.statusCode` (added automatically)  — Req 12.1
 *   - the latency in ms   → `responseTime` (added automatically)    — Req 12.1
 *   - the Firebase UID    → `uid`, only when authenticated          — Req 12.6
 *
 * Token and secret values are kept out of the stream three ways (Req 12.2, 13.2):
 *   1. `serializers.req` reduces the request to id/method/route and drops all
 *      headers (where the `Authorization` bearer token and cookies live).
 *   2. `customProps` routes the URL through `sanitizeUrl`, redacting the values of
 *      any token/secret-looking query parameter (e.g. a `?token=` handshake).
 *   3. `redact` censors known token/secret header paths as defence-in-depth in
 *      case a future serializer or error path re-introduces headers.
 */
export function buildRequestLoggerOptions(): Options {
  return {
    // Emit one completion log per request (do not log per-request on receipt).
    autoLogging: true,

    // Resolve/propagate the correlation id and echo it back to the client so a
    // request can be traced end-to-end across the proxy and services (Req 12.1).
    genReqId: (req: IncomingMessage, res: ServerResponse): string => {
      const id = resolveRequestId(req as LoggableRequest);
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },

    // Top-level properties merged into every completed-request entry: the
    // sanitised route always, and the Firebase UID only when authenticated.
    customProps: (req: IncomingMessage): Record<string, unknown> =>
      buildRequestLogProps(req as LoggableRequest),

    // Reduce the logged request to a safe field set; headers are deliberately
    // omitted so no bearer token / cookie can reach the log stream.
    serializers: {
      req: (req: unknown) => serializeRequest(req as LoggableRequest),
    },

    // Defence-in-depth: censor any token/secret-bearing header path if headers
    // are ever re-introduced by another serializer or an error path.
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACTED,
    },
  };
}
