# Phase 2 — Messaging Features (Design)

## Design principles (carried from Phase 1)
- **Ports & adapters.** Feature logic that is platform-agnostic lives in `@chat-app/crypto`
  and is driven by the existing injected ports (`SignalProtocolStore`, `KeyStore`,
  `MessagingRealtime`, …). Web/mobile only provide thin adapters + UI.
- **Plaintext never leaves the device.** New message kinds are carried as structured JSON
  *inside* the libsignal ciphertext body (an "E2E payload"), not as new server-readable
  fields. The server keeps relaying an opaque `CiphertextEnvelope`.
- **One render path.** New conversation state is produced by extending the shared
  `ConversationReducer`, so both clients render identically.

## E2E payload envelope (Waves 1–2)
Today `Messaging.send` encrypts a raw UTF-8 string. To carry reactions/edits/deletes/timers
without changing the wire envelope, introduce a versioned **content payload** that is what
actually gets encrypted:

```jsonc
// encrypted as the libsignal plaintext; server never sees it
{
  "v": 1,
  "type": "text" | "reaction" | "edit" | "delete" | "timer" | "attachment",
  "body": "…",            // text/edit
  "targetSeq": 42,         // reaction/edit/delete reference
  "emoji": "👍",           // reaction
  "ttlMs": 86400000,       // timer
  "attachment": { "id": "…", "key": "base64", "size": 1234, "mime": "image/jpeg" }
}
```

- Backward compatibility: a bare string (no JSON / no `v`) is treated as `{type:"text"}`.
- The reducer maps payload `type` onto render operations (append, attach-reaction,
  supersede, tombstone). Unknown `type` or unknown `targetSeq` is ignored (Req 3.5).

This keeps `CiphertextEnvelope`, the codec, and the gateway **unchanged**.

## Feature designs

### 1. Safety numbers (Req 1) — *implemented in this first PR*
Pure function in `@chat-app/crypto/safety-number.ts`:
- Per-user fingerprint = iterated SHA-512 (5200 rounds) over `version ‖ identityKey ‖
  stableId`, take 32 bytes (mirrors the Signal numeric-fingerprint construction).
- 30 displayable digits per user = six 5-byte groups, each `bigendian % 100000`, zero-padded.
- Combined safety number = the two 30-digit strings ordered deterministically (smaller
  first) and concatenated → 60 digits → grouped in 12 blocks of 5. Deterministic ordering
  is what makes both devices show the **same** number (Req 1.2).
- Inputs: local UID + local public identity key, peer UID + peer public identity key. The
  peer key is read from `SignalProtocolStore.loadIdentityKey(addr)` (TOFU-stored on first
  session); the local key from `getIdentityKeyPair().publicKey`.
- `SessionManager.getSafetyNumber(localUid, recipientUid)` exposes it; the mobile/web
  controllers surface it to a verification UI. **(UI wiring is a follow-up task.)**
- Identity-change detection (Req 1.5) reuses the store's existing `saveIdentity → changed`
  signal.

### 2. Message-gap detection (Req 2)
Reducer tracks `highestSeq` per conversation. On inbound `seq`, if `seq > highestSeq + 1`,
record a gap marker for the missing range; if a later message fills it, clear the marker.
No backend change (the seq already rides the envelope).

### 3. Reactions / edit / delete (Req 3)
Carried as E2E payloads (above). Reducer gains `reactions: Map<seq, emoji[]>`, `edited`
flag, and `deleted` tombstone per message. Send helpers added to `Messaging`.

### 4. Ephemeral / view-once (Req 4)
`timer` payload sets a per-conversation TTL; the store schedules deletion of message rows
after read+TTL, overwriting the row's plaintext before delete (best-effort secure erase).
View-once = TTL 0-on-display. Document OS-backup/screenshot limits.

### 5. Typing / presence / last-seen (Req 5)
- Presence/last-seen: add an **opt-in** flag to the user row; a new read endpoint exposes
  online/coarse-last-seen for opted-in users only, derived from `presence:{uid}`.
- Typing: a new ephemeral control frame (`{kind:"typing"}`) relayed but never persisted,
  client-rate-limited.

### 6. Push (Req 6)
Client registers an FCM token (`POST /api/devices/push-token`). `OfflineQueueService.enqueue`
additionally triggers a **content-free** data push (routing metadata only). Needs Firebase
FCM credentials + native config (mobile).

### 7. Media (Req 7)
New blob service (S3-compatible or disk) holding only ciphertext. Client encrypts with a
per-attachment key (AES-GCM), uploads ciphertext, sends the key inside the E2E payload.
TTL cleanup on the blob store.

### Wave 3 (Req 8–10)
Hidden/decoy, multi-device, and groups each require their own design doc before code; they
change the trust model (decoy storage partitioning, per-device session fanout / sender keys,
membership rekeying). Not designed here beyond the requirements.

## Sequencing rationale
Wave 1 is shippable and verifiable with pure-core tests in this repo today. Wave 2 needs
infra/native that must be provisioned and integration-tested. Wave 3 must not be coded
before design + security review, because getting key management wrong reintroduces the exact
"undecryptable message" failure class Phase 1 just fixed.
