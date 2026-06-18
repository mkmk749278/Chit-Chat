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
 * Public profile of a user resolved by their Firebase UID (`GET /api/directory/profile/:uid`).
 *
 * This is the reverse of phone→UID discovery: given a UID a client already knows (e.g. the
 * `senderUid` on an inbound envelope, or a UID it just resolved), it returns that user's
 * chosen display name so the peer is shown by name instead of a raw UID. Only the public
 * display name is exposed — never the phone number or any other account detail.
 */
export interface GetProfileResponse {
  /** Canonical Firebase UID of the looked-up user (echoes the request). */
  uid: string;
  /** The user's chosen display name, or `null` if they haven't set one. */
  displayName: string | null;
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
  /** Whether the caller has opted in to presence/last-seen (Req 5.1), so the UI can reflect it. */
  presenceEnabled: boolean;
}

/**
 * Request to set the caller's presence opt-in (`POST /api/directory/presence`). Presence and
 * last-seen are OFF by default and only ever exposed to peers when the user opts in (Req 5.1).
 */
export interface SetPresenceRequest {
  /** `true` to let peers see the caller's online/last-seen; `false` to keep it private. */
  enabled: boolean;
}

/**
 * A peer's presence as seen by an authenticated caller (`GET /api/directory/presence/:uid`).
 *
 * Privacy-first (Req 5.1): a user who has NOT opted in is reported with `online: null` and
 * `lastSeen: null` — indistinguishable from "unknown", so opting out never leaks activity.
 */
export interface PresenceResponse {
  /** The looked-up user's Firebase UID (echoes the request). */
  uid: string;
  /**
   * `true`/`false` when the user has opted in and we know their connection state; `null` when
   * they have NOT opted in (presence hidden) — never reveals opted-out users' activity.
   */
  online: boolean | null;
  /**
   * Coarse last-seen as a unix-ms timestamp (rounded down to a 5-minute bucket, Req 5.4), or
   * `null` when the user is opted out, currently online, or has no recorded last-seen.
   */
  lastSeen: number | null;
}


/**
 * Request to publish ADDITIONAL one-time prekeys for an already-registered device
 * (`POST /api/devices/prekeys`). Unlike registration (which replaces the whole bundle), this
 * APPENDS to the device's existing unconsumed one-time prekeys, so a client can replenish them
 * before they run out — otherwise, once exhausted, senders fall back to the signed prekey only,
 * weakening initial-message forward secrecy. The caller's device is identified by `registrationId`.
 */
export interface AddOneTimePreKeysRequest {
  /** The caller device's libsignal registration id (selects which device to append to). */
  registrationId: number;
  /** New one-time prekeys to append; their key ids must not collide with the device's existing ones. */
  oneTimePreKeys: OneTimePreKeyDto[];
}

/** Response to `POST /api/devices/prekeys`: how many one-time prekeys were appended. */
export interface AddOneTimePreKeysResponse {
  /** Count of newly-stored one-time prekeys. */
  added: number;
}

/**
 * Request to set (or revoke) a device's push token (`POST /api/devices/push-token`, Req 6.1).
 *
 * The token wakes the device for a content-free data push when a message is queued while it is
 * offline (Req 6.2). The caller's device is identified by `registrationId`. An empty `pushToken`
 * REVOKES the token so the device stops receiving pushes (Req 6.4).
 */
export interface SetPushTokenRequest {
  /** The caller device's libsignal registration id (selects which device the token belongs to). */
  registrationId: number;
  /** The platform push token (e.g. FCM registration token); empty string revokes it (Req 6.4). */
  pushToken: string;
}
