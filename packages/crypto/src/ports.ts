/**
 * `@chat-app/crypto` — shared port interfaces (Phase 1).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Design principles for this slice" → "Ports and adapters", and
 *   "Components and Interfaces" (Components 1, 4, 5, 6).
 *
 * The shared crypto core is platform-independent. It depends only on the narrow,
 * injected ports defined here — `KeyStore`, `SignalProtocolStore`,
 * `WebSocketTransport`, `AuthTokenProvider`, `HttpClient`, and `KeyStoreFactory`.
 * The platform apps provide the concrete adapters (mobile binds SQLCipher + the
 * Firebase RN SDK + RN WebSocket; web binds an in-memory store + the Firebase Web
 * SDK + the browser `WebSocket`). This is what lets one codebase satisfy
 * Requirement 6.7 (shared logic) and Requirement 7 (divergent storage) at once.
 *
 * This module defines INTERFACES ONLY — there are no implementations here. The
 * concrete logic (IdentityManager, SessionManager, RealtimeClient, DeviceRegistrar,
 * AuthService, …) and the platform adapters land in later tasks.
 */

import type {
  AuthState,
  CiphertextEnvelope,
  ClientToServerFrame,
  MessageStatus,
  ServerToClientFrame,
} from '@chat-app/types';

// ---------------------------------------------------------------------------
// Shared support types used by the ports below.
// ---------------------------------------------------------------------------

/** Removes a previously-registered listener. Returned by every `on…` subscription. */
export type Unsubscribe = () => void;

/** Result of requesting a phone OTP (Requirement 1.10 resend limit surfaced here). */
export interface OtpRequestResult {
  ok: boolean;
  resendLimited?: boolean;
  error?: string;
}

/** Result of a successful sign-in: a fresh Firebase ID token plus the signed-in UID. */
export interface SignInResult {
  uid: string;
  token: string;
}

/** Addresses a remote party's device for libsignal session/identity lookups. */
export interface SignalAddress {
  /** Remote party's Firebase UID. */
  uid: string;
  /** Remote party's server-issued deviceId. */
  deviceId: string;
}

/** A signed prekey held on the device (public + PRIVATE halves + signature). */
export interface SignedPreKeyRecord {
  keyId: number;
  /** Public signed prekey. */
  publicKey: Uint8Array;
  /** PRIVATE signed prekey — never leaves the device. */
  privateKey: Uint8Array;
  /** Signature over `publicKey` by the identity key. */
  signature: Uint8Array;
}

/** A one-time prekey held on the device (public + PRIVATE halves). */
export interface OneTimePreKeyRecord {
  keyId: number;
  /** Public one-time prekey. */
  publicKey: Uint8Array;
  /** PRIVATE one-time prekey — never leaves the device. */
  privateKey: Uint8Array;
}

/**
 * The device's complete libsignal identity set. Persisted atomically — either the
 * whole record is written or nothing is (Requirements 2.7, 2.8). Private halves are
 * retained ONLY inside the Key_Store (Requirements 2.4, 7.1, 8.1).
 */
export interface IdentityRecord {
  /** Signed-in Firebase UID this identity belongs to. */
  uid: string;
  /** libsignal registration id (>= 1). */
  registrationId: number;
  /** Public identity key. */
  identityKeyPublic: Uint8Array;
  /** PRIVATE identity key — never leaves the device. */
  identityKeyPrivate: Uint8Array;
  /** The device's active signed prekey. */
  signedPreKey: SignedPreKeyRecord;
  /** The generated batch of one-time prekeys (1..200 entries). */
  oneTimePreKeys: OneTimePreKeyRecord[];
  /** Creation timestamp (unix ms). */
  createdAt: number;
}

/** A conversation/message row for display + status tracking on the Conversation_Screen. */
export interface MessageRow {
  /** Client-generated uuid. */
  id: string;
  /** The other party's Firebase UID. */
  remoteUid: string;
  /** Whether this message was sent or received. */
  direction: 'out' | 'in';
  /** Per-conversation sequence number. */
  seq: number;
  /** Decrypted text for display; `null` on delivery-error (5.5, 6.9). */
  plaintext: string | null;
  /** Current message status. */
  status: MessageStatus;
  /** Creation timestamp (unix ms). */
  createdAt: number;
  /**
   * Emoji reactions applied to this message (deduped), persisted so they survive a relaunch
   * (Phase 2 Req 3.1). Absent when none.
   */
  reactions?: string[];
  /** `true` once an edit has superseded this message's text (persisted; Req 3.2). */
  edited?: boolean;
  /** `true` once a delete tombstone has removed this message's content (persisted; Req 3.3). */
  deleted?: boolean;
  /**
   * Absolute expiry instant (unix ms) for a disappearing message, or absent/non-finite when the
   * message has no timer. When `now >= expiresAt` the row is purged from the store and removed
   * from the UI (Phase 2 Req 4.2). Stamped at append time from the conversation's active timer.
   */
  expiresAt?: number;
}

// ---------------------------------------------------------------------------
// Port 1: AuthTokenProvider  (design Component 1)
// ---------------------------------------------------------------------------

/**
 * Wraps `@react-native-firebase/auth` (mobile) and the Firebase Web SDK (web)
 * behind one shared interface so the shared `AuthService` core can acquire and
 * refresh the Firebase ID token without knowing the platform
 * (Requirements 1.1–1.11, 8.5, 8.8).
 */
export interface AuthTokenProvider {
  /** Current cached Firebase ID token, or `null` if not signed in. */
  getCurrentToken(): string | null;
  /** Signed-in user's Firebase UID, or `null`. */
  getCurrentUid(): string | null;
  /** Phone OTP: request a verification code for an E.164 number. */
  requestPhoneOtp(e164: string): Promise<OtpRequestResult>;
  /** Phone OTP: confirm a 6-digit code; resolves with a fresh token on success. */
  confirmPhoneOtp(code: string): Promise<SignInResult>;
  /** Force a token refresh from Firebase. Used on HTTP 401 / WebSocket close 4401. */
  refreshToken(): Promise<string>;
  /** Subscribe to auth state changes (signed-in / signed-out / reauth-required). */
  onAuthStateChanged(listener: (state: AuthState) => void): Unsubscribe;
  /** Client-initiated sign-out: clears the token; Realtime_Client must not auto-reconnect. */
  signOut(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Port 2: KeyStore  (design Component 6)
// ---------------------------------------------------------------------------

/**
 * Persists identity material, libsignal session state, sequence counters,
 * conversation/message rows, and the `deviceId`. SQLCipher-encrypted SQLite on
 * mobile; in-memory only on web (Requirements 7.1–7.7, 8.3, D9/D10).
 *
 * Private key material is written ONLY through this port and only into the
 * encrypted (mobile) / in-memory (web) store (Requirements 2.4, 7.1, 7.2, 8.1).
 */
export interface KeyStore {
  /** Atomic write of the complete identity set, or nothing on failure (2.7, 2.8). */
  saveIdentity(record: IdentityRecord): Promise<void>;
  /** Load the stored identity for `uid`, or `null` if none exists (2.6). */
  loadIdentity(uid: string): Promise<IdentityRecord | null>;
  /** Persist the server-issued deviceId after registration (3.3). */
  saveDeviceId(deviceId: string): Promise<void>;
  /** Load the stored deviceId, or `null` if not yet registered. */
  loadDeviceId(): Promise<string | null>;

  // libsignal store surfaces
  /** Load the serialized libsignal session record for a remote address. */
  loadSession(addr: SignalAddress): Promise<Uint8Array | null>;
  /** Persist the serialized libsignal session record for a remote address (5.8). */
  saveSession(addr: SignalAddress, record: Uint8Array): Promise<void>;
  /** Mark a one-time prekey consumed once its inbound PreKeySignalMessage is processed. */
  consumeOneTimePreKey(keyId: number): Promise<void>;

  // sequence + conversation
  /** Allocate the next strictly-increasing per-conversation sequence number (5.3, 6.2). */
  nextSeq(recipientUid: string): Promise<number>;
  /** Append a message row for display (5.10, 6.2, 6.8). */
  appendMessage(row: MessageRow): Promise<void>;
  /** Update a message's status by id (5.6, 5.11, 6.5, 6.8). */
  updateMessageStatus(id: string, status: MessageStatus): Promise<void>;
  /**
   * Load every persisted message row, across all conversations, for rehydrating the UI on
   * relaunch (so chats survive an app restart rather than starting empty — Phase 2 CC4).
   * Order is unspecified; callers group by `remoteUid` and sort by `seq` themselves.
   */
  loadMessages(): Promise<MessageRow[]>;
  /**
   * Persist an emoji reaction onto the target message so it survives a relaunch (Req 3.1).
   * The target is identified by its LOCAL `(direction, seq)`. A no-op if the target is absent
   * or already deleted; reactions are deduped.
   */
  applyReaction(remoteUid: string, direction: 'in' | 'out', seq: number, emoji: string): Promise<void>;
  /** Persist an edit (supersede text + mark edited) onto the target message (Req 3.2). */
  applyEdit(remoteUid: string, direction: 'in' | 'out', seq: number, body: string): Promise<void>;
  /** Persist a delete tombstone onto the target message (drop content + flags) (Req 3.3). */
  applyDelete(remoteUid: string, direction: 'in' | 'out', seq: number): Promise<void>;
  /** Persist the per-conversation disappearing-message timer in ms (`0` disables) (Req 4.1). */
  setConversationTimer(remoteUid: string, ttlMs: number): Promise<void>;
  /** Load every persisted per-conversation timer, keyed by peer uid, for relaunch rehydration. */
  loadConversationTimers(): Promise<Record<string, number>>;
  /**
   * Permanently remove the given message rows as a best-effort secure erase for disappearing
   * messages (Req 4.2/4.4): overwrite the plaintext before dropping the row so the cleartext is
   * not trivially recoverable from the re-serialized store. OS-level backups/snapshots remain out
   * of scope (documented). Unknown ids are ignored.
   */
  purgeMessages(ids: string[]): Promise<void>;

  /** Web only: wipe all in-memory material within the current event cycle (7.4). */
  destroy(): void;
}

/**
 * Builds the platform-appropriate `KeyStore`. Mobile binds SQLCipher
 * (`react-native-sqlcipher-storage`); web binds an in-memory Map-backed store.
 */
export interface KeyStoreFactory {
  create(opts: { platform: 'mobile' | 'web' }): Promise<KeyStore>;
}

// ---------------------------------------------------------------------------
// Port 3: SignalProtocolStore  (libsignal-facing store surface)
// ---------------------------------------------------------------------------

/**
 * The libsignal-facing store contract the `SessionManager` drives when encrypting,
 * decrypting, and establishing sessions. Concrete adapters back this with the
 * `KeyStore` so that private material is read/written only through on-device
 * storage (Requirements 5.1, 5.2, 5.4, 5.8, 8.1).
 *
 * All record blobs are opaque, libsignal-serialized byte arrays.
 */
export interface SignalProtocolStore {
  /** This device's identity key pair (public + PRIVATE). */
  getIdentityKeyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }>;
  /** This device's libsignal registration id (>= 1). */
  getLocalRegistrationId(): Promise<number>;

  /** Load the serialized session record for a remote address, or `null`. */
  loadSession(addr: SignalAddress): Promise<Uint8Array | null>;
  /** Persist the serialized session record for a remote address. */
  storeSession(addr: SignalAddress, record: Uint8Array): Promise<void>;

  /** Load a one-time prekey record by id, or `null` if absent/consumed. */
  loadPreKey(keyId: number): Promise<Uint8Array | null>;
  /** Remove a one-time prekey once it has been used. */
  removePreKey(keyId: number): Promise<void>;

  /** Load the active signed prekey record by id, or `null`. */
  loadSignedPreKey(keyId: number): Promise<Uint8Array | null>;

  /** Record/trust a remote identity key; resolves `true` when the identity changed. */
  saveIdentity(addr: SignalAddress, identityKey: Uint8Array): Promise<boolean>;
  /** Whether `identityKey` is trusted for `addr` (trust-on-first-use for this slice). */
  isTrustedIdentity(addr: SignalAddress, identityKey: Uint8Array): Promise<boolean>;
  /** Load the stored identity key for a remote address, or `null`. */
  loadIdentityKey(addr: SignalAddress): Promise<Uint8Array | null>;
}

// ---------------------------------------------------------------------------
// Port 4: WebSocketTransport  (design Component 4)
// ---------------------------------------------------------------------------

/**
 * A live WebSocket connection, abstracted so the `RealtimeClient` close/heartbeat
 * handling can be unit-tested deterministically without a real socket. The
 * transport carries text frames only (the wire frames are JSON-serialized).
 */
export interface WebSocketHandle {
  /** Send a serialized wire frame. */
  send(data: string): void;
  /** Close the connection, optionally with a close code and reason. */
  close(code?: number, reason?: string): void;
  /** Fires once when the handshake completes. */
  onOpen(listener: () => void): Unsubscribe;
  /** Fires for each inbound text frame. */
  onMessage(listener: (data: string) => void): Unsubscribe;
  /** Fires once when the connection closes, with the close code and reason. */
  onClose(listener: (code: number, reason: string) => void): Unsubscribe;
  /** Fires on a transport-level error. */
  onError(listener: (error: unknown) => void): Unsubscribe;
}

/**
 * Opens authenticated WebSocket connections. The `subprotocols` array carries the
 * `['bearer', <Firebase ID token>]` handshake the Phase 0 gateway parses; the token
 * is never placed in the URL query string (Requirements 4.1, 4.2, 8.6).
 */
export interface WebSocketTransport {
  open(url: string, subprotocols: string[]): WebSocketHandle;
}

// ---------------------------------------------------------------------------
// Port 5: HttpClient  (REST transport for registration + prekey claim)
// ---------------------------------------------------------------------------

/** A single REST request issued by the shared core (Device_Registrar / key claim). */
export interface HttpRequest {
  method: 'GET' | 'POST';
  /** Absolute `https://` URL of the `api.` endpoint. */
  url: string;
  /** Headers, e.g. `Authorization: Bearer <token>` and `Content-Type`. */
  headers?: Record<string, string>;
  /** Serialized request body (JSON string) for `POST`. */
  body?: string;
  /** Per-request timeout in milliseconds (e.g. the 10 s registration timeout, 3.8). */
  timeoutMs?: number;
}

/** A REST response surfaced to the shared core. */
export interface HttpResponse {
  /** HTTP status code (201 / 400 / 401 / 404 / 503 …). */
  status: number;
  headers: Record<string, string>;
  /** Raw response body (JSON string). */
  body: string;
}

/**
 * TLS-only REST transport. Adapters MUST use TLS for the `api.` endpoint and abort
 * without transmitting any payload, token, or key material if TLS cannot be
 * established (Requirements 8.6, 8.7).
 */
export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

// ---------------------------------------------------------------------------
// Re-exported wire types referenced by the ports (convenience for adapters).
// ---------------------------------------------------------------------------

export type { CiphertextEnvelope, ClientToServerFrame, ServerToClientFrame };
