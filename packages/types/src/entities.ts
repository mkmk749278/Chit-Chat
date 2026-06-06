/**
 * Entity-as-type definitions mirroring the durable PostgreSQL schema.
 *
 * Source of truth: design.md → "Data Models" → PostgreSQL schema (users, devices,
 * signed_prekeys, one_time_prekeys) and the representative TypeORM entities.
 *
 * These describe the persisted row shapes. Column names are snake_case in SQL; the
 * properties here use the camelCase names the TypeORM entities map them to.
 *
 * `bytea` (public key material) columns are represented as `Buffer`. Only PUBLIC key
 * material is ever stored — private keys never leave the device (§13.3 / §13.4).
 */

/** One row per Firebase-authenticated account (`users`). `firebaseUid` is the canonical id (§15.2). */
export interface User {
  /** UUID primary key. */
  id: string;
  /** Canonical Firebase UID — unique. */
  firebaseUid: string;
  /** Nullable; never the discovery surface (hashed elsewhere). */
  phoneNumber?: string;
  email?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A linked device for a user (`devices`). One identity key + registration id per device. */
export interface Device {
  /** UUID primary key. */
  id: string;
  /** Owning user id (FK → users.id, ON DELETE CASCADE). */
  userId: string;
  /** libsignal registration id; unique per `(userId, registrationId)`. */
  registrationId: number;
  /** PUBLIC identity key only. */
  identityKey: Buffer;
  deviceName?: string;
  lastSeenAt?: Date;
  createdAt: Date;
}

/** The active signed prekey for a device (`signed_prekeys`), rotated periodically. */
export interface SignedPreKey {
  /** UUID primary key. */
  id: string;
  /** Owning device id (FK → devices.id, ON DELETE CASCADE). */
  deviceId: string;
  /** libsignal signed prekey id; unique per `(deviceId, keyId)`. */
  keyId: number;
  /** PUBLIC signed prekey. */
  publicKey: Buffer;
  /** Signature over `publicKey` by the identity key. */
  signature: Buffer;
  createdAt: Date;
}

/** A one-time prekey consumed one-per-session by senders (`one_time_prekeys`). Public only. */
export interface OneTimePreKey {
  /** UUID primary key. */
  id: string;
  /** Owning device id (FK → devices.id, ON DELETE CASCADE). */
  deviceId: string;
  /** libsignal one-time prekey id; unique per `(deviceId, keyId)`. */
  keyId: number;
  /** PUBLIC one-time prekey. */
  publicKey: Buffer;
  /** Null until claimed by a sender (Phase 1). */
  consumedAt?: Date;
  createdAt: Date;
}
