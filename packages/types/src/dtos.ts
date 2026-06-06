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
}

/** Successful registration response — the server-issued device id. */
export interface RegisterDeviceResponse {
  /** Server-issued device id, used for WebSocket identification in Phase 1 (§15.3 step 5). */
  deviceId: string;
}
