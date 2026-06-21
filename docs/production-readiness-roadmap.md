# Chit-Chat — Production-Readiness Roadmap

> Companion to `docs/roadmap.md`. That doc tracks the **feature spec** (what's built per the
> requirements). **This** doc is an engineering audit of what stands between the current build and a
> "production messaging app" people can rely on day-to-day — grounded in the code, with file
> references, severity, and rough effort. It was written after a round of field testing surfaced two
> recurring complaints: **"no way to clear shadow chats"** and **"no offline delivery."**
>
> Severity: **P0** = blocks real use / data-loss / security · **P1** = expected of any messenger ·
> **P2** = polish / parity. Effort: **S** ≤1d · **M** ~2–4d · **L** ~1–2wk · **XL** >2wk.
> Status: ✅ done · 🟡 partial · ⬜ not started.

---

## TL;DR — the short list

| # | Gap | Sev | Effort | Status |
|---|-----|-----|--------|--------|
| 1 | Offline push delivery (FCM) end-to-end | P0 | L | ⬜ |
| 2 | Shadow chat UX (invite model is invisible/asymmetric) | P0 | M | 🟡 |
| 3 | Attachments / media (send + receive) | P0 | L | 🟡 |
| 4 | Signed-prekey signature verification is a stub | P0 | S | ✅ |
| 5 | Connection reliability + offline UX (the "Connecting…" problem) | P1 | M | 🟡 |
| 6 | In-app / foreground new-message notifications | P1 | M | ⬜ |
| 7 | Contact/profile polish (avatars, names on shadow headers) | P2 | M | 🟡 |
| 8 | Calls (audio/video) | P2 | XL | ⬜ |
| 9 | Group chats | P2 | XL | ⬜ |

---

## P0 — blocks real use

### 1. Offline push delivery (FCM) is not implemented end-to-end
**Symptom:** "no offline delivery." A recipient whose app is closed gets nothing — no notification,
no message — until they manually reopen the app, which reconnects the WebSocket and drains the queue.

**Evidence (the pipeline is wired but the ends are stubbed):**
- Backend store-and-forward works: `MessageRelayService.relay` enqueues for an offline recipient
  (`apps/backend/src/messaging/message-relay.service.ts`), and `OfflineQueueService.enqueue` even
  fires a content-free wake push (`apps/backend/src/messaging/offline-queue.service.ts:71`).
- **But the push transport is a no-op:** `NoopPushSender` "logs the count and sends nothing … until
  the FCM binding is configured (task 6.3)" (`apps/backend/src/messaging/push-sender.ts`).
- **And the mobile app has no FCM:** deps include `@react-native-firebase/app` + `/auth` but **not
  `/messaging`** (`apps/mobile/package.json`); `setPushToken` is **never called** from the client;
  there is no background/data-message handler.

**What's needed:**
1. Mobile: add `@react-native-firebase/messaging`, request notification permission, fetch the FCM
   token, and call the existing `PATCH` push-token endpoint (`devices.service.ts` `setPushToken`).
2. Mobile: register a background/data-message handler that wakes the WS client to drain the queue
   (content-free push → connect → fetch+decrypt locally, per Req 6.2/6.3).
3. Backend: implement an `FcmPushSender` (FCM HTTP v1, service-account creds) and swap it for
   `NoopPushSender` in `messaging.module.ts`.
4. Token lifecycle: refresh on rotation, clear on sign-out.

**Effort:** L. **Needs:** FCM service-account credentials + APNs (if iOS later). **Note:** queue TTL
is bounded (`QUEUE_TTL_SECONDS`) and capped at `MAX_QUEUED_MESSAGES`, so very old/offline messages
can still be dropped — acceptable, but document it.

### 2. Shadow chat UX — the invite model is invisible and asymmetric
**Symptom:** "still no way to clear shadow chats." Field repro: long-press a contact → **"Shadow
chat"** shows an "Invitation sent" alert and then *nothing visibly happens*. The chat you land in is
the **surface** chat (its menu shows "Clear chat", not "Clear shadow chat"). The Settings → "Shadow
chats" manager (shipped in PR #92) lists only **active** threads, so if the peer hasn't accepted —
or you're testing on one device — it's empty → "nothing to clear."

**Root cause:** shadow chats are **consent/invite-based** and only become active after the peer
Accepts (`onCreateShadowChat` → `createShadowInvite`; `ShadowInviteCoordinator`). There is no
pending-invite state in the UI, no discoverable hub, and the only ways back to a thread are auto-open
on `invite-accepted` or typing its `/alias`. This is a product gap, not a single bug.

**What's needed:**
- A single **"Shadow chats" hub** (Settings entry already exists) that lists **pending (awaiting
  accept), active, and incoming** threads, each with the right action: cancel invite / open / clear /
  revoke. Surface pending invites on the inviter side instead of a fire-and-forget alert.
- Clearer creation flow + status feedback ("Waiting for Kumar to accept…").
- Decide whether to also offer a **local-only shadow thread** (no remote accept) for the common
  "I just want a hidden chat on my device" case — a product decision worth making explicitly.
- Cosmetic: resolve the peer **name** for shadow headers (some paths still show the raw thread-id/UID).

**Effort:** M. **Already shipped (PRs #91/#92):** relaunch persistence, leak prevention, in-conversation
Clear/Revoke, and the Settings manager — this item is the UX layer on top.

### 3. Attachments / media don't work
**Symptom:** can't send/receive images, files, or voice notes.

**Evidence:** the crypto + payload exist, but **inbound attachments are ignored** —
`messaging.ts` returns early on `case 'attachment'` ("download + decrypt + render wiring lands with
the media UI, task 7.3", `packages/crypto/src/messaging.ts:~833`). No composer attach button, no
blob upload/download client, no media renderer. Backend blob service + per-attachment AES-GCM are
ready (per `docs/roadmap.md` Req 7.1/7.2).

**What's needed:** composer attach/camera/mic UI → encrypt → upload to blob → send `attachment`
payload; inbound: fetch → decrypt → render (image/file/voice); thumbnails + progress + view-once
media variant (signature feature 6).

**Effort:** L.

### 4. Signed-prekey signature verification is a stub — ✅ DONE
**Was:** `verifySignedPreKeySignature` in `packages/crypto/src/index.ts` was a Phase-0 stub that
returned `true` for any structurally-valid input — a real integrity gap on the device-registration
path.

**Now:** `verifySignedPreKeySignature` performs real **Curve25519 / XEdDSA** verification, delegating
to the same pure-TS libsignal implementation (`@privacyresearch/libsignal-protocol-typescript`) the
clients use to *produce* the signature, so a signed prekey that verifies server-side is exactly one a
peer would accept — and no native addon is pulled into the web/mobile bundles. The function is now
async (the curve init loads a WASM module); `SignedPreKeyVerificationPipe` awaits it, still rejecting
a bad signature with HTTP 400 **before** any database access (Req 2.9). It short-circuits to `false`
on structurally impossible input (non-DJB key length, non-64-byte signature) and treats any
curve-internal error as a verification failure rather than a 500.

> ⚠️ Polarity note for maintainers: the underlying sync curve returns `0`/`false` for a **valid**
> signature (inverted C convention), so the result is **negated** in `index.ts`. Round-trip tests in
> `index.test.ts` (genuine sig → `true`; tampered sig / wrong identity key / tampered prekey → `false`)
> lock this in — do not "simplify" away the negation.

**Effort:** S. **Sev P0** because it's security-load-bearing.

---

## P1 — expected of any messenger

### 5. Connection reliability + offline UX
Field screenshots show long "Connecting…" headers. The realtime client has backoff
(`realtime-client.ts`) and the orchestrator queues sends for flush-on-reconnect, but the UI lacks:
an offline/connecting banner, a clear "will send when online" affordance on queued messages, and a
manual retry on failed sends. **Effort:** M.

### 6. In-app / foreground notifications
Even with FCM (#1), there's no local notification when a message arrives while the app is
backgrounded-but-connected, and no unread badges on the chat list beyond the last-message preview.
**Effort:** M (depends on #1 for the OS-notification surface).

---

## P2 — polish / parity

### 7. Profile & contact polish
Initials-only avatars (no profile photos); shadow headers sometimes show raw UID/thread-id; no
message search, reply/quote, forward, or link previews. **Effort:** M (per item).

### 8. Calls (audio/video)
`CallsScreen` is an honest placeholder; no signaling/WebRTC. **Effort:** XL (Wave 3).

### 9. Group chats
1:1 only today; sender-keys/group ratchet + fan-out is a large design + security effort
(`docs/roadmap.md` Wave 3). **Effort:** XL.

---

## Cross-cutting hardening (tracked in `docs/roadmap.md` §10, summarized here)
- `FLAG_SECURE` app-wide, SQLCipher vs the current AES-CBC+HMAC vault (CC3), certificate pinning,
  root/tamper detection, linked-device management.
- One-time prekey replenishment client trigger (CC2 — backend done).
- A two-client E2E integration harness (CC1) so delivery regressions like the shadow-chat ones are
  caught before a build ships.

---

## Recommended delivery order
1. ~~**#4 prekey verification** (S, security) — fast and load-bearing.~~ ✅ **DONE.**
2. **#1 offline push (FCM)** (L) — the single biggest "feels like a real app" win.
3. **#2 shadow chat UX** (M) — closes the recurring complaint loop.
4. **#3 attachments** (L) — table-stakes media.
5. **#5/#6 connection + notification UX** (M) — reliability polish.
6. Then Wave-3 XL: calls, groups, multi-device.
