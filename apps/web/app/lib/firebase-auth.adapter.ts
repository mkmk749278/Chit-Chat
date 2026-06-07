/**
 * Web `FirebaseAuthAdapter` (Phase 1, task 7.1; design Client Component 1: Auth_Service).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Client component layering" → `FirebaseAuthAdapter`, and
 *   "Components and Interfaces" → "Client Component 1: Auth_Service".
 *
 * The WEB platform adapter binding the shared `AuthTokenProvider` port (`@chat-app/crypto`)
 * onto the Firebase Web SDK (`firebase/auth`). It is the web mirror of the mobile
 * `@react-native-firebase/auth` adapter: the platform-agnostic `AuthService` core layers
 * the orchestration policy (bounded refresh retries, OTP resend limit, code-expiry) on
 * top; this adapter only knows how to talk to Firebase.
 *
 *   - `requestPhoneOtp(e164)` → `signInWithPhoneNumber` using an invisible
 *     `RecaptchaVerifier`, caching the returned confirmation for the confirm step (1.2).
 *   - `confirmPhoneOtp(code)` → `confirmation.confirm(code)`, resolving a fresh
 *     `{ uid, token }` via `user.getIdToken()` (1.3, 1.4).
 *   - `getCurrentToken()` / `getCurrentUid()` → the cached current-user view (1.4),
 *     kept fresh by `onIdTokenChanged` (which also fires on token refresh).
 *   - `refreshToken()` → `user.getIdToken(true)` (1.6, on HTTP 401 / WS 4401).
 *   - `signOut()` → `signOut(auth)`, clearing the cache and the reCAPTCHA widget (4.8).
 *
 * Token hygiene (1.8, 8.5): the Firebase ID token is only ever handed back to callers
 * (the `AuthService` core → Device_Registrar / Realtime_Client); it is never logged, and
 * the instance redacts the token when serialized or inspected.
 *
 * Runtime note: this adapter is browser-only (it constructs a `RecaptchaVerifier`, which
 * needs the DOM). It is instantiated client-side by the web app bootstrap (task 7.8); the
 * reCAPTCHA widget is created lazily on the first `requestPhoneOtp` so importing the
 * module during SSR does no DOM work.
 */

import { getApp, getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import {
  getAuth,
  onIdTokenChanged,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut as firebaseSignOut,
  type Auth,
  type ConfirmationResult,
  type User,
} from 'firebase/auth';

import type {
  AuthTokenProvider,
  OtpRequestResult,
  SignInResult,
  Unsubscribe,
} from '@chat-app/crypto';
import type { AuthState } from '@chat-app/types';

/** Placeholder used by the redaction hooks so the token value is never serialized. */
const REDACTED = '[redacted]';

/** Adapter construction options: the Firebase project config + reCAPTCHA host element. */
export interface FirebaseAuthAdapterOptions {
  /** Firebase Web SDK options (apiKey, authDomain, projectId, appId, …). */
  firebaseConfig: FirebaseOptions;
  /**
   * Id (or element) of the DOM container that hosts the invisible reCAPTCHA widget
   * Firebase phone auth requires on the web. Defaults to `'recaptcha-container'`.
   */
  recaptchaContainerId?: string;
}

/**
 * Read the Firebase Web config from the `NEXT_PUBLIC_FIREBASE_*` environment variables.
 * These are public client config values (not secrets), embedded at build time by Next.
 * Returns `null` when the required keys are absent so the caller can surface a clear
 * configuration error rather than constructing a half-initialised SDK.
 */
export function firebaseConfigFromEnv(): FirebaseOptions | null {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;
  if (!apiKey || !authDomain || !projectId || !appId) {
    return null;
  }
  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  };
}

/** Extract a non-sensitive message from a thrown Firebase error (never token material). */
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

/** Initialise (or reuse) the Firebase app singleton for the given config. */
function ensureFirebaseApp(config: FirebaseOptions): FirebaseApp {
  return getApps().length > 0 ? getApp() : initializeApp(config);
}

/**
 * Web `AuthTokenProvider` backed by the Firebase Web SDK.
 *
 * Keeps a cached view of the signed-in user (`cachedToken`, `cachedUid`) so the
 * synchronous `getCurrentToken()` / `getCurrentUid()` accessors the shared core relies
 * on can be served without an `await`. The cache is refreshed on confirm, on refresh,
 * and on every `onIdTokenChanged` event.
 */
export class FirebaseAuthAdapter implements AuthTokenProvider {
  private readonly auth: Auth;
  private readonly recaptchaContainerId: string;

  private cachedToken: string | null = null;
  private cachedUid: string | null = null;
  private confirmation: ConfirmationResult | null = null;
  private recaptcha: RecaptchaVerifier | null = null;

  constructor(options: FirebaseAuthAdapterOptions) {
    const app = ensureFirebaseApp(options.firebaseConfig);
    this.auth = getAuth(app);
    this.recaptchaContainerId = options.recaptchaContainerId ?? 'recaptcha-container';
    // Seed the UID synchronously from any restored session; the token is fetched lazily
    // (it is async) on the first onIdTokenChanged callback / refresh.
    this.cachedUid = this.auth.currentUser?.uid ?? null;
  }

  // -------------------------------------------------------------------------
  // Synchronous cached-view accessors (Requirement 1.4).
  // -------------------------------------------------------------------------

  getCurrentToken(): string | null {
    return this.cachedToken;
  }

  getCurrentUid(): string | null {
    return this.cachedUid;
  }

  // -------------------------------------------------------------------------
  // Phone OTP request / confirm (Requirements 1.2, 1.3, 1.4).
  // -------------------------------------------------------------------------

  /**
   * Request a verification code for an E.164 number via `signInWithPhoneNumber`, using
   * an invisible reCAPTCHA verifier (created lazily on first use). The returned
   * confirmation is cached for {@link confirmPhoneOtp} (1.2). Returns a structured
   * result rather than throwing so the Sign_In_Screen keeps the user on-screen (1.5);
   * the resend-limit accounting (1.10) lives in the shared `AuthService` core.
   */
  async requestPhoneOtp(e164: string): Promise<OtpRequestResult> {
    try {
      const verifier = this.ensureRecaptcha();
      this.confirmation = await signInWithPhoneNumber(this.auth, e164, verifier);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) };
    }
  }

  /**
   * Confirm a 6-digit code against the pending verification, completing sign-in and
   * resolving a fresh `{ uid, token }` (1.3, 1.4). Firebase rejects an incorrect/expired
   * code by throwing, which propagates so the Sign_In_Screen surfaces it (1.5, 1.11).
   */
  async confirmPhoneOtp(code: string): Promise<SignInResult> {
    if (this.confirmation === null) {
      throw new Error('No pending phone verification; request a code first.');
    }
    const credential = await this.confirmation.confirm(code);
    const user = credential.user ?? this.auth.currentUser;
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

  async refreshToken(): Promise<string> {
    const user = this.auth.currentUser;
    if (!user) {
      throw new Error('Cannot refresh token: no signed-in user.');
    }
    const token = await user.getIdToken(true);
    this.cachedUid = user.uid;
    this.cachedToken = token;
    return token;
  }

  // -------------------------------------------------------------------------
  // Auth-state mapping: Firebase onIdTokenChanged → shared AuthState.
  // -------------------------------------------------------------------------

  /**
   * Subscribe to Firebase auth/token changes, mapping each onto the shared
   * {@link AuthState}. `onIdTokenChanged` fires on sign-in/out AND on token refresh, so
   * the cached view and the emitted token stay in lock-step. When a user is present the
   * ID token is fetched (async) before a `signed-in` state is emitted; otherwise a
   * `signed-out` state is emitted and the cache cleared.
   */
  onAuthStateChanged(listener: (state: AuthState) => void): Unsubscribe {
    return onIdTokenChanged(this.auth, (user: User | null) => {
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
          // Could not fetch a token for a present user; treat as not-yet-signed-in
          // rather than emitting a token-less signed-in state.
          listener({ status: 'signed-out' });
        });
    });
  }

  // -------------------------------------------------------------------------
  // Sign-out (Requirement 4.8).
  // -------------------------------------------------------------------------

  async signOut(): Promise<void> {
    await firebaseSignOut(this.auth);
    this.cachedToken = null;
    this.cachedUid = null;
    this.confirmation = null;
    this.clearRecaptcha();
  }

  // -------------------------------------------------------------------------
  // Internal helpers.
  // -------------------------------------------------------------------------

  /** Lazily create the invisible reCAPTCHA verifier required by web phone auth. */
  private ensureRecaptcha(): RecaptchaVerifier {
    if (this.recaptcha === null) {
      this.recaptcha = new RecaptchaVerifier(this.auth, this.recaptchaContainerId, {
        size: 'invisible',
      });
    }
    return this.recaptcha;
  }

  /** Tear down the reCAPTCHA widget so a later sign-in starts from a clean verifier. */
  private clearRecaptcha(): void {
    if (this.recaptcha !== null) {
      this.recaptcha.clear();
      this.recaptcha = null;
    }
  }

  // -------------------------------------------------------------------------
  // Log/serialization hygiene (Requirement 8.5).
  // -------------------------------------------------------------------------

  toJSON(): Record<string, unknown> {
    return { uid: this.cachedUid, token: REDACTED };
  }
}

/** Create a web {@link AuthTokenProvider} from the given Firebase options. */
export function createFirebaseAuthAdapter(
  options: FirebaseAuthAdapterOptions,
): AuthTokenProvider {
  return new FirebaseAuthAdapter(options);
}
