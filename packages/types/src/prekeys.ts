/**
 * Prekey-bundle shapes for Phase 1 client messaging.
 *
 * Source of truth: design.md → "Components and Interfaces":
 *   - Client Component 2 (Identity_Manager): `PublicPreKeyBundleOut`
 *   - Client Component 5 (Messaging / SessionManager): `ClaimedPreKeyBundle`
 *   - Backend Component A (KeysController / PreKeyClaimService): `PreKeyBundleResponse`
 *
 * All key material is PUBLIC only and carried as base64-encoded strings. Private key
 * material never appears on these types, so there is no field path by which it could
 * be transmitted off the device (Requirements 2.4, 2.5, 8.1).
 *
 * Pure type definitions with no runtime dependencies — importable by `apps/backend`,
 * `apps/web`, and `apps/mobile` alike.
 */

import type { OneTimePreKeyDto, SignedPreKeyDto } from './dtos';

/**
 * Public-only prekey bundle handed by the Identity_Manager to the Device_Registrar.
 *
 * Structurally matches the Phase 0 `RegisterDeviceDto` body (minus the optional
 * `deviceName`) so the registrar can forward it without reshaping (2.5). Every value
 * is base64 public material — never private keys.
 */
export interface PublicPreKeyBundleOut {
  /** libsignal registration id (>= 1) (2.3). */
  registrationId: number;
  /** Public identity key, base64. */
  identityKey: string;
  /** The device's active signed prekey (public key + signature). */
  signedPreKey: SignedPreKeyDto;
  /** Batch of one-time prekeys (1..200 entries) (2.2). */
  oneTimePreKeys: OneTimePreKeyDto[];
}

/**
 * A recipient's public prekey bundle as returned by the prekey-claim endpoint
 * (`GET /api/keys/:uid`). Carries the identity key, the active signed prekey, and at
 * most one claimed one-time prekey (or `null` when the device's one-time prekeys are
 * exhausted, in which case the sender falls back to the signed prekey only).
 */
export interface PreKeyBundleResponse {
  /** Server-issued device id of the recipient's device. */
  deviceId: string;
  /** Recipient device's libsignal registration id (>= 1). */
  registrationId: number;
  /** Recipient's public identity key, base64. */
  identityKey: string;
  /** Recipient device's active signed prekey (public key + signature). */
  signedPreKey: SignedPreKeyDto;
  /** Claimed one-time prekey, or `null` when the device's one-time prekeys are exhausted. */
  oneTimePreKey: OneTimePreKeyDto | null;
}

/**
 * The claimed public prekey bundle consumed by the SessionManager to establish a
 * libsignal session to a recipient device (5.1, 5.8). This is the client-side view of
 * the data returned by the prekey-claim endpoint, so it mirrors `PreKeyBundleResponse`.
 */
export type ClaimedPreKeyBundle = PreKeyBundleResponse;
