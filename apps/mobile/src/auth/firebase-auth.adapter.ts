/**
 * `apps/mobile` — `FirebaseAuthAdapter` (Phase 1, design Client Component 1: Auth_Service).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Client component layering" → `FirebaseAuthAdapter`, and
 *   "Components and Interfaces" → "Client Component 1: Auth_Service".
 *
 * This is the MOBILE platform adapter that binds the shared `AuthTokenProvider` port
 * (`@chat-app/crypto`) onto `@react-native-firebase/auth`. The platform-agnostic
 * `AuthService` core layers the orchestration policy (bounded refresh retries, OTP
 * resend limit, code-expiry) on top of this adapter; the adapter itself only knows
 * how to talk to Firebase:
 *
 *   - `requestPhoneOtp(e164)` → `signInWithPhoneNumber`, caching the returned
 *     confirmation result for the subsequent confirm step (Requirement 1.2).
 *   - `confirmPhoneOtp(code)` → `confirmation.confirm(code)`, resolving with a fresh
 *     `{ uid, token }` via `user.getIdToken()` (Requirements 1.3, 1.4).
 *   - `getCurrentToken()` / `getCurrentUid()` → the cached current-user view
 *     (Requirement 1.4).
 *   - `refreshToken()` → `user.getIdToken(true)` (Requirements 1.6, used on 401/4401).
 *   - `onAuthStateChanged(listener)` → maps Firebase's `onAuthStateChanged` onto the
 *     shared `AuthState` (`signed-in { uid, token }` / `signed-out`).
 *   - `signOut()` → `auth().signOut()` and clears the cached view (Requirement 4.8).
 *
 * Token hygiene (Requirements 1.8, 8.5): the Firebase ID token is only ever handed
 * back to callers (the `AuthService` core → Device_Registrar / Realtime_Client). It is
 * never written to a log, and the instance redacts the token when serialized or
 * inspected so an accidental `console.log(adapter)` cannot leak it.
 */

import auth, { FirebaseAuthTypes } from '@react-native-firebase/auth';

import type {
  AuthTokenProvider,
  OtpRequestResult,
  SignInResult,
  Unsubscribe,
} from '@chat-app/crypto';
import type { AuthState } from '@chat-app/types';

/** Placeholder used by the redaction hooks so the token value is never serialized. */
const REDACTED = '[redacted]';

/**
 * Extracts a non-sensitive, human-readable message from a thrown Firebase error
 * without ever surfacing token material. Firebase auth errors carry a stable `code`
 * (e.g. `auth/invalid-phone-number`); we prefer it, falling back to a generic string.
 */
function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return 'sign-in failed';
}

/**
 * Mobile `AuthTokenProvider` backed by `@react-native-firebase/auth`.
 *
 * The provider keeps a small cached view of the signed-in user (`cachedToken`,
 * `cachedUid`) so the synchronous `getCurrentToken()` / `getCurrentUid()` accessors
 * the shared core relies on can be served without an `await`. The cache is refreshed
 * on confirm, on refresh, and on every Firebase auth-state change.
 */
export class FirebaseAuthAdapter implements AuthTokenProvider {
  /** The `@react-native-firebase/auth` module instance. */
  private readonly authInstance: FirebaseAuthTypes.Module;

  /** Cached Firebase ID token for the synchronous accessor; `null` when signed out. */
  private cachedToken: string | null = null;
  /** Cached signed-in UID for the synchronous accessor; `null` when signed out. */
  private cachedUid: string | null = null;
  /** The pending phone-verification handle between `requestPhoneOtp` and `confirmPhoneOtp`. */
  private confirmation: FirebaseAuthTypes.ConfirmationResult | null = null;

  /**
   * @param authInstance - the `@react-native-firebase/auth` module; defaults to the
   *   singleton `auth()`. Injectable so tests can supply a fake.
   */
  constructor(authInstance: FirebaseAuthTypes.Module = auth()) {
    this.authInstance = authInstance;
    // Seed the UID synchronously from any already-restored session. The token is
    // fetched lazily (it is async) on the first auth-state callback / refresh.
    this.cachedUid = this.authInstance.currentUser?.uid ?? null;
  }

  // -------------------------------------------------------------------------
  // Synchronous cached-view accessors (Requirement 1.4).
  // -------------------------------------------------------------------------

  /** Current cached Firebase ID token, or `null` if not signed in. */
  getCurrentToken(): string | null {
    return this.cachedToken;
  }

  /** Signed-in user's Firebase UID, or `null`. */
  getCurrentUid(): string | null {
    return this.cachedUid;
  }

  // -------------------------------------------------------------------------
  // Phone OTP request / confirm (Requirements 1.2, 1.3, 1.4).
  // -------------------------------------------------------------------------

  /**
   * Request a one-time verification code for an E.164 number via Firebase
   * `signInWithPhoneNumber`. The returned confirmation handle is stored for the
   * subsequent {@link FirebaseAuthAdapter.confirmPhoneOtp} call (Requirement 1.2).
   *
   * Returns a structured {@link OtpRequestResult} rather than throwing so the
   * Sign_In_Screen can keep the user on the screen and show an error (1.5). The
   * resend-limit accounting (1.10) lives in the shared `AuthService` core, not here.
   */
  async requestPhoneOtp(e164: string): Promise<OtpRequestResult> {
    try {
      this.confirmation = await this.authInstance.signInWithPhoneNumber(e164);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) };
    }
  }

  /**
   * Confirm a 6-digit code against the pending verification, completing Firebase
   * sign-in and resolving with a fresh `{ uid, token }` (Requirements 1.3, 1.4).
   *
   * @throws {Error} if no verification is pending, or the confirmation does not yield
   *   a signed-in user. Firebase rejects an incorrect/expired code by throwing, which
   *   propagates so the Sign_In_Screen can surface the failure (1.5, 1.11).
   */
  async confirmPhoneOtp(code: string): Promise<SignInResult> {
    if (this.confirmation === null) {
      throw new Error('No pending phone verification; request a code first.');
    }
    const credential = await this.confirmation.confirm(code);
    const user = credential?.user ?? this.authInstance.currentUser;
    if (!user) {
      throw new Error('Phone confirmation did not yield a signed-in user.');
    }
    const token = await user.getIdToken();
    this.cachedUid = user.uid;
    this.cachedToken = token;
    // A consumed confirmation must not be reused; force a fresh request on retry.
    this.confirmation = null;
    return { uid: user.uid, token };
  }

  // -------------------------------------------------------------------------
  // Token refresh (Requirement 1.6 — used on HTTP 401 / WebSocket close 4401).
  // -------------------------------------------------------------------------

  /**
   * Force a fresh Firebase ID token via `user.getIdToken(true)` and update the cached
   * view. The shared `AuthService` core governs how many times this is retried and the
   * `reauth-required` transition (Requirements 1.6, 1.9).
   *
   * @throws {Error} if there is no signed-in user to refresh.
   */
  async refreshToken(): Promise<string> {
    const user = this.authInstance.currentUser;
    if (!user) {
      throw new Error('Cannot refresh token: no signed-in user.');
    }
    const token = await user.getIdToken(true);
    this.cachedUid = user.uid;
    this.cachedToken = token;
    return token;
  }

  // -------------------------------------------------------------------------
  // Auth-state mapping: Firebase onAuthStateChanged → shared AuthState.
  // -------------------------------------------------------------------------

  /**
   * Subscribe to Firebase auth-state changes, mapping each onto the shared
   * {@link AuthState}. When a user is present the ID token is fetched (async) before a
   * `signed-in` state is emitted, so the cached view and the emitted token stay in
   * lock-step; when no user is present a `signed-out` state is emitted and the cache is
   * cleared.
   *
   * @returns the Firebase-provided unsubscribe handle.
   */
  onAuthStateChanged(listener: (state: AuthState) => void): Unsubscribe {
    return this.authInstance.onAuthStateChanged((user: FirebaseAuthTypes.User | null) => {
      if (!user) {
        this.cachedToken = null;
        this.cachedUid = null;
        listener({ status: 'signed-out' });
        return;
      }
      this.cachedUid = user.uid;
      user
        .getIdToken()
        .then((token) => {
          this.cachedToken = token;
          listener({ status: 'signed-in', uid: user.uid, token });
        })
        .catch(() => {
          // The session exists but the token could not be obtained; surface the need
          // to re-authenticate without ever logging the failure detail (8.5).
          this.cachedToken = null;
          listener({ status: 'reauth-required' });
        });
    });
  }

  // -------------------------------------------------------------------------
  // Sign-out (Requirement 4.8 — Realtime_Client must not auto-reconnect after).
  // -------------------------------------------------------------------------

  /**
   * Client-initiated sign-out: clears the cached view and the pending confirmation,
   * then delegates to Firebase. The resulting `signed-out` auth-state callback flows
   * through {@link FirebaseAuthAdapter.onAuthStateChanged} to subscribers.
   */
  async signOut(): Promise<void> {
    this.cachedToken = null;
    this.cachedUid = null;
    this.confirmation = null;
    await this.authInstance.signOut();
  }

  // -------------------------------------------------------------------------
  // Log/serialization hygiene (Requirements 1.8, 8.5).
  // -------------------------------------------------------------------------

  /** Redacts the token when serialized via `JSON.stringify` (Requirements 1.8, 8.5). */
  toJSON(): Record<string, unknown> {
    return { uid: this.cachedUid, token: REDACTED };
  }

  /** Redacts the token when printed via `console.log` / `util.inspect` (8.5). */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `FirebaseAuthAdapter { uid: ${JSON.stringify(this.cachedUid)}, token: '${REDACTED}' }`;
  }
}
