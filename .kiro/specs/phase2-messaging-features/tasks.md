# Phase 2 — Implementation Plan (Tasks)

One PR per task where practical. `[x]` done, `[~]` in progress, `[ ]` not started.
Effort: S (<1 day) · M (1–3 days) · L (~1 week) · XL (multi-week).

## Wave 1 — pure-client, no infra (ship first)

### 1. Identity verification (safety numbers) — Req 1
- [x] 1.1 (S) `@chat-app/crypto/safety-number.ts` — pure deterministic 60-digit generator + unit tests. **(this PR)**
- [ ] 1.2 (S) Export `getSafetyNumber(localUid, recipientUid)` from `SessionManager` (reads peer key via `loadIdentityKey`, local via `getIdentityKeyPair`).
- [ ] 1.3 (S) `ChatController.getSafetyNumber(uid)` on mobile + web.
- [ ] 1.4 (M) Verification UI on the Conversation screen (show number, mark verified, "safety number changed" warning on identity change — Req 1.5).

### 2. Message-gap detection — Req 2
- [ ] 2.1 (S) Extend `ConversationReducer` to track `highestSeq` + gap markers; clear on backfill.
- [ ] 2.2 (S) Render the gap marker in mobile + web Conversation screens.
- [ ] 2.3 (S) Property test: random arrival orders never produce a false gap once complete.

### 3. Reactions / edit / delete — Req 3
- [ ] 3.1 (M) Introduce the versioned **content payload** in `Messaging` (encode/decode; bare-string back-compat). Migrate `text` through it.
- [ ] 3.2 (S) `Messaging.react/edit/delete` send helpers (E2E payloads).
- [ ] 3.3 (M) Reducer: reactions map, edited marker, delete tombstone; ignore unknown `targetSeq`.
- [ ] 3.4 (S) UI affordances (long-press → react/edit/delete) on both clients.
- [ ] 3.5 (S) Tests: payload round-trip, no plaintext on wire, unknown-target ignored.

### 4. Ephemeral / self-destruct / view-once — Req 4
- [ ] 4.1 (M) `timer` payload + per-conversation TTL state in the reducer/store.
- [ ] 4.2 (M) Store-side scheduled deletion with plaintext overwrite (best-effort secure erase).
- [ ] 4.3 (S) View-once (delete-on-display) + UI; document OS-backup/screenshot limits.

## Wave 2 — needs infra / native

### 5. Typing / presence / last-seen — Req 5
- [ ] 5.1 (S) Opt-in presence flag on the user row + migration.
- [ ] 5.2 (M) Read endpoint exposing online/coarse last-seen for opted-in users (from `presence:{uid}`).
- [ ] 5.3 (M) Ephemeral `typing` control frame (relayed, never persisted) + client rate-limit + UI.

### 6. Push notifications (FCM) — Req 6
- [ ] 6.1 (M) `POST /api/devices/push-token`; store token per device.
- [ ] 6.2 (M) Content-free data push from `OfflineQueueService.enqueue` (routing metadata only).
- [ ] 6.3 (M) Mobile FCM integration + native config; disable/revoke flow. *(needs FCM creds)*

### 7. Media / attachments — Req 7
- [ ] 7.1 (L) Blob service (ciphertext-only) + TTL cleanup.
- [ ] 7.2 (M) Client-side per-attachment AES-GCM encrypt/decrypt; key in E2E payload.
- [ ] 7.3 (M) Upload/download with size bounds + retry; UI.

## Wave 3 — trust-model changes (DESIGN + SECURITY REVIEW REQUIRED before code)

### 8. Hidden chats / shadow chat / decoy PIN — Req 8
- [ ] 8.0 (M) Design doc + threat model.
- [ ] 8.1 (L) Decoy-PIN app state + hidden-chat partitioning.

### 9. Multi-device sync — Req 9
- [ ] 9.0 (L) Design doc: per-device sessions, device-authenticated linking, retire the "newest device" claim hack + stale-row cleanup.
- [ ] 9.1 (XL) Implementation across crypto core + backend + clients.

### 10. Group chat — Req 10
- [ ] 10.0 (L) Design doc: sender-keys vs pairwise fanout, membership rekeying, consistency.
- [ ] 10.1 (XL) Implementation.

## Cross-cutting / tech-debt (fold in as we go)
- [ ] CC1 (M) Two-client E2E integration test harness (would have caught the Phase 1 decryption bug). Prereq for marking any Wave 2+ feature done.
- [ ] CC2 (S) One-time prekey replenishment job (today: never replenished; falls back to signed-prekey-only when exhausted).
- [ ] CC3 (S) Reconcile spec vs impl: mobile uses an AES-CBC+HMAC vault, not SQLCipher as Phase 1 design states — update the design or migrate.
- [ ] CC4 (M) Rehydrate persisted message history into the UI on relaunch (vault stores it; UI starts empty today).
