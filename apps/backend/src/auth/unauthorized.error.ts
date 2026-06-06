/**
 * Domain authentication error.
 *
 * Raised whenever Firebase ID-token verification fails for any reason — missing,
 * malformed, expired, revoked, or failing signature verification (Requirement 8.3).
 *
 * This is a plain domain error, intentionally decoupled from any transport. The REST
 * guard (task 5.3) and the WebSocket gateway (task 7.1) translate it into the
 * appropriate client-facing response (HTTP 401 / WS close 4401) with a generic body.
 *
 * It deliberately carries no Firebase SDK error codes, stack frames, or internal
 * detail, so SDK internals never leak to clients (Requirement 8.3). When a Firebase
 * error is the cause it is preserved in {@link cause} for server-side logging only.
 */
export class UnauthorizedError extends Error {
  /**
   * The original error that triggered this failure, retained for internal logging.
   * It is never surfaced to clients.
   */
  override readonly cause?: unknown;

  constructor(message = 'Unauthorized', options?: { cause?: unknown }) {
    super(message);
    this.name = 'UnauthorizedError';
    this.cause = options?.cause;

    // Restore the prototype chain so `instanceof UnauthorizedError` works after the
    // TypeScript→ES5/ES2015 downlevel of the Error subclass.
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}
