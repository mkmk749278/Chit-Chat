/**
 * `@chat-app/crypto` — `DeviceRegistrar` state machine (Phase 1, design Client Component 3).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Components and Interfaces" → "Client Component 3: Device_Registrar", and
 *   `.kiro/specs/phase1-client-messaging/requirements.md` → Requirement 3
 *   (Device Registration with the Phase 0 Backend), plus Requirements 8.1/8.2 (public
 *   material only) and Requirement 2 (the identity material it forwards).
 *
 * Registers the device's PUBLIC prekey bundle against `POST /api/devices/register`
 * and interprets the documented `201 / 400 / 401 / 503` outcomes with timeout and
 * exponential-backoff handling, idempotent across launches:
 *
 *   - 3.1 / 3.2 — POST with `Authorization: Bearer <token>` and a body containing only
 *     PUBLIC key material (the {@link IdentityManager}'s public bundle, optionally a
 *     `deviceName`); no private material can be reached from the bundle type.
 *   - 3.3 — on HTTP 201, persist the server-issued `deviceId` via {@link KeyStore} and
 *     expose it to the Realtime_Client.
 *   - 3.4 — on HTTP 401, discard the current token, trigger one Auth_Service refresh,
 *     and retry registration at most once; otherwise surface `sign-in-required`.
 *   - 3.5 — on HTTP 400, surface `invalid`, record the offending field from the
 *     response, and do NOT retry the same payload.
 *   - 3.6 / 3.8 / 3.9 — on HTTP 503 or a 10 s request timeout, retry with the shared
 *     {@link BackoffPolicy} (500 ms base, 30 s cap, jitter) up to the 5-minute
 *     cumulative budget, retaining the generated bundle; surface `service-unavailable`
 *     once the budget elapses.
 *   - 3.7 — when a `deviceId` AND identity material are already stored for the
 *     signed-in user, return the stored `deviceId` WITHOUT any network call.
 *
 * The core is kept pure and deterministic: the wall clock (`now`) and the wait
 * primitive (`sleep`) are injected so the backoff/budget behaviour is fully testable
 * without real timers, and all Firebase, HTTP, storage, and key-generation concerns
 * arrive through narrow injected ports.
 */

import type { RegisterDeviceDto, RegisterDeviceResponse } from '@chat-app/types';

import type { BackoffPolicy } from './backoff-policy';
import type { IdentityManager } from './identity-manager';
import type { HttpClient, HttpRequest, KeyStore } from './ports';

// ---------------------------------------------------------------------------
// Public component contract (design Client Component 3).
// ---------------------------------------------------------------------------

/**
 * Registers the device's public bundle against `POST /api/devices/register` and
 * interprets the documented outcomes, idempotent across launches (Requirements
 * 3.1–3.9).
 */
export interface DeviceRegistrar {
  /**
   * Ensure this device is registered. Returns the stored `deviceId` WITHOUT a network
   * call when a `deviceId` and identity material already exist for the signed-in user
   * (Requirement 3.7); otherwise POSTs the public bundle and interprets the response.
   */
  ensureRegistered(): Promise<RegistrationResult>;
}

/**
 * The outcome of {@link DeviceRegistrar.ensureRegistered}.
 *
 * - `registered`          — a `deviceId` is available (freshly registered or stored).
 * - `sign-in-required`    — HTTP 401 persisted after one refreshed retry (3.4).
 * - `invalid`             — HTTP 400; `field` records the offending field, no retry (3.5).
 * - `service-unavailable` — HTTP 503 / timeout past the cumulative budget (3.9).
 */
export type RegistrationResult =
  | { status: 'registered'; deviceId: string }
  | { status: 'sign-in-required' }
  | { status: 'invalid'; field?: string }
  | { status: 'service-unavailable' };

// ---------------------------------------------------------------------------
// Injected collaborators.
// ---------------------------------------------------------------------------

/**
 * The narrow Auth_Service surface the registrar drives. The shared `AuthService`
 * core (design Component 1) satisfies this structurally: it exposes the cached token
 * and UID, and a bounded token refresh that performs up to 3 attempts internally and
 * throws once re-auth is required (Requirements 1.6, 1.9). The registrar layers the
 * "retry registration at most once" policy (3.4) on top of that refresh.
 */
export interface RegistrarAuth {
  /** Current cached Firebase ID token, or `null` if not signed in. */
  getCurrentToken(): string | null;
  /** Signed-in user's Firebase UID, or `null`. */
  getCurrentUid(): string | null;
  /**
   * Refresh the Firebase ID token (bounded retries handled by the Auth_Service).
   * Resolves with a fresh token, or rejects when re-authentication is required.
   */
  refreshWithRetry(): Promise<string>;
}

/** The injected ports + collaborators the registrar depends on. */
export interface DeviceRegistrarDeps {
  /** TLS-only REST transport used for the registration POST (3.1, 8.6). */
  httpClient: HttpClient;
  /** On-device store for the `deviceId` and identity material (3.3, 3.7). */
  keyStore: KeyStore;
  /** Provides the PUBLIC prekey bundle to register (generates on first use) (3.1, 3.2). */
  identityManager: IdentityManager;
  /** Auth_Service surface for the bearer token and 401-driven refresh (3.4). */
  auth: RegistrarAuth;
  /** Shared backoff math + cumulative registration budget (3.6, 3.9). */
  backoff: BackoffPolicy;
}

/** Tuning knobs for {@link DefaultDeviceRegistrar}. */
export interface DeviceRegistrarOptions {
  /** Absolute `https://` URL of the `POST /api/devices/register` endpoint (3.1, 8.6). */
  registerUrl: string;
  /** Optional human-readable device name; at most 64 characters (3.1). */
  deviceName?: string;
  /**
   * Optional E.164 phone number the user signed in with. Sent so the server can record it
   * for phone→UID discovery as a fallback when the verified token carries no phone claim;
   * the server prefers the token's phone when present, so this can never override a
   * server-verified number.
   */
  phoneNumber?: string;
  /**
   * Per-request timeout in ms handed to the {@link HttpClient}; a request that does
   * not respond within this window is cancelled and retried with backoff (3.8).
   * Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}.
   */
  requestTimeoutMs?: number;
  /** Wall-clock source in unix ms; injected for deterministic budget tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Wait primitive; injected so backoff delays are deterministic in tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Maximum length of an optional `deviceName` (Requirement 3.1). */
export const MAX_DEVICE_NAME_LENGTH = 64;

/** The registration request timeout: 10 seconds (Requirement 3.8). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Internal request outcome.
// ---------------------------------------------------------------------------

/** A completed HTTP response, or a transport failure/timeout treated as transient (3.8). */
type PostOutcome =
  | { kind: 'response'; status: number; body: string }
  | { kind: 'failure' };

// ---------------------------------------------------------------------------
// Default implementation.
// ---------------------------------------------------------------------------

/**
 * Default {@link DeviceRegistrar} backed by the injected ports.
 *
 * State machine for {@link DefaultDeviceRegistrar.ensureRegistered}:
 *
 *   1. Resolve the signed-in UID; without one, registration cannot proceed
 *      (`sign-in-required`).
 *   2. Idempotence (3.7): if a `deviceId` AND identity material are already stored for
 *      the UID, return the stored `deviceId` with no network call.
 *   3. Otherwise obtain the PUBLIC bundle from the {@link IdentityManager} (generating
 *      it on first launch) and run the registration loop:
 *        - 201 → persist + expose `deviceId` (3.3) → `registered`.
 *        - 401 → discard token, refresh once, retry once, else `sign-in-required` (3.4).
 *        - 400 → record the offending field, no same-payload retry (3.5) → `invalid`.
 *        - 503 / timeout → backoff retry within the 5-minute budget (3.6/3.8/3.9);
 *          `service-unavailable` once the budget elapses.
 */
export class DefaultDeviceRegistrar implements DeviceRegistrar {
  private readonly httpClient: HttpClient;
  private readonly keyStore: KeyStore;
  private readonly identityManager: IdentityManager;
  private readonly auth: RegistrarAuth;
  private readonly backoff: BackoffPolicy;

  private readonly registerUrl: string;
  private readonly deviceName?: string;
  private readonly phoneNumber?: string;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** The registered `deviceId`, cached after a 201 or an idempotent stored hit (3.3). */
  private deviceId: string | null = null;

  constructor(deps: DeviceRegistrarDeps, options: DeviceRegistrarOptions) {
    if (typeof options.registerUrl !== 'string' || options.registerUrl.length === 0) {
      throw new TypeError('registerUrl must be a non-empty absolute URL');
    }
    if (
      typeof options.deviceName === 'string' &&
      options.deviceName.length > MAX_DEVICE_NAME_LENGTH
    ) {
      throw new RangeError(
        `deviceName must be at most ${MAX_DEVICE_NAME_LENGTH} characters`,
      );
    }

    this.httpClient = deps.httpClient;
    this.keyStore = deps.keyStore;
    this.identityManager = deps.identityManager;
    this.auth = deps.auth;
    this.backoff = deps.backoff;

    this.registerUrl = options.registerUrl;
    this.deviceName = options.deviceName;
    this.phoneNumber = options.phoneNumber;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * The registered `deviceId` for this device, or `null` if registration has not yet
   * succeeded on this instance. Loads from the {@link KeyStore} when not cached so the
   * Realtime_Client can read it after an idempotent (no-network) launch (3.3, 3.7).
   */
  async getDeviceId(): Promise<string | null> {
    if (this.deviceId !== null) {
      return this.deviceId;
    }
    const stored = await this.keyStore.loadDeviceId();
    this.deviceId = stored;
    return stored;
  }

  /** @inheritdoc */
  async ensureRegistered(): Promise<RegistrationResult> {
    const uid = this.auth.getCurrentUid();
    if (uid === null) {
      // No signed-in user: registration requires a Firebase ID token (3.1).
      return { status: 'sign-in-required' };
    }

    // Idempotence across launches (3.7): skip the network entirely when BOTH a stored
    // deviceId and stored identity material exist for the signed-in user.
    const storedDeviceId = await this.keyStore.loadDeviceId();
    const storedIdentity = await this.keyStore.loadIdentity(uid);
    if (storedDeviceId !== null && storedIdentity !== null) {
      this.deviceId = storedDeviceId;
      return { status: 'registered', deviceId: storedDeviceId };
    }

    // Obtain the PUBLIC-only bundle (generated on first launch, reused thereafter).
    // The bundle type carries no private field, so the request body cannot include
    // private key material (Requirements 3.2, 8.1).
    const bundle = await this.identityManager.ensureIdentity(uid);
    const body: RegisterDeviceDto = {
      registrationId: bundle.registrationId,
      identityKey: bundle.identityKey,
      signedPreKey: bundle.signedPreKey,
      oneTimePreKeys: bundle.oneTimePreKeys,
      ...(this.deviceName !== undefined ? { deviceName: this.deviceName } : {}),
      ...(this.phoneNumber !== undefined ? { phoneNumber: this.phoneNumber } : {}),
    };
    const payload = JSON.stringify(body);

    return this.runRegistration(payload);
  }

  /**
   * Run the registration request/response loop for an already-serialized public
   * payload, applying the 401 single-retry (3.4) and 503/timeout backoff-within-budget
   * (3.6/3.8/3.9) policies. The same payload is reused across retries so the generated
   * bundle is never discarded (3.8, 3.9).
   */
  private async runRegistration(payload: string): Promise<RegistrationResult> {
    const startedAt = this.now();
    // Backoff attempt index for 503/timeout retries (0 = first retry).
    let backoffAttempt = 0;
    // The single refreshed retry allowed by 3.4 (also covers a missing initial token).
    let refreshUsed = false;

    for (;;) {
      let token = this.auth.getCurrentToken();
      if (token === null) {
        // No usable token yet: spend the one allowed refresh to obtain one (3.4).
        if (refreshUsed) {
          return { status: 'sign-in-required' };
        }
        refreshUsed = true;
        const refreshed = await this.tryRefresh();
        if (refreshed === null) {
          return { status: 'sign-in-required' };
        }
        token = refreshed;
      }

      const outcome = await this.post(payload, token);

      if (outcome.kind === 'failure') {
        // No HTTP response within the timeout / transport failure → backoff retry (3.8).
        const delay = this.backoff.nextRegistrationDelay(backoffAttempt, this.now() - startedAt);
        if (delay === null) {
          return { status: 'service-unavailable' };
        }
        await this.sleep(delay);
        backoffAttempt += 1;
        continue;
      }

      switch (outcome.status) {
        case 201: {
          // Persist + expose the server-issued deviceId (3.3).
          const deviceId = parseDeviceId(outcome.body);
          if (deviceId === null) {
            // A 201 without a usable deviceId leaves nothing to expose; surface a
            // service-unavailable state rather than fabricating an identifier.
            return { status: 'service-unavailable' };
          }
          await this.keyStore.saveDeviceId(deviceId);
          this.deviceId = deviceId;
          return { status: 'registered', deviceId };
        }

        case 401: {
          // Discard the token, refresh once, retry at most once (3.4).
          if (refreshUsed) {
            return { status: 'sign-in-required' };
          }
          refreshUsed = true;
          const refreshed = await this.tryRefresh();
          if (refreshed === null) {
            return { status: 'sign-in-required' };
          }
          continue;
        }

        case 400: {
          // Record the offending field; never retry the same payload (3.5).
          return { status: 'invalid', field: parseInvalidField(outcome.body) };
        }

        case 503: {
          // Service unavailable → backoff retry within the cumulative budget (3.6, 3.9).
          const delay = this.backoff.nextRegistrationDelay(backoffAttempt, this.now() - startedAt);
          if (delay === null) {
            return { status: 'service-unavailable' };
          }
          await this.sleep(delay);
          backoffAttempt += 1;
          continue;
        }

        default: {
          // Other 5xx are transient → backoff like a 503; everything else is a
          // contract violation we cannot recover by retrying the same payload.
          if (outcome.status >= 500) {
            const delay = this.backoff.nextRegistrationDelay(
              backoffAttempt,
              this.now() - startedAt,
            );
            if (delay === null) {
              return { status: 'service-unavailable' };
            }
            await this.sleep(delay);
            backoffAttempt += 1;
            continue;
          }
          return { status: 'invalid' };
        }
      }
    }
  }

  /**
   * Issue the registration POST with the bearer token and public payload, applying the
   * 10 s timeout (3.8). A transport rejection (timeout, TLS abort, network error) is
   * mapped to a transient `failure` so the caller applies backoff (3.6, 3.8).
   */
  private async post(payload: string, token: string): Promise<PostOutcome> {
    const request: HttpRequest = {
      method: 'POST',
      url: this.registerUrl,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: payload,
      timeoutMs: this.requestTimeoutMs,
    };

    try {
      const response = await this.httpClient.send(request);
      return { kind: 'response', status: response.status, body: response.body };
    } catch {
      // The underlying error may carry sensitive request detail; do not propagate or
      // log it. Treat any rejection as a transient failure subject to backoff (3.8).
      return { kind: 'failure' };
    }
  }

  /**
   * Trigger an Auth_Service token refresh, returning the fresh token, or `null` when
   * re-authentication is required (the refresh threw) (3.4). The refresh error is
   * swallowed because it may carry the token value (Requirement 8.5).
   */
  private async tryRefresh(): Promise<string | null> {
    try {
      return await this.auth.refreshWithRetry();
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Response body parsing.
// ---------------------------------------------------------------------------

/**
 * Extract the server-issued `deviceId` from a 201 response body, or `null` when the
 * body is not JSON or carries no non-empty `deviceId` string (3.3).
 */
function parseDeviceId(body: string): string | null {
  const parsed = safeParseJson(body);
  if (parsed !== null && typeof parsed === 'object') {
    const { deviceId } = parsed as Partial<RegisterDeviceResponse>;
    if (typeof deviceId === 'string' && deviceId.length > 0) {
      return deviceId;
    }
  }
  return null;
}

/**
 * Determine the offending field from a 400 response body (3.5). Handles both an
 * explicit `{ field }` and the NestJS ValidationPipe shape
 * (`{ message: string[] | string }`), from which the leading property token of the
 * first validation message is extracted (e.g. "registrationId must not be less than
 * 1" → `registrationId`, "signedPreKey.keyId must be ..." → `signedPreKey.keyId`).
 * Returns `undefined` when no field can be identified.
 */
function parseInvalidField(body: string): string | undefined {
  const parsed = safeParseJson(body);
  if (parsed === null || typeof parsed !== 'object') {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;

  // Explicit field wins when the backend names it directly.
  if (typeof record.field === 'string' && record.field.length > 0) {
    return record.field;
  }

  const message = record.message;
  const firstMessage = Array.isArray(message)
    ? message.find((m): m is string => typeof m === 'string')
    : typeof message === 'string'
      ? message
      : undefined;

  if (typeof firstMessage === 'string') {
    // class-validator messages start with the (possibly dotted) property path.
    const token = firstMessage.trim().split(/\s+/)[0];
    if (token !== undefined && token.length > 0) {
      return token;
    }
  }

  return undefined;
}

/** Parse JSON, returning `null` instead of throwing on malformed input. */
function safeParseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}
