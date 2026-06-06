/**
 * FirebaseAuthGuard — design Component 3 (Requirements 2.1, 13.1, 13.5).
 *
 * NestJS guard applied to every protected REST route (the device-registration
 * endpoint and any future authenticated surface). It is the single REST entry
 * point that turns a raw `Authorization: Bearer <idToken>` header into a verified
 * {@link AuthContext} attached to the request, so controllers never see an
 * unauthenticated caller.
 *
 * Flow (see design.md → "Function: FirebaseAuthGuard.canActivate()"):
 *   1. Read the `Authorization` header and extract the Bearer token. A missing or
 *      malformed header is rejected with `401 Unauthorized` immediately — before
 *      any verification, Redis, or database access (Requirements 2.1, 13.5).
 *   2. Delegate the token to {@link TokenVerificationService.verify}, which serves
 *      the result from the Redis cache when possible or verifies via Firebase.
 *   3. On success, attach the {@link AuthContext} to the request (`request.authContext`)
 *      for the {@link Auth} param decorator to read, and allow the request.
 *
 * Error mapping (no database side effects on any rejection — Requirements 2.1, 13.5):
 *   - {@link UnauthorizedError}        → `401 Unauthorized` (invalid/expired/revoked token).
 *   - {@link FirebaseUnavailableError} → `503 Service Unavailable` (Firebase unreachable
 *                                         on a cache miss, Requirement 8.5).
 *
 * The guard never logs or echoes the raw token; only the verified `AuthContext`
 * (which carries no token material) is surfaced (Requirement 13.2).
 */

import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthContext } from '@chat-app/types';

import { FirebaseUnavailableError } from './firebase-unavailable.error';
import { TokenVerificationService } from './token-verification.service';
import { UnauthorizedError } from './unauthorized.error';

/** Case-insensitive `Bearer ` scheme prefix used in the `Authorization` header. */
const BEARER_PREFIX = 'bearer ';

/**
 * The minimal request shape the guard relies on: the (optional) `Authorization`
 * header and a slot to attach the verified {@link AuthContext}. Kept transport
 * library-agnostic so it works with Express- or Fastify-backed Nest adapters.
 */
export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Populated by {@link FirebaseAuthGuard} once the Bearer token verifies. */
  authContext?: AuthContext;
}

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(private readonly tokenVerification: TokenVerificationService) {}

  /**
   * Resolves `true` and attaches the {@link AuthContext} to the request iff the
   * Bearer token verifies; otherwise throws (401 invalid / 503 unavailable). No
   * database side effects occur on any path (Requirements 2.1, 13.5).
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // 1. Extract the Bearer token. Missing/malformed → 401 with no further work.
    const token = extractBearerToken(request.headers?.authorization);
    if (token === null) {
      throw new UnauthorizedException('Unauthorized');
    }

    // 2. Delegate to the shared cached verification path.
    let authContext: AuthContext;
    try {
      authContext = await this.tokenVerification.verify(token);
    } catch (err) {
      throw this.toHttpException(err);
    }

    // 3. Attach the verified identity for controllers (via the @Auth() decorator).
    request.authContext = authContext;
    return true;
  }

  /**
   * Maps a verification failure onto the correct client-facing HTTP exception
   * without leaking SDK internals:
   *   - invalid/expired/revoked token   → 401 Unauthorized
   *   - Firebase unreachable on a miss   → 503 Service Unavailable (Requirement 8.5)
   * Any unexpected error is treated conservatively as a 401 so an unverified
   * request is never allowed through.
   */
  private toHttpException(err: unknown): UnauthorizedException | ServiceUnavailableException {
    if (err instanceof FirebaseUnavailableError) {
      return new ServiceUnavailableException('Token verification is temporarily unavailable');
    }
    if (err instanceof UnauthorizedError) {
      return new UnauthorizedException('Unauthorized');
    }
    // Fail closed: never let an unrecognized failure grant access.
    return new UnauthorizedException('Unauthorized');
  }
}

/**
 * Extracts the bearer token from an `Authorization` header value.
 *
 * Returns the trimmed token for a well-formed `Bearer <token>` header (scheme
 * matched case-insensitively), or `null` when the header is absent, not a Bearer
 * scheme, or carries an empty token — every one of which is an unauthenticated
 * request the guard rejects with 401.
 */
function extractBearerToken(authorization: string | string[] | undefined): string | null {
  // A repeated header arrives as an array; only a single, scalar value is valid.
  if (typeof authorization !== 'string') {
    return null;
  }

  const value = authorization.trim();
  if (value.length < BEARER_PREFIX.length) {
    return null;
  }

  if (value.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return null;
  }

  const token = value.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}
