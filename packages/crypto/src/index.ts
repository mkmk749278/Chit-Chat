/**
 * `@chat-app/crypto` — libsignal wrapper (shared TypeScript).
 *
 * Phase 0 scope: expose the signature-verification function shape that device
 * registration depends on (Requirement 2.9). This is an intentional stub — the
 * function signature and a working implementation shape are defined here, while the
 * real libsignal Curve25519 / XEdDSA wiring lands in Phase 1.
 *
 * The server only ever handles PUBLIC key material (Requirement 13.4); no private
 * keys are accepted, stored, or passed through this module.
 */

/**
 * Public key material accepted by the verification API. Callers may pass raw bytes
 * (`Uint8Array`, including a Node `Buffer`) or a base64-encoded string. Base64 is
 * the on-the-wire shape of the prekey bundle (`RegisterDeviceDto`), so accepting it
 * lets `DevicesService` forward DTO fields directly without an extra decode step.
 */
export type KeyMaterial = Uint8Array | string;

/**
 * Verifies that `signature` is a valid signature over `publicKey` (a signed prekey's
 * public key) produced by the private key paired with `identityKey`.
 *
 * Used by device registration to validate a signed prekey before persisting the
 * public prekey bundle (Requirement 2.9). A registration whose signed prekey
 * signature fails verification is rejected before any database access.
 *
 * @param identityKey - the signer's PUBLIC identity key (bytes or base64 string)
 * @param publicKey   - the signed prekey PUBLIC key that was signed (bytes or base64)
 * @param signature   - the signature asserted over `publicKey` (bytes or base64)
 * @returns `true` when the signature verifies against `identityKey`, otherwise `false`
 * @throws {TypeError} if any argument is neither a `Uint8Array` nor a valid base64 string
 *
 * @remarks
 * Phase 0 stub. It enforces the structural preconditions the real implementation
 * also requires (each argument must decode to a non-empty byte sequence) and returns
 * a placeholder positive result for well-formed input. Phase 1 replaces the
 * placeholder body with libsignal's authoritative verification while keeping this
 * exact signature, so callers (e.g. `DevicesService`) need no changes.
 */
export function verifySignedPreKeySignature(
  identityKey: KeyMaterial,
  publicKey: KeyMaterial,
  signature: KeyMaterial,
): boolean {
  const identityBytes = toBytes(identityKey, 'identityKey');
  const publicKeyBytes = toBytes(publicKey, 'publicKey');
  const signatureBytes = toBytes(signature, 'signature');

  // Structurally invalid material can never be a valid signed prekey signature.
  if (identityBytes.length === 0 || publicKeyBytes.length === 0 || signatureBytes.length === 0) {
    return false;
  }

  // TODO(phase-1): replace this placeholder with real libsignal verification
  // (Curve25519 / XEdDSA) against `identityKey`. Phase 0 intentionally returns a
  // placeholder positive result for structurally well-formed public key material so
  // device registration can be wired end-to-end without the native bindings.
  return true;
}

/**
 * Coerces accepted key material into raw bytes. `Buffer` is a `Uint8Array` subclass,
 * so backend callers may pass either; strings are decoded as base64.
 *
 * @throws {TypeError} if `value` is neither a `Uint8Array` nor a valid base64 string
 */
function toBytes(value: KeyMaterial, name: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === 'string') {
    return decodeBase64(value, name);
  }
  throw new TypeError(`${name} must be a Uint8Array or base64 string of public key bytes`);
}

/** Matches canonical base64 (optionally padded). The empty string is allowed and decodes to 0 bytes. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes a base64 string to bytes, rejecting input that is not valid base64 so a
 * malformed key value surfaces as a clear `TypeError` rather than silently producing
 * garbage bytes.
 */
function decodeBase64(value: string, name: string): Uint8Array {
  if (!BASE64_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a valid base64-encoded string of public key bytes`);
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/**
 * Shared port interfaces (Phase 1). The platform-agnostic crypto core depends only
 * on these narrow, injected ports — `KeyStore`, `SignalProtocolStore`,
 * `WebSocketTransport`, `AuthTokenProvider`, `HttpClient`, and `KeyStoreFactory`
 * (Requirement 6.7). Interfaces only; implementations land in later tasks.
 */
export * from './ports';

/**
 * Backoff policy (Phase 1). Pure exponential-backoff math with injected RNG and a cumulative
 * registration budget, shared by `Device_Registrar` retries and `Realtime_Client` reconnection
 * (Requirements 3.6, 3.9, 4.5, 4.6, 4.10, 4.11).
 */
export * from './backoff-policy';

/**
 * `SequenceAllocator` — strictly increasing per-conversation sequence numbers
 * backed by `KeyStore.nextSeq` (Requirements 5.3, 6.2). Exposes the interface plus
 * the default `KeyStoreSequenceAllocator` implementation.
 */
export * from './sequence-allocator';

/**
 * `ConversationReducer` — the pure, platform-shared reducer that maps conversation
 * events onto a single render state (dedup+ordered message list, composer
 * send-enablement, web ephemerality-ack gating). Consumed identically by the mobile
 * and web Conversation_Screen (Requirements 6.2–6.9, 7.7, 8.3, design Component 7).
 */
export * from './conversation-reducer';

/**
 * `EnvelopeCodec` (Phase 1, design Component 5: Messaging). Builds/parses the
 * `CiphertextEnvelope` wire frame from routing metadata + libsignal ciphertext body,
 * with no parameter or field for plaintext anywhere (Requirements 5.3, 5.7, 8.2).
 */
export * from './envelope-codec';

/**
 * `SessionManager` (Phase 1, design Component 5: Messaging). Establishes libsignal
 * sessions from claimed PUBLIC prekey bundles, encrypts/decrypts 1:1 messages over the
 * injected `SignalProtocolStore` (sessions persisted via `KeyStore.saveSession`), with
 * the native `@signalapp/libsignal-client` calls isolated behind the thin, injected
 * `LibsignalEngine` port (Requirements 5.1, 5.2, 5.4, 5.8).
 */
export * from './session-manager';

/**
 * `AuthService` (Phase 1, design Component 1: Auth_Service). The platform-agnostic
 * core that wraps an injected `AuthTokenProvider` and adds the orchestration the
 * provider does not enforce: bounded token-refresh retries with a `reauth-required`
 * transition (1.6, 1.9), an OTP resend limit per rolling 60-minute window (1.10),
 * code-expiry rejection past 300 s (1.11), and keeping the token out of logs (8.5).
 */
export * from './auth-service';

/**
 * `IdentityManager` (Phase 1, design Client Component 2). Generates, holds, and
 * exposes the device's libsignal identity material — identity key pair, registration
 * id (>= 1), signed prekey (+ signature), and a 1..200 one-time prekey batch with
 * non-negative, batch-unique key ids. Persists the complete set atomically (or
 * nothing on failure) via the injected `KeyStore`, and exposes a public-only base64
 * bundle; private halves never leave the device (Requirements 2.1–2.8, 7.5, 8.1).
 */
export * from './identity-manager';

/**
 * `DeviceRegistrar` (Phase 1, design Client Component 3). The registration state
 * machine that POSTs the PUBLIC prekey bundle to `POST /api/devices/register` with a
 * bearer token and interprets the documented `201 / 400 / 401 / 503` outcomes — 201
 * persists + exposes the `deviceId` (3.3), 401 refreshes the token and retries once
 * (3.4), 400 records the offending field without retrying the same payload (3.5), and
 * 503 / 10 s timeout retry with the shared `BackoffPolicy` up to the 5-minute budget
 * before surfacing `service-unavailable` (3.6, 3.8, 3.9). Idempotent across launches
 * via the stored `deviceId` (3.7) (Requirements 3.1–3.9).
 */
export * from './device-registrar';

/**
 * `RealtimeClient` (Phase 1, design Component 4: Realtime_Client). The authenticated
 * WebSocket state machine that opens the connection over the `['bearer', token]`
 * subprotocol (never the URL), answers heartbeat pings with a pong, and reconnects
 * with close-code-aware policy — `4401` refresh-then-reconnect (stopping with a
 * re-auth-required indication once refresh is exhausted), `4503`/`4429`/other
 * non-deliberate close / handshake timeout / missed pong under jittered backoff, and
 * no reconnection after a client-initiated disconnect — exposing a `connected` /
 * `disconnected` status (Requirements 4.1–4.11, 6.6). Exports the class plus the pure
 * `classifyReconnect` close-code classifier and the injectable `Scheduler` port.
 */
export * from './realtime-client';

/**
 * `Messaging` (Phase 1, design Component 5: Messaging). The stateful orchestrator that
 * ties the shared pieces into the 1:1 send/receive lifecycle: `send` establishes a
 * libsignal session if needed (claim → establish), allocates the per-conversation seq,
 * encrypts, builds the plaintext-free envelope, and transmits — or holds the frame in a
 * pending-send queue while disconnected and flushes it exactly once on reconnect (5.2,
 * 5.10). A transmitted message arms a 30 s ack deadline: an `ack` frame moves it
 * `sending → sent` and a timeout moves it `sending → failed` with its text retained (5.6,
 * 5.11); a session-establishment / encrypt failure transmits nothing and marks the
 * message `failed` (5.9). `onEnvelope` decrypts and renders inbound plaintext, or surfaces
 * a `delivery-error` with no plaintext on failure (5.5, 6.9). Conversation changes are
 * emitted as `ConversationEvent`s for the shared `ConversationReducer` (6.7).
 */
export * from './messaging';

/**
 * In-memory {@link SignalProtocolStore} (Phase 1). A pure-JS, dependency-free backing for
 * the libsignal-facing store surface — the reference store for the web client (process
 * memory, wiped on session end) and the engine tests. The mobile client backs the same
 * port with the SQLCipher `KeyStore`. The real libsignal engine that drives this store
 * (`createLibsignalEngine`) lives in the Node-only `libsignal-engine.node` module and is
 * intentionally not re-exported here, so the web/mobile bundlers never pull in the native
 * library (the platform adapter binds the engine at runtime).
 */
export * from './in-memory-signal-store';

/**
 * Pure-TypeScript {@link LibsignalEngine} + {@link LibsignalKeyGen}
 * (`@privacyresearch/libsignal-protocol-typescript`) — the SHIPPABLE runtime binding of
 * the crypto ports for BOTH the web and mobile clients. Depends only on pure-JS packages
 * (no native addon), so unlike `libsignal-engine.node` it is safe to bundle into Metro /
 * webbundles and is exported here for the platform controllers to wire. One implementation
 * for all clients keeps ciphertext wire-compatible across web and mobile (see
 * `docs/messaging-runtime-binding.md`). Hosts must provide WebCrypto (`crypto.subtle` +
 * `getRandomValues`) and `Buffer`; React Native injects these via polyfills at app entry.
 */
export * from './libsignal-puretsignal';


/**
 * `computeSafetyNumber` (Phase 2, design "Identity verification"; Requirement 1). A pure,
 * deterministic generator that derives a human-comparable 60-digit safety number from both
 * parties' PUBLIC identity keys, so users can detect a man-in-the-middle. Symmetric (both
 * devices compute the same number) and sensitive to any identity-key change. Depends only on
 * WebCrypto `crypto.subtle`; references no private key material.
 */
export * from './safety-number';


/**
 * Versioned E2E content payload (Phase 2, Requirement 3). `encodeContentPayload` /
 * `decodeContentPayload` wrap the libsignal plaintext so reactions, edits, deletes (and later
 * timers/attachments) ride inside the existing ciphertext — the server still sees only an
 * opaque envelope. Decoding is total and backward-compatible: a legacy bare-string plaintext
 * decodes as `{ type: 'text' }`, and an unknown future type as `{ type: 'unsupported' }`.
 */
export * from './content-payload';


/**
 * Disappearing-message expiry math (Phase 2, Requirement 4). Pure, clock-injected helpers
 * (`computeExpiresAt`, `selectExpired`, `msUntilNextExpiry`) that decide when a timed or
 * view-once message should be purged; the platform store performs the actual secure deletion.
 */
export * from './disappearing-timer';


/**
 * Per-attachment symmetric encryption (Phase 2, Requirement 7). `encryptAttachment` /
 * `decryptAttachment` wrap media bytes in AES-256-GCM under a fresh per-attachment key, so the
 * blob store only ever holds ciphertext and the key rides in the E2E `attachment` content payload.
 * Pure WebCrypto; no I/O — the caller owns upload/download.
 */
export * from './attachment-crypto';
