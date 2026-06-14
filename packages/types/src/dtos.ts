/**
 * Device-registration data-transfer object shapes for `POST /api/devices/register`.
 *
 * Source of truth: design.md → "Data Models" → "DTOs and validation rules" and
 * "Components and Interfaces" → Component 4 (DevicesController / RegisterDeviceResponse).
 *
 * NOTE: These are the *shape* contracts only. The runtime validation rules
 * (class-validator decorators such as @IsBase64 / @ArrayMaxSize(200)) live with the
 * backend's `RegisterDeviceDto` class (DevicesModule). Keeping these as plain types
 * here means the shared package carries no runtime/validation dependencies.
 *
 * All key material is PUBLIC only and carried as base64-encoded strings. The server
 * never accepts or stores private key material (§13.3 / §13.4).
 */

/** A signed prekey bundle entry (public key + signature), base64-encoded. */
export interface SignedPreKeyDto {
  /** libsignal signed prekey id (non-negative integer). */
  keyId: number;
  /** Public signed prekey, base64. */
  publicKey: string;
  /** Signature over `publicKey` by the identity key, base64. */
  signature: string;
}

/** A single one-time prekey (public), base64-encoded. */
export interface OneTimePreKeyDto {
  /** libsignal one-time prekey id (non-negative integer). */
  keyId: number;
  /** Public one-time prekey, base64. */
  publicKey: string;
}

/** Request payload for registering a device and publishing its public prekey bundle. */
export interface RegisterDeviceDto {
  /** libsignal registration id (>= 1). */
  registrationId: number;
  /** Public identity key, base64. */
  identityKey: string;
  /** The device's active signed prekey. */
  signedPreKey: SignedPreKeyDto;
  /** Batch of one-time prekeys (bounded 1..200 at the validation layer). */
  oneTimePreKeys: OneTimePreKeyDto[];
  /** Optional human-readable device name (<= 64 chars at the validation layer). */
  deviceName?: string;
  /**
   * Optional E.164 phone number the user signed in with. The server stores it for
   * phone→UID discovery ONLY as a fallback when the verified token carries no phone claim;
   * a token-provided phone always wins, so this cannot override a server-verified number.
   */
  phoneNumber?: string;
}

/** Successful registration response — the server-issued device id. */
export interface RegisterDeviceResponse {
  /** Server-issued device id, used for WebSocket identification in Phase 1 (§15.3 step 5). */
  deviceId: string;
}

/**
 * Request payload for resolving a phone number to a registered user's Firebase UID
 * (`POST /api/directory/resolve`). The phone rides the request BODY (never the URL) so it
 * is not captured in access logs; the lookup is authenticated and rate-limited. This is
 * the contact-discovery surface that lets a client start a chat from a phone number.
 */
export interface ResolvePhoneRequest {
  /** Recipient phone number in E.164 form (e.g. `+919618579123`). */
  phoneNumber: string;
}

/** Successful phone-resolution response — the registered user's canonical Firebase UID. */
export interface ResolvePhoneResponse {
  /** Canonical Firebase UID of the user registered with the requested phone number. */
  uid: string;
  /** The resolved user's chosen display name, or `null` if they haven't set one. */
  displayName: string | null;
}

/** Request to set the signed-in user's display name (`POST /api/directory/profile`). */
export interface SetProfileRequest {
  /** Human-readable display name, 1–32 characters. */
  displayName: string;
}

/**
 * Diagnostic response for `GET /api/directory/me` — the authenticated caller's own
 * discovery state, used to pinpoint why a lookup misses.
 */
export interface WhoAmIResponse {
  /** Caller's canonical Firebase UID. */
  uid: string;
  /** Caller's chosen display name, or `null` if not set. */
  displayName: string | null;
  /** Phone number present on the caller's verified token, or `null` if the token has none. */
  tokenPhone: string | null;
  /** Phone number stored on the caller's user row, or `null` if none was persisted. */
  storedPhone: string | null;
  /** Number of devices the caller has registered. */
  deviceCount: number;
  /**
   * Server-side self-lookup result: the outcome of resolving the caller's OWN stored phone
   * in-process. `ok:<uid>` means discovery works; `fail:<reason>` shows why it doesn't;
   * `no stored phone` means nothing was persisted.
   */
  selfLookup: string;
}
