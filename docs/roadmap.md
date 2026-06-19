# Chit-Chat — Product Roadmap

A living map of what the app is and what remains, organised by the product's feature set
(`private-chat-app-requirements.md`). Status reflects the codebase, not aspiration.

Legend: ✅ done · 🟡 partial · ⬜ not started

## Foundations (Phases 0–1) — ✅

- ✅ **Phase 0** — monorepo, NestJS backend, Postgres/TypeORM + Redis, Firebase auth, WebSocket
  gateway, health/observability, CI/CD (`.kiro/specs/phase0-foundation`).
- ✅ **Phase 1** — full client E2E messaging: libsignal identity/prekeys/sessions, device
  registration, realtime client, send/receive with acks + offline queue, shared conversation
  reducer (`.kiro/specs/phase1-client-messaging`).

## Phase 2 — messaging features

- ✅ Safety numbers (Req 1), message-gap detection (Req 2), reactions/edit/delete (Req 3),
  disappearing / self-destruct / view-once (Req 4) — **mobile**.
- ✅ Typing / presence / last-seen (Req 5), push-notification backend (Req 6.1/6.2), blob service +
  per-attachment crypto (Req 7.1/7.2).
- 🟡 Media attachments (Req 7.3 upload/download UI) — crypto + blob store ready; client UI pending.
- ⬜ Mobile FCM integration (Req 6.3) — *needs FCM credentials*; backend is ready behind a port swap.

## Seven signature features

| # | Feature | Requirement | Status |
|---|---------|-------------|--------|
| 1 | Per-chat hidden chats (per-chat secrets, search-bar entry) | §3 | ⬜ planned (PR: hidden chats + decoy PIN) |
| 2 | In-chat identity verification (rotating TOTP + duress) | §4 | ✅ crypto core + E2E + mobile UI (`docs/signature-feature-2-identity-verification.md`); 🟡 persistent seed + duress-UX hardening follow-ups |
| 3 | Ephemeral secret conversation segments | §5 | 🟡 disappearing/view-once shipped; in-memory `/Start secret conversation` segment model planned |
| 4 | Decoy PIN / duress app state | §6 | ⬜ planned (PR: hidden chats + decoy PIN) |
| 5 | Self-destructing messages (timer-based) | §7 | ✅ client TTL + store purge (Req 4); ⬜ server-side BullMQ TTL index follow-up |
| 6 | View-once media | §8 | 🟡 view-once text shipped; media variant rides on Req 7.3 |
| 7 | Dual-layer shadow chat with `/alias` command | §9 | ⬜ planned (PR: shadow chat) |

## Additional security infrastructure (§10)

- ✅ Safety numbers (§10.5). 🟡 Identity verification TOTP (§4 / overlaps §10.7 2FA primitive).
- ⬜ FLAG_SECURE app-wide (§10.1), SQLCipher migration vs current AES-CBC+HMAC vault (§10.2 / CC3),
  certificate pinning (§10.3), root/tamper detection (§10.4), linked-device management (§10.6),
  2FA for sensitive actions (§10.7).

## Table-stakes (§11)

- ✅ Firebase phone auth, 1:1 text. 🟡 contacts/discovery (resolve by phone). ⬜ media kinds (images/
  video/audio/voice notes, on Req 7.3), blocking, **group messaging** (§11 / Wave 3).

## Wave 3 — trust-model changes (design + security review gated)

- ⬜ Hidden chats / decoy PIN (§3, §6) — design doc + impl.
- ⬜ Multi-device sync (§9-multidevice) — design doc + impl (XL).
- ⬜ Group chat up to 256 (§11) — design doc + impl (XL).

## Cross-cutting / tech-debt

- ⬜ CC1 two-client E2E integration harness (partially covered by per-feature e2e tests in
  `packages/crypto`).
- 🟡 CC2 one-time prekey replenishment (backend done; client trigger pending).
- ⬜ CC3 reconcile SQLCipher (design) vs AES-CBC+HMAC vault (impl).
- ✅ CC4 rehydrate persisted history on relaunch.

## Delivery order (current plan)

1. ✅ **Signature Feature 2 — identity verification** (this PR).
2. **Hidden chats + decoy PIN** (Features 1 & 4) — app-lock / state-partition layer.
3. **Shadow chat `/alias`** (Feature 7) — dual-layer per-contact secret threads.
4. Media UI (Req 7.3), web feature parity (after Android), then Wave-3 XL features.
