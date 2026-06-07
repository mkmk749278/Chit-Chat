# Implementation Plan: Phase 1 — Client Messaging (First Vertical Slice)

## Overview

This plan converts the Phase 1 design into incremental, test-driven coding tasks for the existing monorepo
(`packages/types`, `packages/crypto`, `apps/backend`, `apps/mobile`, `apps/web`). It follows a buildable
order: shared types first, then the platform-agnostic shared core (ports + pure logic), then the Phase 1
backend additions the client depends on, then the mobile and web adapters/screens that bind the shared core
to each platform, and finally the cross-cutting integration/e2e/smoke tests.

Implementation language is **TypeScript** throughout, matching the design and the Phase 0 codebase.

Testing approach (from the design's Testing Strategy):
- **Property-based tests** use `fast-check` integrated with `Jest`, each running a minimum of 100 generated
  cases, and each tagged with a comment
  `// Feature: phase1-client-messaging, Property {n}: {property text}`.
- The shared crypto core and backend claim/relay logic are unit- and property-testable **without a device**
  (injected `Date.now`, RNG, WebSocket constructor, Firebase SDK, and Key_Store).
- Mobile/web **integration** tests require their platform toolchains (Expo / RN, Next.js, Firebase emulator,
  SQLCipher, the real Phase 0 gateway) and are grouped at the end.
- Test sub-tasks are marked optional with `*` (consistent with Phase 0). Core implementation tasks are never
  optional.

## Tasks

- [x] 1. Shared wire and domain types in `packages/types`
  - [x] 1.1 Define ciphertext envelope and WebSocket frame types
    - Add `EnvelopeRouting` (senderUid, recipientUid, senderDeviceId, seq), `CiphertextBody`
      (`type: 1 | 3`, `ciphertext` base64), and `CiphertextEnvelope extends EnvelopeRouting, CiphertextBody`
      — no plaintext field anywhere on the type
    - Add `ClientToServerFrame` (`{ kind: 'send'; envelope }`) and `ServerToClientFrame`
      (`{ kind: 'deliver'; envelope } | { kind: 'ack'; recipientUid; seq; status: 'received' }`)
    - Export from `@chat-app/types` for backend + both clients
    - _Requirements: 5.3, 5.7_

  - [x] 1.2 Define prekey-bundle, status, and auth-state types
    - Add `PublicPreKeyBundleOut` (matching the Phase 0 `RegisterDeviceDto` shape), `ClaimedPreKeyBundle`,
      and `PreKeyBundleResponse` (deviceId, registrationId, identityKey, signedPreKey, nullable oneTimePreKey)
    - Add `MessageStatus` (`sending | sent | failed | received | delivery-error`), `ConnectionStatus`
      (`connected | disconnected`), and `AuthState` (`signed-out | signed-in | reauth-required`) discriminated unions
    - Export all from `@chat-app/types`
    - _Requirements: 2.5, 3.1, 5.6, 6.5, 6.6_

  - [x]* 1.3 Write unit tests for type shape conformance
    - Assert `PublicPreKeyBundleOut` structurally matches the Phase 0 `RegisterDeviceDto` (registrationId,
      identityKey, signedPreKey{keyId,publicKey,signature}, oneTimePreKeys[])
    - _Requirements: 2.5, 3.1_

- [ ] 2. Shared crypto core in `packages/crypto` (platform-agnostic, injected ports)
  - [x] 2.1 Define shared port interfaces
    - Define `KeyStore`, `SignalProtocolStore`, `WebSocketTransport`, `AuthTokenProvider`, `HttpClient`, and
      `KeyStoreFactory` interfaces so the core depends only on narrow injected ports
    - _Requirements: 6.7_

  - [x] 2.2 Implement `EnvelopeCodec`
    - `encode(meta, body)` and `decode(envelope)` with no parameter or field for plaintext
    - _Requirements: 5.3, 5.7, 8.2_

  - [x]* 2.3 Write property test for envelope codec round-trip
    - **Property 2: Envelope codec round-trip**
    - **Validates: Requirements 5.3**

  - [x]* 2.4 Write property test for no plaintext on the wire
    - **Property 3: No plaintext on the wire**
    - Deep-scan every serialized outbound frame for plaintext bytes; assert absence
    - **Validates: Requirements 5.3, 5.7, 8.2**

  - [x] 2.5 Implement `SequenceAllocator`
    - Strictly increasing per-conversation sequence numbers backed by `KeyStore.nextSeq`
    - _Requirements: 5.3, 6.2_

  - [x]* 2.6 Write property test for per-conversation sequence monotonicity
    - **Property 5: Per-conversation sequence monotonicity**
    - **Validates: Requirements 5.3, 6.2**

  - [x] 2.7 Implement `BackoffPolicy`
    - Exponential backoff with 500 ms base, 30 s cap, randomised jitter (injected RNG), and a 5-minute
      cumulative-budget stop for registration retries
    - _Requirements: 3.6, 3.9, 4.5, 4.6, 4.10, 4.11_

  - [x]* 2.8 Write property test for backoff delay bounds
    - **Property 11: Backoff delays stay within bounds**
    - **Validates: Requirements 3.6, 3.9, 4.5, 4.6, 4.10, 4.11**

  - [x] 2.9 Implement `IdentityManager`
    - Generate identity key pair, registration id (≥ 1), signed prekey (+ signature), and a 1..200 one-time
      prekey batch with non-negative, batch-unique key ids; atomic persist or persist nothing on failure;
      `ensureIdentity` reuses stored identity; expose public-only base64 bundle
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 7.5, 8.1_

  - [x]* 2.10 Write property test for well-formed public prekey bundle
    - **Property 7: Well-formed public prekey bundle**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.5**

  - [x]* 2.11 Write property test for identity generation atomicity
    - **Property 8: Identity generation atomicity** (inject failures at random generation steps)
    - **Validates: Requirements 2.7, 2.8**

  - [x]* 2.12 Write property test for identity reuse idempotence
    - **Property 9: Identity reuse idempotence**
    - **Validates: Requirements 2.6**

  - [x]* 2.13 Write property test for public keys only leaving the device
    - **Property 4: Public keys only leave the device** (scan all values passed to registrar/realtime/network)
    - **Validates: Requirements 2.4, 3.2, 8.1**

  - [x] 2.14 Implement `SessionManager`
    - `hasSession`, `establishSession` from a claimed bundle (persists state), `encrypt`, `decrypt` over the
      injected `SignalProtocolStore`/`KeyStore`
    - _Requirements: 5.1, 5.2, 5.4, 5.8_

  - [x]* 2.15 Write property test for libsignal session round-trip
    - **Property 1: libsignal session round-trip** (multi-message sequence using persisted state)
    - **Validates: Requirements 5.1, 5.2, 5.4, 5.8**

  - [x]* 2.16 Write property test for decrypt failure yielding no plaintext
    - **Property 15: Decrypt failure yields no plaintext**
    - **Validates: Requirements 5.5, 6.9**

  - [x] 2.17 Implement `AuthService` core
    - Token-refresh orchestration (≤ 3 attempts, stop on first success, then `reauth-required`), OTP resend
      limit (≤ 5 per 60 min), expired-code (> 300 s) rejection, token excluded from logs; binds to the
      injected `AuthTokenProvider`
    - _Requirements: 1.6, 1.9, 1.10, 1.11, 8.5_

  - [x]* 2.18 Write property test for bounded token-refresh retry
    - **Property 12: Token-refresh retry is bounded**
    - **Validates: Requirements 1.6, 1.9, 3.4, 4.4, 4.9**

  - [x]* 2.19 Write property test for no secrets in logs or error reports
    - **Property 20: No secrets in logs or error reports**
    - **Validates: Requirements 1.8, 8.5**

  - [x]* 2.20 Write unit tests for AuthService example behaviors
    - Token + uid exposed to consumers on sign-in (1.4); rejected credential retains phone number + shows
      error (1.5); email/Google route through the same token path (1.7)
    - _Requirements: 1.4, 1.5, 1.7_

  - [x] 2.21 Implement `DeviceRegistrar` state machine
    - POST `/api/devices/register` with `Authorization: Bearer`, public bundle only; handle 201/400/401/503,
      10 s timeout, idempotent across launches via stored `deviceId`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [x]* 2.22 Write property test for registration idempotence across launches
    - **Property 10: Registration idempotence across launches**
    - **Validates: Requirements 3.7**

  - [x]* 2.23 Write unit tests for DeviceRegistrar example branches
    - 201 persists and exposes `deviceId` (3.3); 400 records the offending field and does not retry the same
      payload (3.5)
    - _Requirements: 3.3, 3.5_

  - [x] 2.24 Implement `RealtimeClient` state machine
    - Open WSS with `['bearer', token]` subprotocol (never in URL), pong within 5 s, close-code-aware
      reconnect (4401 refresh-then-reconnect, 4503/4429/other backoff, client-initiated no reconnect),
      handshake timeout, expose `connected`/`disconnected` status
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 6.6_

  - [x]* 2.25 Write property test for close-code-driven reconnect classification
    - **Property 13: Close-code-driven reconnect classification**
    - **Validates: Requirements 4.4, 4.5, 4.6, 4.8**

  - [x]* 2.26 Write property test for connection status reflecting socket state
    - **Property 14: Connection status reflects socket state**
    - **Validates: Requirements 4.7, 6.6**

  - [x] 2.27 Implement `Messaging` orchestration
    - `send` (establish session if needed, allocate seq, encrypt, build envelope, transmit), pending-send
      hold while disconnected and flush-once on reconnect, ack→sent and 30 s timeout→failed, `onEnvelope`
      decrypt-and-render / delivery-error
    - _Requirements: 5.2, 5.5, 5.6, 5.9, 5.10, 5.11_

  - [x]* 2.28 Write property test for pending send flushing exactly once
    - **Property 16: Pending send flushes exactly once**
    - **Validates: Requirements 5.10**

  - [x]* 2.29 Write property test for ack and timeout status transitions
    - **Property 17: Ack and timeout status transitions**
    - **Validates: Requirements 5.6, 5.11, 6.5, 6.8**

  - [x] 2.30 Implement `ConversationReducer`
    - Pure reducer producing dedup+ordered message list, composer send-enablement, and web ephemerality-ack
      gating consumed identically by both platforms
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6, 6.8, 6.9, 7.7, 8.3_

  - [x]* 2.31 Write property test for message-list dedup and ordering
    - **Property 6: Message-list dedup and ordering**
    - **Validates: Requirements 6.2**

  - [x]* 2.32 Write property test for composer send-enablement validation
    - **Property 21: Composer send-enablement validation**
    - **Validates: Requirements 6.3, 6.4**

  - [x]* 2.33 Write property test for web messaging gated on ephemerality acknowledgment
    - **Property 18: Web messaging gated on ephemerality acknowledgment**
    - **Validates: Requirements 7.7, 8.3**

- [~] 3. Checkpoint - shared core
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Phase 1 backend additions in `apps/backend`
  - [x] 4.1 Implement `PreKeyClaimService`
    - Resolve recipientUid → device row (single device per user); atomically claim one unconsumed one-time
      prekey via `SELECT ... WHERE consumed_at IS NULL FOR UPDATE SKIP LOCKED` (using
      `idx_onetime_prekeys_device_unconsumed`), set `consumed_at = now()`; return identity key + active
      signed prekey + claimed one-time prekey (or `null` when exhausted)
    - _Requirements: 5.1_

  - [x] 4.2 Implement `KeysController` `GET /api/keys/:uid`
    - Guard with the Phase 0 `FirebaseAuthGuard`; return `PreKeyBundleResponse`; `404` when the recipient has
      no registered device
    - _Requirements: 5.1_

  - [ ]* 4.3 Write property test for prekey claim consuming exactly one one-time prekey
    - **Property 22: Prekey claim consumes exactly one one-time prekey** (including concurrent claims never
      double-issuing, and `null` when exhausted)
    - **Validates: Requirements 5.1**

  - [x]* 4.4 Write unit tests for KeysController auth/not-found branches
    - `404` for a recipient with no device; `401` (guard) for an unauthenticated caller
    - _Requirements: 5.1_

  - [x] 4.5 Implement `MessageRelayService`
    - Bind `envelope.senderUid` to the authenticated connection UID (reject `sender-mismatch`); look up
      `presence:{recipientUid}` → nodes; publish `NodeRelayMessage` to `node:{nodeId}`; `deliverLocal` to the
      recipient's local socket(s); treat ciphertext as opaque (never decode/log)
    - _Requirements: 5.7, 8.2_

  - [x]* 4.6 Write property test for relay binding sender to the authenticated connection
    - **Property 23: Relay binds sender to the authenticated connection**
    - **Validates: Requirements 5.7, 8.2**

  - [x] 4.7 Wire the message handler into `RealtimeGateway` (and optional ciphertext persistence)
    - Add the `send`-frame handler calling `MessageRelayService.relay`, send an `ack` frame back to the
      sender on accepted delivery; optionally persist to the minimal ciphertext-only `messages` table
      (off the delivery hot path) with its migration
    - _Requirements: 5.6, 5.7_

  - [x]* 4.8 Write unit test for ACK on accepted relay
    - Accepted relay returns `{ status: 'received' }` and the gateway emits an `ack` frame to the sender
    - _Requirements: 5.6_

- [~] 5. Checkpoint - backend additions
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Mobile adapters and screens in `apps/mobile`
  - [-] 6.1 Implement `FirebaseAuthAdapter` (`@react-native-firebase/auth`)
    - Bind `AuthTokenProvider`: phone OTP request/confirm, current token + uid, refresh, sign-out
    - _Requirements: 1.2, 1.3, 1.4, 1.7_

  - [-] 6.2 Implement SQLCipher `KeyStore` adapter (`react-native-sqlcipher-storage`)
    - Implement the `KeyStore` surface over the SQLCipher schema; write no private material outside the
      encrypted DB; on open/decrypt failure write nothing unencrypted and surface a secure-storage error
    - _Requirements: 7.1, 7.6_

  - [ ]* 6.3 Write unit test for SQLCipher unavailable path
    - Failure to initialize/open/decrypt writes no identity/session/deviceId to unencrypted storage and
      surfaces the error
    - _Requirements: 7.6_

  - [~] 6.4 Implement mobile `WebSocketTransport` adapter
    - Open WSS with the `['bearer', token]` subprotocol over TLS; never put the token in the URL
    - _Requirements: 4.1, 4.2, 8.6_

  - [~] 6.5 Implement mobile `HttpClient` adapter
    - TLS-only requests to the `api.` endpoint; abort without transmitting on TLS failure
    - _Requirements: 8.6, 8.7_

  - [~] 6.6 Build mobile `Sign_In_Screen`
    - Shown when no valid token; phone + OTP inputs wired to the shared `AuthService`; error/retain-phone on
      rejection
    - _Requirements: 1.1, 1.5, 6.1_

  - [~] 6.7 Build mobile `Conversation_Screen`
    - Render the shared `ConversationReducer` state (message list, composer, status, connection indicator)
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 6.6, 6.8, 6.9_

  - [x] 6.8 Configure Android manifest to exclude restricted capabilities
    - Declare none of SMS, Call Log, Accessibility Service, or `QUERY_ALL_PACKAGES`
    - _Requirements: 8.4_

  - [~] 6.9 Wire mobile app bootstrap end-to-end
    - Connect Auth → Identity → Registrar → Realtime → Messaging using the shared core and the mobile
      adapters/screens, with no orphaned wiring
    - _Requirements: 6.7_

- [ ] 7. Web adapters and screens in `apps/web`
  - [x] 7.1 Implement Firebase Web SDK auth adapter
    - Bind `AuthTokenProvider`: phone OTP request/confirm, current token + uid, refresh, sign-out
    - _Requirements: 1.2, 1.3, 1.4, 1.7_

  - [x] 7.2 Implement in-memory `KeyStore` adapter with session-end wipe
    - Hold identity/session material in JS memory only (no localStorage/sessionStorage/IndexedDB/Cache/Web
      SQL/cookies); `destroy()` wipes within the page-unload/tab-close/sign-out event cycle; no key-backup path
    - _Requirements: 7.2, 7.4, 7.5_

  - [ ]* 7.3 Write property test for web session-end wipe
    - **Property 19: Web session-end wipe**
    - **Validates: Requirements 7.2, 7.4**

  - [x] 7.4 Implement web `WebSocketTransport` adapter
    - Open WSS with the `['bearer', token]` subprotocol over TLS; never put the token in the URL
    - _Requirements: 4.1, 4.2, 8.6_

  - [x] 7.5 Implement web `HttpClient` adapter
    - TLS-only requests to the `api.` endpoint; abort without transmitting on TLS failure
    - _Requirements: 8.6, 8.7_

  - [x] 7.6 Build web `Sign_In_Screen` with ephemerality warning gate
    - Sign-in inputs wired to the shared `AuthService`; display the in-memory-only + history-unreadable
      warning (D9/D10), keep it visible until explicit acknowledgment, and gate messaging on that acknowledgment
    - _Requirements: 1.1, 6.1, 7.3, 7.7, 8.3_

  - [x] 7.7 Build web `Conversation_Screen`
    - Render the shared `ConversationReducer` state (message list, composer, status, connection indicator)
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 6.6, 6.8, 6.9_

  - [~] 7.8 Wire web app bootstrap end-to-end
    - Connect Auth → Identity → Registrar → Realtime → Messaging using the shared core and the web
      adapters/screens, with no orphaned wiring
    - _Requirements: 6.7_

- [ ] 8. Integration, end-to-end, and smoke tests
  - [ ]* 8.1 Write Firebase OTP integration test (Firebase Auth emulator)
    - Phone OTP request/confirm timing and external behavior
    - _Requirements: 1.2, 1.3_

  - [ ]* 8.2 Write WebSocket handshake integration test against the Phase 0 gateway
    - Real `['bearer', idToken]` handshake; `4401` on a bad token; ping/pong liveness; presence registry
      entry appears/clears
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 8.3 Write prekey-claim consume-once integration test
    - Register a device, claim its bundle, assert exactly one one-time prekey is consumed and a second claim
      returns the next (or `null` when exhausted)
    - _Requirements: 5.1_

  - [ ]* 8.4 Write end-to-end two-client exchange integration test
    - Two clients register, connect, claim bundles, and exchange one message; recipient renders plaintext,
      sender sees `sent`, backend relay carries ciphertext only
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7, 5.8_

  - [x]* 8.5 Write Android manifest smoke/static check
    - Assert SMS, Call Log, Accessibility Service, and `QUERY_ALL_PACKAGES` are absent
    - _Requirements: 8.4_

  - [x]* 8.6 Write shared-package consumption smoke check
    - Assert both `apps/mobile` and `apps/web` import the shared `packages/crypto` / `packages/types` modules
      for sign-in, registration, connection, encryption, and send/receive
    - _Requirements: 6.7_

  - [x]* 8.7 Write no-key-backup static check
    - Assert no key-backup or key-recovery API is exported by the client
    - _Requirements: 7.5_

- [~] 9. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation
  tasks are never optional.
- Each task references specific requirement acceptance criteria for traceability; property-test sub-tasks
  also reference the design Correctness Property number.
- Property tests use `fast-check` + `Jest`, ≥ 100 cases each, tagged
  `// Feature: phase1-client-messaging, Property {n}: ...`.
- The shared crypto core (group 2) and backend logic (group 4) are unit/property-testable without a device;
  the mobile/web integration tests (group 8) require their platform toolchains.
- Checkpoints (groups 3, 5, 9) ensure incremental validation between major build stages.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1"] },
    { "id": 1, "tasks": ["1.3", "2.2", "2.5", "2.7", "2.9", "2.14", "2.17", "2.30", "4.1"] },
    { "id": 2, "tasks": ["2.3", "2.4", "2.6", "2.8", "2.10", "2.11", "2.12", "2.13", "2.15", "2.16", "2.18", "2.19", "2.20", "2.21", "2.24", "2.31", "2.32", "2.33", "4.2", "4.5"] },
    { "id": 3, "tasks": ["2.22", "2.23", "2.25", "2.26", "2.27", "4.3", "4.4", "4.6", "4.7"] },
    { "id": 4, "tasks": ["2.28", "2.29", "4.8", "6.1", "6.2", "6.4", "6.5", "6.8", "7.1", "7.2", "7.4", "7.5"] },
    { "id": 5, "tasks": ["6.3", "6.6", "6.7", "7.3", "7.6", "7.7"] },
    { "id": 6, "tasks": ["6.9", "7.8"] },
    { "id": 7, "tasks": ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6", "8.7"] }
  ]
}
```
