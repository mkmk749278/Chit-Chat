# Phase 2 — Implementation Plan (Tasks)

One PR per task where practical. `[x]` done, `[~]` in progress, `[ ]` not started.
Effort: S (<1 day) · M (1–3 days) · L (~1 week) · XL (multi-week).

## Wave 1 — pure-client, no infra (ship first)

### 1. Identity verification (safety numbers) — Req 1
- [x] 1.1 (S) `@chat-app/crypto/safety-number.ts` — pure deterministic 60-digit generator + unit tests.
- [x] 1.2 (S) `SessionManager.getSafetyNumber(localUid, recipientUid)` (reads peer key via `loadIdentityKey`, local via `getIdentityKeyPair`) + unit tests (symmetry, key-change, null-before-session). **(this PR)**
- [x] 1.3 (S) `ChatController.getSafetyNumber(uid)` on mobile. **(this PR)** *(web still on demo controller)*
- [~] 1.4 (M) Verification UI on the mobile Conversation screen (show grouped 60 digits, manual compare). **(this PR)** Remaining: "safety number changed" warning + persisted verified flag (Req 1.5).

### 2. Message-gap detection — Req 2
- [x] 2.1 (S) Extend `ConversationReducer` to track `missingBefore` gap markers; derived from the inbound-seq set so it's order-independent and clears on backfill. **(this PR)**
- [~] 2.2 (S) Render the gap marker in the mobile Conversation screen ("messages may be missing" divider). **(this PR)** *(web follow-up)*
- [x] 2.3 (S) Tests: skipped-seq gap, backfill clears, shuffled arrival never false-positives, mid-stream join, delivery-error counts as present, duplicates. **(this PR)**

### 3. Reactions / edit / delete — Req 3
- [x] 3.1 (M) Versioned **content payload** codec (`content-payload.ts`): encode/decode, bare-string back-compat, forward-compat `unsupported`, total decode. **(this PR)**
- [x] 3.2 (M) Wire the payload through `Messaging` (encode on send incl. plain text; decode on receive → dispatch reducer events) + `react/editMessage/deleteMessage` helpers + sender-relative→local target flip. **(this PR)**
- [x] 3.3 (M) Reducer: reactions list, edited marker, delete tombstone; unknown target ignored; deleted rejects later edits/reactions. **(this PR)**
- [~] 3.4 (S) UI affordances (long-press → react/edit/delete) on mobile: action sheet, reaction chips, "edited" tag, "message deleted" tombstone. **(this PR)** *(web follow-up)*
- [x] 3.5 (S) Tests: payload round-trip/back-compat/forward-compat/malformed; reducer apply + ignore-unknown. **(this PR)**

### 4. Ephemeral / self-destruct / view-once — Req 4
- [x] 4.1a (S) `timer` content-payload variant + pure expiry math (`disappearing-timer.ts`: `computeExpiresAt`/`selectExpired`/`msUntilNextExpiry`, view-once supported). **(this PR)**
- [x] 4.1b (M) Per-conversation TTL state in the reducer (`disappearingTtlMs` + `timer-changed`) and propagation through `Messaging.setDisappearingTimer` / inbound `timer` payloads, so both peers converge on the timer. **(this PR)**
- [~] 4.1c (S) Mobile UI: disappearing-timer picker (Off/30s/5m/1h/1d/1w) in the conversation header + active-timer banner. **(this PR)**
- [x] 4.2 (M) Store-side scheduled deletion with plaintext overwrite (best-effort secure erase). **(this PR)** `Messaging` stamps `MessageRow.expiresAt` from the conversation timer (send time for the sender, receive time for the recipient), runs a single-timer purge engine (over the pure `disappearing-timer` helpers) that erases expired rows via `KeyStore.purgeMessages` (plaintext overwrite + row drop) and emits a `messages-expired` reducer event; the schedule is re-armed from persisted rows on construction, and the controller skips already-expired rows on rehydration + primes timers via `Messaging.primeConversationTtl`. OS-level backups remain out of scope.
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
- [~] CC2 (S) One-time prekey replenishment. **Backend `POST /api/devices/prekeys` append endpoint + `DevicesService.addOneTimePreKeys` done (this PR).** Remaining: client trigger (detect low count, allocate fresh ids, upload) wired into the mobile bootstrap.
- [ ] CC3 (S) Reconcile spec vs impl: mobile uses an AES-CBC+HMAC vault, not SQLCipher as Phase 1 design states — update the design or migrate.
- [x] CC4 (M) Rehydrate persisted message history into the UI on relaunch. `KeyStore.loadMessages()` (mobile persistent + in-memory + web stores) → `ChatController.loadConversations()` replays rows through the shared reducer → `App.tsx` merges them on setup-ready, so chats survive an app restart. **Faithful rehydration:** reactions / edits / delete-tombstones / per-conversation disappearing timer are now persisted (`KeyStore.applyReaction/applyEdit/applyDelete/setConversationTimer` + `loadConversationTimers`, written by `Messaging` on both the optimistic and inbound paths) and replayed on load, so they survive relaunch too.
