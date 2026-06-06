/**
 * TokenVerificationService — design Component 2 (Requirements 2.2, 7.4, 7.5, 8.5, 13.2).
 *
 * The shared, Redis-cached verification path used by both the REST guard (task 5.3)
 * and the WebSocket gateway (task 7.1), so the cache and security semantics are
 * identical across transports.
 *
 * Flow (see design.md → "Cached token verification"):
 *   1. Read the `fbtoken:{sha256(token)}` cache entry. On a hit, return the cached
 *      {@link AuthContext} WITHOUT calling Firebase (Requirements 2.2, 7.5).
 *   2. On a miss — or when the Redis read fails / exceeds 50 ms — fall back to an
 *      authoritative Firebase verification rather than rejecting the request
 *      (Requirement 7.4).
 *   3. After a fresh verification, best-effort `SETEX` the result with
 *      TTL = `max(1, exp - now)`, and create NO entry when the remaining token
 *      lifetime is ≤ 0 (Requirement 2.2). A Redis write failure / >50 ms timeout is
 *      swallowed — the request still succeeds (Requirement 7.4).
 *
 * Error semantics:
 *   - Invalid / expired / revoked token  → {@link UnauthorizedError} (→ 401 / 4401).
 *   - Firebase unreachable on a miss (no response within 5 s, or a network/connection
 *     failure) → {@link FirebaseUnavailableError} (→ 503 / 4503), captured via the
 *     {@link ErrorReporter} (Requirement 8.5).
 *
 * The raw token is only ever passed to {@link TokenCacheService}, which derives the
 * SHA-256 cache key; the token is never logged or used as a key here (Requirement 13.2).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthContext, DecodedFirebaseToken } from '@chat-app/types';

import { TokenCacheService } from '../redis';
import { ERROR_REPORTER, type ErrorReporter } from './error-reporter';
import { FirebaseAdminService } from './firebase-admin.service';
import { FirebaseUnavailableError } from './firebase-unavailable.error';
import { UnauthorizedError } from './unauthorized.error';

/**
 * Maximum time a single Redis token-cache read or write may take before the
 * operation is abandoned and the request falls back to direct Firebase verification
 * (Requirement 7.4).
 */
const REDIS_OP_TIMEOUT_MS = 50;

/**
 * Maximum time an authoritative Firebase verification may take on a cache miss
 * before the dependency is treated as unavailable (Requirement 8.5 — "no response
 * within 5 seconds").
 */
const FIREBASE_VERIFY_TIMEOUT_MS = 5_000;

/**
 * Node error codes that indicate the Firebase Admin API could not be reached
 * (connection failure), as opposed to the token being invalid.
 */
const NETWORK_ERROR_CODES = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'auth/network-request-failed',
]);

/** Sentinel error used to signal that a timed operation exceeded its budget. */
class TimeoutError extends Error {
  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

@Injectable()
export class TokenVerificationService {
  private readonly logger = new Logger(TokenVerificationService.name);

  constructor(
    private readonly firebaseAdmin: FirebaseAdminService,
    private readonly tokenCache: TokenCacheService,
    @Inject(ERROR_REPORTER) private readonly errorReporter: ErrorReporter,
  ) {}

  /**
   * Returns the verified {@link AuthContext} for an ID token — from the Redis cache
   * when possible, otherwise via a fresh Firebase verification that is then cached.
   *
   * @throws UnauthorizedError       when the token is invalid / expired / revoked.
   * @throws FirebaseUnavailableError when verification is required but Firebase is
   *                                   unreachable on the miss (Requirement 8.5).
   */
  async verify(idToken: string): Promise<AuthContext> {
    // 1. Cache read — bounded and failure-tolerant. A hit short-circuits Firebase.
    const cached = await this.readCache(idToken);
    if (cached !== null) {
      return cached;
    }

    // 2. Cache miss (or read failed/timed out) → authoritative verification.
    const authContext = await this.verifyWithFirebase(idToken);

    // 3. Best-effort write-back; never blocks or fails the request.
    await this.writeCache(idToken, authContext);

    return authContext;
  }

  /**
   * Attempts a cache read within {@link REDIS_OP_TIMEOUT_MS}. Any failure or timeout
   * is swallowed and reported as a miss so the caller falls back to Firebase rather
   * than rejecting the request (Requirement 7.4).
   */
  private async readCache(idToken: string): Promise<AuthContext | null> {
    try {
      return await this.withTimeout(
        this.tokenCache.get(idToken),
        REDIS_OP_TIMEOUT_MS,
        'token-cache-get',
      );
    } catch (err) {
      this.logger.warn(`Token cache read unavailable, falling back to Firebase: ${describe(err)}`);
      return null;
    }
  }

  /**
   * Best-effort cache write within {@link REDIS_OP_TIMEOUT_MS}.
   *
   * TTL is `max(1, exp - now)`. When the remaining token lifetime is ≤ 0 no entry is
   * created at all (Requirement 2.2). Any write failure / timeout is swallowed so the
   * already-verified request still succeeds (Requirement 7.4).
   */
  private async writeCache(idToken: string, authContext: AuthContext): Promise<void> {
    const remaining = authContext.tokenExp - nowSeconds();
    if (remaining <= 0) {
      // Never cache an already-expired (or non-positive lifetime) token.
      return;
    }

    const ttlSeconds = Math.max(1, Math.floor(remaining));
    try {
      await this.withTimeout(
        this.tokenCache.set(idToken, authContext, ttlSeconds),
        REDIS_OP_TIMEOUT_MS,
        'token-cache-set',
      );
    } catch (err) {
      this.logger.warn(`Token cache write skipped (Redis unavailable): ${describe(err)}`);
    }
  }

  /**
   * Authoritatively verifies the token via Firebase within the 5-second budget.
   *
   * Distinguishes an unreachable dependency (timeout or network/connection failure)
   * from an invalid token: the former becomes a {@link FirebaseUnavailableError}
   * (captured in Sentry, Requirement 8.5), the latter stays an {@link UnauthorizedError}.
   */
  private async verifyWithFirebase(idToken: string): Promise<AuthContext> {
    let decoded: DecodedFirebaseToken;
    try {
      decoded = await this.withTimeout(
        this.firebaseAdmin.verifyIdToken(idToken),
        FIREBASE_VERIFY_TIMEOUT_MS,
        'firebase-verify',
      );
    } catch (err) {
      if (this.isUnavailable(err)) {
        const unavailable = new FirebaseUnavailableError(
          'Token verification is temporarily unavailable',
          { cause: err },
        );
        // Requirement 8.5: capture the infrastructure failure for observability.
        this.errorReporter.captureException(unavailable, { operation: 'firebase-verify' });
        throw unavailable;
      }
      // Invalid / expired / revoked token — surface as-is (→ 401 / 4401).
      throw err;
    }

    return toAuthContext(decoded);
  }

  /**
   * Decides whether a verification failure means Firebase was unreachable (server
   * fault → 503/4503) rather than the token being invalid (client fault → 401/4401).
   *
   * Treated as unavailable: our own {@link TimeoutError} (no response within 5 s) and
   * an {@link UnauthorizedError} whose underlying cause carries a network/connection
   * error code (FirebaseAdminService wraps all SDK failures in UnauthorizedError, so
   * the connectivity signal lives in `cause`).
   */
  private isUnavailable(err: unknown): boolean {
    if (err instanceof TimeoutError) {
      return true;
    }
    if (err instanceof UnauthorizedError) {
      return hasNetworkErrorCode(err.cause);
    }
    return false;
  }

  /**
   * Races a promise against a timer so a slow Redis or Firebase call cannot exceed
   * its budget. Rejects with {@link TimeoutError} on expiry; always clears the timer.
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(operation, timeoutMs)), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => {
      clearTimeout(timer);
    }) as Promise<T>;
  }
}

/** Current time in unix seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Maps a decoded Firebase token onto the request-attached {@link AuthContext}. */
function toAuthContext(decoded: DecodedFirebaseToken): AuthContext {
  return {
    uid: decoded.uid,
    ...(decoded.email !== undefined ? { email: decoded.email } : {}),
    ...(decoded.phoneNumber !== undefined ? { phoneNumber: decoded.phoneNumber } : {}),
    tokenExp: decoded.exp,
  };
}

/**
 * Walks an error and its `cause` chain looking for a known network/connection error
 * code, indicating Firebase could not be reached.
 */
function hasNetworkErrorCode(err: unknown, depth = 0): boolean {
  if (err === null || typeof err !== 'object' || depth > 5) {
    return false;
  }

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
    return true;
  }

  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined ? hasNetworkErrorCode(cause, depth + 1) : false;
}

/** Safe, token-free description of an error for warn-level logging. */
function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
