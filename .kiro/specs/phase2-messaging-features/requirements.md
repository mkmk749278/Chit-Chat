# Phase 2 — Messaging Features (Requirements)

Phase 1 delivered a working 1:1 end-to-end encrypted messenger (phone auth, libsignal
identity/device registration, send/receive over an authenticated WebSocket with
store-and-forward, durable on-device identity). Phase 2 layers the product features that
were explicitly deferred in Phase 1.

These features are sequenced into **waves** by risk and dependency. Waves 1–2 build on the
existing 1:1 session and infrastructure. Wave 3 changes the trust model and MUST have an
approved design (and security review) before implementation.

Terminology: "E2E payload" means a structured message carried *inside* the existing
libsignal ciphertext (so the server never sees its contents); "control frame" means a
non-encrypted WebSocket frame the server may read for routing/presence.

---

## Wave 1 — pure-client, no new infrastructure

### Requirement 1: Identity verification (safety numbers)
**User story:** As a privacy-conscious user, I want to verify that I'm talking to the real
person and not a man-in-the-middle, so that I can trust the encryption.

#### Acceptance criteria
1. WHEN a session exists with a peer THEN the system SHALL derive a deterministic safety
   number from both parties' public identity keys and stable identifiers.
2. The safety number SHALL be identical on both devices regardless of which side computes it.
3. WHEN either party's identity key changes THEN the safety number SHALL change.
4. The safety number SHALL be displayed as 60 digits grouped for readability, with a
   manual-comparison UI on the Conversation screen.
5. WHEN a peer's identity key changes after first contact (TOFU) THEN the system SHALL
   surface a "safety number changed" warning and require re-verification before the chat
   is marked verified.
6. Computation SHALL be entirely client-side; no key material beyond what the session
   already holds leaves the device.

### Requirement 2: Message-gap detection
**User story:** As a user, I want to know if a message went missing, so that I'm not misled
by an incomplete conversation.

#### Acceptance criteria
1. The system SHALL track the highest received per-conversation sequence number.
2. WHEN an inbound message's sequence number skips one or more expected values THEN the
   system SHALL render a "messages may be missing" marker at the gap.
3. Out-of-order arrival within the store-and-forward window SHALL NOT produce a false gap
   once the missing sequence later arrives.
4. Gap detection SHALL operate on envelope metadata only (no plaintext inspection).

### Requirement 3: Reactions, edit, and delete
**User story:** As a user, I want to react to, edit, and delete messages, so that
conversations feel modern.

#### Acceptance criteria
1. A reaction SHALL be sent as an E2E payload referencing a target message id; the
   recipient SHALL render it against that message.
2. An edit SHALL be sent as an E2E payload that supersedes a prior message id; the UI
   SHALL show the latest text with an "edited" marker.
3. A delete SHALL be sent as an E2E tombstone for a message id; both sides SHALL replace
   the content with a "message deleted" placeholder.
4. Reaction/edit/delete payloads SHALL never expose plaintext on the wire.
5. An edit/delete referencing an unknown message id SHALL be ignored (no crash, no leak).

### Requirement 4: Ephemeral / self-destruct / view-once
**User story:** As a user, I want disappearing messages, so that sensitive content does not
persist.

#### Acceptance criteria
1. A sender SHALL be able to set a per-conversation disappearing-message timer; the timer
   SHALL ride as an E2E payload so both sides agree on it.
2. WHEN a timed message is read THEN both sender and recipient SHALL delete it from the
   on-device store after the timer elapses.
3. A view-once message SHALL be removed from the store immediately after it is first
   displayed and SHALL NOT be re-openable.
4. The system SHALL make a best-effort to prevent the deleted plaintext from being
   trivially recoverable (overwrite the store row, not just hide it), and SHALL document
   the limits (OS-level backups/screenshots are out of scope).

---

## Wave 2 — needs infrastructure / native modules

### Requirement 5: Typing, presence, and last-seen
**User story:** As a user, I want to see when a contact is online or typing, so the
conversation feels live — without being forced to broadcast my own activity.

#### Acceptance criteria
1. Presence/last-seen SHALL be **opt-in** per user; a user who opts out SHALL never have
   presence or last-seen exposed to peers.
2. WHEN a user is connected AND has opted in THEN peers SHALL be able to see an "online"
   indicator derived from the existing `presence:{uid}` registry.
3. A typing indicator SHALL be sent as an ephemeral control frame, rate-limited, and
   SHALL NOT be persisted.
4. Last-seen SHALL be coarse-grained (not exact-to-the-second) for opted-in users.

### Requirement 6: Push notifications (FCM)
**User story:** As a user, I want to be notified of new messages when the app is closed.

#### Acceptance criteria
1. The client SHALL register an FCM token with the backend, scoped to the device.
2. WHEN an envelope is enqueued for an offline recipient THEN the backend SHALL send a
   **content-free** push (no message text, no sender plaintext) to wake the device.
3. The notification payload SHALL contain only routing metadata sufficient to fetch and
   decrypt locally; plaintext SHALL never traverse FCM.
4. A user SHALL be able to disable push; revoking the token SHALL stop pushes.

### Requirement 7: Media / attachments
**User story:** As a user, I want to send photos and files end-to-end encrypted.

#### Acceptance criteria
1. Attachments SHALL be encrypted client-side with a per-attachment key before upload to
   the blob store; the server SHALL only ever hold ciphertext.
2. The per-attachment key SHALL be delivered to the recipient inside the E2E message
   payload, never to the blob store.
3. Uploads/downloads SHALL be size-bounded and resumable-or-retryable; failures SHALL be
   surfaced without losing the message.
4. The blob store SHALL enforce TTL/cleanup so undelivered ciphertext does not persist
   indefinitely.

---

## Wave 3 — trust-model changes (design + security review REQUIRED first)

### Requirement 8: Hidden chats, shadow chat, decoy PIN
**User story:** As an at-risk user, I want plausible-deniability features.

#### Acceptance criteria
1. A decoy PIN SHALL open a separate, innocuous app state that never reveals the existence
   of hidden chats.
2. Hidden chats SHALL be excluded from the default chat list, notifications, and previews.
3. The presence/absence of hidden content SHALL NOT be detectable from storage size or
   metadata available without the real PIN (documented threat model).

### Requirement 9: Multi-device sync
**User story:** As a user, I want my chats on more than one device.

#### Acceptance criteria
1. The single-device model and the backend "newest device" prekey-claim heuristic SHALL be
   replaced by an explicit multi-device model with per-device sessions.
2. Adding a device SHALL be authenticated by the existing device(s); session/identity
   material SHALL be transferred without exposing private keys to the server.
3. A message SHALL be delivered to and decryptable by all of a user's active devices.
4. Removing a device SHALL revoke its ability to decrypt future messages.

### Requirement 10: Group chat
**User story:** As a user, I want encrypted group conversations.

#### Acceptance criteria
1. Group messaging SHALL be end-to-end encrypted (sender-keys or pairwise fanout — chosen
   in design), with the server never seeing plaintext.
2. Membership changes (add/remove) SHALL rekey appropriately so removed members cannot
   read future messages.
3. Group state SHALL be consistent across members under concurrent membership changes
   (conflict resolution defined in design).

---

## Cross-cutting requirements
- **C1 (no plaintext on the wire):** every feature above SHALL preserve the Phase 1
  invariant that the server never receives message plaintext (Requirement 5.7/8.2 carried
  forward).
- **C2 (shared core):** feature logic SHALL live in `@chat-app/crypto` where platform-
  agnostic, so web and mobile render through one path (Requirement 6.7 carried forward).
- **C3 (verifiable):** each feature SHALL ship with pure-core unit/property tests; features
  requiring infra SHALL additionally have an integration test before being marked done.
