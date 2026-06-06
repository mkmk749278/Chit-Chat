/**
 * `@chat-app/crypto` — `AuthService` core (Phase 1, design Component 1: Auth_Service).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Components and Interfaces" → "Client Component 1: Auth_Service", and
 *   `requirements.md` → Requirement 1 (1.6, 1.9, 1.10, 1.11) and Requirement 8 (8.5).
 *
 * The platform apps inject a concrete {@link AuthTokenProvider} that wraps
 * `@react-native-firebase/auth` (mobile) or the Firebase Web SDK (web). The provider
 * knows how to talk to Firebase, but it does NOT enforce the slice's
 * orchestration policy. This `AuthService` is the platform-agnostic core that wraps
 * the injected provider and adds exactly that policy:
 *
 *   - {@link AuthService.refreshWithRetry} — refresh the Firebase ID token, retrying
 *     at most 3 times, stopping on the first success; after 3 consecutive failures it
 *     transitions to `reauth-required` (Requirements 1.6, 1.9).
 *   - {@link AuthService.resendOtp} — permit at most 5 resend requests per rolling
 *     60-minute window per phone number, refusing further resends (Requirement 1.10).
 *   - {@link AuthService.confirmOtp} — reject a code submitted more than 300 seconds
 *     after its issuance with an expired-code error (Requirement 1.11).
 *   - Never place the Firebase ID token in logs; it is only handed back to callers
 *     (Device_Registrar / Realtime_Client) (Requirement 8.5).
 *
 * The core is kept pure and unit-testable: the only ambient dependency, the wall
 * clock, is injected as `now()` so the resend window and the code-expiry deadline are
 * fully deterministic in tests (no real timers, no real Firebase).
 */

import type { AuthState } from '@chat-app/types';
import type {
  AuthTokenProvider,
  OtpRequestResult,
  SignInResult,
  Unsubscribe,
} from './ports';

/** Default ceiling on consecutive token-refresh attempts (Requirements 1.6, 1.9). */
export const DEFAULT_MAX_REFRESH_ATTEMPTS = 3;
/** Default maximum OTP resends permitted per rolling window per phone (Requirement 1.10). */
export const DEFAULT_MAX_RESENDS_PER_WINDOW = 5;
/** Default rolling resend window: 60 minutes in milliseconds (Requirement 1.10). */
export const DEFAULT_RESEND_WINDOW_MS = 60 * 60 * 1000;
/** Default OTP code lifetime: 300 seconds in milliseconds (Requirement 1.11). */
export const DEFAULT_CODE_TTL_MS = 300 * 1000;

/**
 * Tuning knobs for {@link AuthService}. Every field is optional and defaults to the
 * Requirement-mandated value; tests override `now` (and occasionally the limits) to
 * drive the clock deterministically.
 */
export interface AuthServiceOptions {
  /**
   * Wall-clock source in unix milliseconds. Injected so the rolling resend window
   * (1.10) and the code-expiry deadline (1.11) are deterministic in tests. Defaults
   * to `Date.now`.
   */
  now?: () => number;
  /** Max consecutive refresh attempts before `reauth-required` (default 3; 1.6, 1.9). */
  maxRefreshAttempts?: number;
  /** Max resends permitted per rolling window per phone (default 5; 1.10). */
  maxResendsPerWindow?: number;
  /** Length of the rolling resend window in ms (default 3_600_000; 1.10). */
  resendWindowMs?: number;
  /** OTP code lifetime in ms; codes older than this are rejected (default 300_000; 1.11). */
  codeTtlMs?: number;
}

/**
 * Thrown by {@link AuthService.confirmOtp} when a code is submitted more than
 * `codeTtlMs` (default 300 s) after its issuance (Requirement 1.11). The code is
 * rejected before the underlying provider is ever called, so an expired code never
 * reaches Firebase.
 */
export class ExpiredOtpError extends Error {
  readonly code = 'otp-expired' as const;
  constructor(message = 'The verification code has expired. Request a new code.') {
    super(message);
    this.name = 'ExpiredOtpError';
  }
}

/**
 * Thrown by {@link AuthService.refreshWithRetry} when token refresh fails on
 * {@link AuthServiceOptions.maxRefreshAttempts} consecutive attempts (Requirements
 * 1.6, 1.9). When this is thrown the service has already transitioned to
 * `reauth-required` and broadcast that state to subscribers.
 */
export class ReauthRequiredError extends Error {
  readonly code = 'reauth-required' as const;
  constructor(message = 'Re-authentication is required. Please sign in again.') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

/** Internal placeholder used by inspection hooks so the token value is never serialized. */
const REDACTED = '[redacted]';

/**
 * Platform-agnostic Auth_Service core (design Component 1). Wraps an injected
 * {@link AuthTokenProvider} and layers the orchestration policy the provider itself
 * does not enforce — bounded token-refresh retries (1.6, 1.9), an OTP resend limit
 * (1.10), code-expiry rejection (1.11), and token-out-of-logs hygiene (8.5).
 *
 * Token and UID access are simple passthroughs to the provider. Auth-state changes
 * from the provider are re-broadcast to this service's own subscribers, and the
 * service additionally emits `reauth-required` once refresh is exhausted.
 */
export class AuthService {
  private readonly provider: AuthTokenProvider;
  private readonly now: () => number;
  private readonly maxRefreshAttempts: number;
  private readonly maxResendsPerWindow: number;
  private readonly resendWindowMs: number;
  private readonly codeTtlMs: number;

  /** Timestamps (unix ms) of recent resends, keyed by E.164 phone number (1.10). */
  private readonly resendHistory = new Map<string, number[]>();
  /** Issuance time (unix ms) of the most recently requested/resent code, or null (1.11). */
  private codeIssuedAt: number | null = null;

  /** Subscribers to the merged auth state (provider state + `reauth-required` overlay). */
  private readonly listeners = new Set<(state: AuthState) => void>();
  /** Unsubscribe handle for our subscription to the provider's auth-state stream. */
  private readonly providerUnsub: Unsubscribe;
  /** Latest known auth state, kept in sync with the provider and refresh outcomes. */
  private currentState: AuthState;

  /**
   * @param provider - the platform adapter that talks to Firebase. All Firebase
   *   interaction flows through this port so the core stays platform-agnostic.
   * @param options - optional policy/clock overrides; see {@link AuthServiceOptions}.
   */
  constructor(provider: AuthTokenProvider, options: AuthServiceOptions = {}) {
    this.provider = provider;
    this.now = options.now ?? Date.now;
    this.maxRefreshAttempts = options.maxRefreshAttempts ?? DEFAULT_MAX_REFRESH_ATTEMPTS;
    this.maxResendsPerWindow = options.maxResendsPerWindow ?? DEFAULT_MAX_RESENDS_PER_WINDOW;
    this.resendWindowMs = options.resendWindowMs ?? DEFAULT_RESEND_WINDOW_MS;
    this.codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS;

    this.currentState = this.deriveStateFromProvider();
    // Re-broadcast provider state changes to our own subscribers, refreshing the
    // cached state. A genuine sign-in/out clears any latched `reauth-required`.
    this.providerUnsub = this.provider.onAuthStateChanged((state) => {
      this.setState(state);
    });
  }

  // -------------------------------------------------------------------------
  // Passthrough accessors (Requirement 1.4) — never logged (Requirement 8.5).
  // -------------------------------------------------------------------------

  /** Current cached Firebase ID token, or `null` if not signed in. */
  getCurrentToken(): string | null {
    return this.provider.getCurrentToken();
  }

  /** Signed-in user's Firebase UID, or `null`. */
  getCurrentUid(): string | null {
    return this.provider.getCurrentUid();
  }

  /** The latest merged auth state (provider state, overlaid with `reauth-required`). */
  getAuthState(): AuthState {
    return this.currentState;
  }

  /**
   * Subscribe to auth-state changes. Fires for provider-driven transitions
   * (signed-in / signed-out) and for the `reauth-required` state this service emits
   * once refresh is exhausted (Requirements 1.4, 1.9).
   *
   * @returns an {@link Unsubscribe} that detaches the listener.
   */
  onAuthStateChanged(listener: (state: AuthState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // OTP request / resend (Requirement 1.10) + issuance tracking (Requirement 1.11).
  // -------------------------------------------------------------------------

  /**
   * Request the INITIAL verification code for `e164`. This is not counted against the
   * resend limit (only subsequent {@link AuthService.resendOtp} calls are; 1.10). On a
   * successful request the issuance clock for code-expiry (1.11) is (re)started.
   */
  async requestOtp(e164: string): Promise<OtpRequestResult> {
    const result = await this.provider.requestPhoneOtp(e164);
    if (result.ok) {
      this.codeIssuedAt = this.now();
    }
    return result;
  }

  /**
   * Request a NEW verification code (a resend) for `e164`, enforcing at most
   * {@link AuthServiceOptions.maxResendsPerWindow} resends within the rolling
   * {@link AuthServiceOptions.resendWindowMs} window per phone number (Requirement
   * 1.10). When the limit is reached the call is refused locally with
   * `{ ok: false, resendLimited: true }` and the provider is NOT invoked.
   *
   * On a permitted, successful resend the issuance clock for code-expiry (1.11) is
   * restarted so the freshly issued code gets its full lifetime.
   */
  async resendOtp(e164: string): Promise<OtpRequestResult> {
    const at = this.now();
    const recent = this.pruneResendHistory(e164, at);

    if (recent.length >= this.maxResendsPerWindow) {
      return {
        ok: false,
        resendLimited: true,
        error: 'Resend limit reached. Try again later.',
      };
    }

    const result = await this.provider.requestPhoneOtp(e164);
    if (result.ok) {
      // Only count resends that actually issued a code toward the rolling limit.
      recent.push(at);
      this.resendHistory.set(e164, recent);
      this.codeIssuedAt = at;
    }
    return result;
  }

  /**
   * Confirm a 6-digit code. Rejects with {@link ExpiredOtpError} when the code is
   * submitted more than {@link AuthServiceOptions.codeTtlMs} (default 300 s) after its
   * issuance, before the provider is called, so an expired code never reaches Firebase
   * (Requirement 1.11). On success the issuance clock is cleared.
   *
   * @throws {ExpiredOtpError} if no code has been issued, or the issued code is older
   *   than the configured lifetime.
   */
  async confirmOtp(code: string): Promise<SignInResult> {
    if (this.codeIssuedAt === null || this.now() - this.codeIssuedAt > this.codeTtlMs) {
      throw new ExpiredOtpError();
    }
    const result = await this.provider.confirmPhoneOtp(code);
    // A consumed code must not be reusable; force a fresh request for any retry.
    this.codeIssuedAt = null;
    return result;
  }

  // -------------------------------------------------------------------------
  // Token refresh orchestration (Requirements 1.6, 1.9).
  // -------------------------------------------------------------------------

  /**
   * Refresh the Firebase ID token, retrying at most
   * {@link AuthServiceOptions.maxRefreshAttempts} times (default 3) and STOPPING on
   * the first success (Requirement 1.6). If every attempt fails, the service
   * transitions to `reauth-required`, broadcasts that state to subscribers, and throws
   * {@link ReauthRequiredError} (Requirement 1.9).
   *
   * Called by the Device_Registrar / Realtime_Client on HTTP 401 / WebSocket close
   * 4401. The returned token is handed straight back to the caller and never logged
   * (Requirement 8.5).
   *
   * @returns the refreshed Firebase ID token on the first successful attempt.
   * @throws {ReauthRequiredError} after `maxRefreshAttempts` consecutive failures.
   */
  async refreshWithRetry(): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxRefreshAttempts; attempt++) {
      try {
        return await this.provider.refreshToken();
      } catch (error) {
        // Swallow the underlying error (it may carry the token) and keep retrying;
        // we surface only a non-sensitive ReauthRequiredError once exhausted (8.5).
        lastError = error;
      }
    }
    void lastError;
    this.setState({ status: 'reauth-required' });
    throw new ReauthRequiredError();
  }

  // -------------------------------------------------------------------------
  // Sign-out passthrough.
  // -------------------------------------------------------------------------

  /**
   * Client-initiated sign-out. Clears the issuance clock and resend history, delegates
   * to the provider (which clears the token), and lets the provider's resulting
   * `signed-out` broadcast flow through to subscribers.
   */
  async signOut(): Promise<void> {
    this.codeIssuedAt = null;
    this.resendHistory.clear();
    await this.provider.signOut();
  }

  /**
   * Detach this service's subscription to the provider's auth-state stream and drop
   * all local subscribers. Call when the service is being torn down.
   */
  dispose(): void {
    this.providerUnsub();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Internal helpers.
  // -------------------------------------------------------------------------

  /** Derive the initial auth state from the provider's synchronous token/uid view. */
  private deriveStateFromProvider(): AuthState {
    const token = this.provider.getCurrentToken();
    const uid = this.provider.getCurrentUid();
    if (token !== null && uid !== null) {
      return { status: 'signed-in', uid, token };
    }
    return { status: 'signed-out' };
  }

  /** Update the cached state and notify every subscriber. */
  private setState(state: AuthState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  /**
   * Return the resend timestamps for `e164` that fall within the rolling window ending
   * at `at`, pruning anything older. Keeps the window "rolling" rather than fixed.
   */
  private pruneResendHistory(e164: string, at: number): number[] {
    const cutoff = at - this.resendWindowMs;
    const recent = (this.resendHistory.get(e164) ?? []).filter((ts) => ts > cutoff);
    this.resendHistory.set(e164, recent);
    return recent;
  }

  // -------------------------------------------------------------------------
  // Log/serialization hygiene (Requirement 8.5).
  // -------------------------------------------------------------------------

  /**
   * Redacts the instance when serialized via `JSON.stringify`, so the Firebase ID
   * token can never leak into a JSON log line through this object (Requirement 8.5).
   */
  toJSON(): Record<string, unknown> {
    return { authState: this.currentState.status, token: REDACTED };
  }

  /**
   * Redacts the instance when printed via `console.log`/`util.inspect` in Node, so an
   * accidental log of the service does not expose the token (Requirement 8.5).
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `AuthService { authState: '${this.currentState.status}', token: '${REDACTED}' }`;
  }
}
