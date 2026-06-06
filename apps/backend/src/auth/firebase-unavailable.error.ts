/**
 * Domain error for "Firebase unreachable on a cache miss" (Requirement 8.5).
 *
 * Raised by {@link TokenVerificationService} when an authoritative Firebase
 * verification is required (the Redis cache missed) but the Firebase Admin API
 * cannot be reached — i.e. it does not respond within the 5-second budget or the
 * call fails with a network/connection error.
 *
 * This is deliberately distinct from {@link UnauthorizedError}: an
 * `UnauthorizedError` means the token itself is invalid/expired/revoked (client
 * fault → 401 / WS close 4401), whereas a `FirebaseUnavailableError` means the
 * verification dependency is unavailable (server/infra fault → HTTP 503 / WS close
 * 4503, per Requirement 8.5). The REST guard (task 5.3) and the WebSocket gateway
 * (task 7.1) translate this error into the appropriate transport response.
 *
 * Like {@link UnauthorizedError} it carries no Firebase SDK internals in its
 * client-facing message; the originating error is preserved only in {@link cause}
 * for server-side logging and Sentry capture.
 */
export class FirebaseUnavailableError extends Error {
  /**
   * The original error (timeout or network failure) that triggered this. Retained
   * for internal logging / Sentry capture only; never surfaced to clients.
   */
  override readonly cause?: unknown;

  constructor(
    message = 'Token verification is temporarily unavailable',
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'FirebaseUnavailableError';
    this.cause = options?.cause;

    // Restore the prototype chain so `instanceof FirebaseUnavailableError` works
    // after the TypeScript→ES downlevel of the Error subclass.
    Object.setPrototypeOf(this, FirebaseUnavailableError.prototype);
  }
}
