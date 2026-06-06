/**
 * Authentication / identity types shared across the backend services and clients.
 *
 * Source of truth: design.md → "Components and Interfaces"
 *   - Component 1: FirebaseAdminService  (DecodedFirebaseToken)
 *   - Component 2: TokenVerificationService (AuthContext)
 *
 * These are pure type definitions with no runtime dependencies so they can be
 * imported by `apps/backend`, `apps/web`, and `apps/mobile` alike.
 */

/**
 * The decoded result of verifying a Firebase ID token via the Firebase Admin SDK.
 * `exp` (unix seconds) drives the Redis cache TTL for the cached verification path.
 */
export interface DecodedFirebaseToken {
  /** Canonical user id across all backend services (§15.2). */
  uid: string;
  email?: string;
  phoneNumber?: string;
  /** Token expiry, unix seconds. */
  exp: number;
  /** Time the user authenticated, unix seconds. */
  authTime: number;
}

/**
 * The verified identity attached to a request / WebSocket connection after token
 * verification. Returned by the TokenVerificationService (cache or fresh verify).
 */
export interface AuthContext {
  /** Canonical Firebase UID. */
  uid: string;
  email?: string;
  phoneNumber?: string;
  /** Token expiry, unix seconds — used to clamp any cache entry's TTL. */
  tokenExp: number;
}
