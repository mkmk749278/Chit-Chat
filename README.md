# Private Chat Application — Product & Technical Requirements

**Status:** v0.1 Draft (for review) · **Prepared as:** consolidation of stated ideas, not yet validated against a build
**Audience:** Owner / build team · **Author role:** operator & security auditor

> This document captures what has been discussed so far and fills the gaps with reasonable engineering defaults. Every default is labelled as an **Assumption** so you can confirm or override it. Nothing here is implemented yet.

---

## 1. Product summary

A privacy-focused, cross-platform chat application (mobile app + web) in the WhatsApp / Telegram category, self-hosted on a VPS backend under a purchased domain. The product is differentiated by **three signature features** that go beyond the incumbents:

1. **Per-chat hidden chats with per-chat secrets** — each concealed conversation has its own independent unlock trigger, rather than one unified locked-chats folder (which is what WhatsApp ships today).
2. **In-chat identity verification ("who is typing")** — a challenge/response that confirms the *human at the keyboard* is the real account owner, not just that the channel is encrypted.
3. **Ephemeral "secret conversation" segments** — inside an otherwise-visible chat, a hidden inline command starts a stretch of messages that self-erase on app exit/lock and revert to normal afterwards.

Everything else (accounts, contacts, 1:1 and group messaging, media, encryption, sync) is table-stakes that must also be built — see §6.

---

## 2. Assumptions & decisions made

These are decisions I've taken on your behalf so the document is concrete. Confirm or override.

| # | Assumption | Why | If wrong |
|---|-----------|-----|----------|
| A1 | This is a **real product** intended for other users, not a single private deployment for two people. | You used "we/our," and plan a domain, VPS, app + web. | If it's only for you and one friend, most of §10 (compliance, store review) drops away and the build shrinks dramatically. |
| A2 | **End-to-end encryption (E2E) is a hard requirement.** | The whole premise is privacy/secrecy. | If you accept server-readable messages, the build is far simpler but the privacy claim is hollow. |
| A3 | Targets are **Android, iOS, and web.** | "App and web page too." | Drop iOS and you avoid Apple review entirely (big simplification). |
| A4 | **Small team / modest budget**, single VPS to start. | Stated infra plan. | Affects scaling and high-availability decisions only. |
| A5 | Primary launch jurisdiction is **India** (compliance notes in §10 assume this). | Inferred. | Confirm; changes the legal section. |

---

## 3. Signature Feature 1 — Per-chat hidden chats

### 3.1 Behaviour
- Any chat can be marked **hidden**. Each hidden chat gets its **own unlock secret** (a word, number, phrase, or emoji), stored only as a salted hash — never plaintext.
- Hidden chats do **not** appear in the chat list. Typing a chat's secret in the search bar reveals **only that one chat**.
- Auto-rehide on: app backgrounded, configurable inactivity timeout, or manual lock.
- Differentiator vs WhatsApp: WhatsApp's secret code is *unified* — one code reveals the whole locked-chats folder. Per-chat secrets give compartmentalisation (a leaked secret exposes one chat, not all).

### 3.2 The real work — "leak surfaces" (the lock is the easy 10%)
A hidden chat does not leak through the lock; it leaks through everything around it. Each of these **must** be handled per hidden chat, and each is something the incumbents already had to solve:

- **Notifications** — no sender name or preview; route hidden-chat pushes as **silent/data-only** and fetch content in-app *after* unlock. A lock-screen preview defeats the entire feature.
- **Backups** — device and cloud backups are the #1 way "hidden" content is exposed. Hidden chats need separate, encrypted backup handling or exclusion from backup entirely.
- **Media auto-save** — hidden-chat media must never write to the device photo gallery.
- **Global search** — hidden-chat content and contact names must be excluded from in-app search results.
- **Contact presence** — decide explicitly: does the contact still appear in your contact list / call log / "last seen"? Hiding the thread does **not** hide the *relationship* (see Risk R7).

### 3.3 Open design decisions
- **Forgotten-secret recovery policy.** Any recovery path weakens security; no recovery path means permanent data loss. WhatsApp's choice is brutal (forgotten code wipes locked chats). Pick deliberately.
- Per-chat secret entry surface (search bar vs long-press vs dialer-style) and rate-limiting against guessing.

---

## 4. Signature Feature 2 — In-chat identity verification ("who is typing")

### 4.1 The gap this addresses (it's a real one)
E2E encryption verifies the **channel and device keys** — it does **not** verify the **human typing**. Anyone holding an unlocked device can message as the owner, and E2E will faithfully encrypt the impostor's words. Verifying *who is actually typing* is a genuine, under-served problem. Good instinct.

### 4.2 Recommendation: do NOT use a static code
A fixed code (e.g. "81") is the weakest possible implementation:
- **Replayable / single-observation leak** — if the other party (or anyone) sees the "who is this? → 81" exchange once, the code is permanently compromised and impersonation becomes perfect.
- **False positives** (a typo flags the real owner as fake) and **false negatives** (the code is guessed or learned).

### 4.3 Stronger designs (pick one or combine)
- **Rotating / time-based code (TOTP-style):** both ends share a seed; the valid answer changes every interval. Cannot be replayed.
- **Duress code:** a *second* valid-looking answer that silently signals "this isn't really me / I'm being watched." This is the sophisticated form of your idea and is genuinely useful.
- **Shared-private-context challenge:** a question only the real person can answer.

### 4.4 The actual feature is the *response*, not the code
Define precisely what the system does on pass/fail:
- **Pass** → visible "verified" badge for that message/session.
- **Fail** → unverified badge, block sending, or send a **silent alert** to the other side.
- Decide **per-message** vs **per-session** verification (per-message is more secure, higher friction).

### 4.5 Branding honesty
Safe-words, duress codes, and 2FA-style continuity are established prior art. What's reasonably fresh is packaging *continuous, in-chat human-identity verification* as a consumer feature. Frame it that way; avoid "brand new / patentable" claims without a patent search.

---

## 5. Signature Feature 3 — Ephemeral "secret conversation" segments

### 5.1 Behaviour
- A normal, fully visible chat. Inside it, a user types `/Start secret conversation` to begin an **ephemeral segment**; `/Default` ends it and reverts to normal.
- Messages sent during the segment **erase automatically** on app exit, backgrounding, or lockscreen — and on `/Default`.
- `/Start secret conversation` and `/Default` are **control commands**: parsed and consumed, never rendered as visible messages.
- The erase trigger fires **per device, independently** — each side's copy clears on that side's own exit/lock event.

### 5.2 Critical caveat — ephemerality is a UX promise, not a security guarantee
This is the single most important expectation to set:
- You **cannot** truly force-delete a message on a device you don't control. Screenshots, screen recording, or a second phone photographing the screen all defeat it (Snapchat never solved this).
- So this protects against *casual later discovery* (someone scrolling your history), **not** a determined counterparty in the moment. Market it as the former; over-promising is an ethical and legal exposure.

### 5.3 The architecture that actually works — *ephemeral by construction*, not delete-on-exit
The naive build — "store messages normally, delete them in the on-exit handler" — **will leak constantly**, because lifecycle callbacks are **not guaranteed to fire**: the OS kills the app, it crashes, the battery dies, or the user force-stops it. In every one of those cases the delete hook never runs and the "secret" messages survive.

Correct approach:
- Segment messages live in **volatile storage only** — in memory, or written to disk **encrypted under a session key held only in RAM**. When the process dies or the screen locks, the key is gone and the data is unreadable *whether or not* any cleanup code ran.
- The on-exit/on-lock handler is a best-effort *fast path*, never the thing you rely on.

### 5.4 Shared vs local — the decision that gives the feature meaning
"Both sides individually works" needs pinning down, because the obvious local-only reading breaks the feature:
- If side A enters secret mode locally but the message lands on side B's device as a **normal, retained** message, "secret" is meaningless — the recipient keeps a permanent copy.
- So each secret message **must carry an "ephemeral" flag** so the *recipient's* app also treats it as ephemeral and erases it on B's own exit/lock. The flag (shared) is what makes it secret; the *erase trigger* (per-device) is what's independent. **Assumption A6:** this is the intended model.
- Consequence: the commands can't be *purely* local — the protocol must transmit the ephemeral flag even though the command text is never displayed.

### 5.5 Other leak surfaces (same family as §3.2)
- **Notifications:** silent/data-only pushes only; never appear in notification history.
- **Backups:** segment messages must never be written to any backup.
- **Server:** with E2E, the server holds ciphertext only transiently for delivery and purges immediately; ephemeral messages never enter server-side history.
- **Multi-device sync (app + web):** an erase on one device must propagate, or the device that didn't lock retains the segment.
- **Command escaping / edge cases:** decide how a user literally types "/Start secret conversation" as real text (e.g. an escape prefix), and what happens to an in-flight message when `/Default` or a lock interrupts mid-segment.

---

## 6. Table-stakes features (must build, not differentiators)
- Account creation + auth (phone/email + OTP), multi-device.
- Contacts / discovery, blocking.
- 1:1 and group messaging; text, media, voice notes, files.
- **E2E encryption** for all messages (see §7 — use a vetted library).
- Delivery/read state, typing indicators, presence (privacy-toggleable).
- Message history sync across app + web (E2E sync is non-trivial).
- Push notifications (with the silent-push handling from §3.2).
- Account/data export and deletion.

---

## 7. Architecture & technology stack (recommended)

> Decisions taken for you; rationale and alternatives noted.

| Layer | Recommendation | Rationale | Alternative |
|------|----------------|-----------|-------------|
| **E2E encryption** | **libsignal (Signal Protocol)** | **Do not invent crypto** — the #1 fatal mistake in messaging apps. Use a battle-tested library. | Matrix/Olm-Megolm |
| Backend | Node.js + NestJS, WebSocket (raw `ws` or Socket.IO) | Fast to build, strong real-time ecosystem, shares TypeScript with web. | Go (better raw performance) |
| Realtime transport | WebSocket, persistent connections | Standard for chat. | — |
| Database | PostgreSQL (durable: users, devices, contacts, ciphertext blobs, hidden-chat config) + Redis (presence, pub/sub fan-out, rate-limits) | Proven, cheap on a VPS. Server stores **ciphertext only**. | — |
| Mobile | **React Native (Expo)** | One codebase iOS+Android; shares TS core/crypto with web. | Flutter (single codebase incl. web, but rougher web UX) |
| Web | **Next.js (React)**, sharing a TypeScript domain/crypto core with mobile | Best-in-class web; logic reuse. | Flutter web |
| Push | FCM (Android) + APNs (iOS), **silent/data-only** for hidden chats | Required for delivery; content fetched in-app post-unlock. | — |
| Edge / TLS | **Caddy** (automatic HTTPS) on the VPS, reverse-proxying the app | Auto Let's Encrypt certs, minimal config. | Nginx + Certbot |

### 7.1 VPS & domain
- **Domain:** any registrar; point an A/AAAA record at the VPS, plus subdomains (`api.`, `app.`, `ws.`).
- **VPS sizing (starting point):** 2 vCPU / 4 GB RAM / 80 GB SSD for low user counts. Re-evaluate once concurrent WebSocket connections grow.
- **Single VPS = single point of failure** (see Risk R5). Plan automated off-box backups from day one.

---

## 8. Risk register (operator/auditor view)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|-----------|
| R1 | **Rolling your own encryption** | Med | **Critical** | Use libsignal/Matrix. Never hand-roll crypto. Get a security review before launch. |
| R2 | **Backup leakage** exposes "hidden" chats | High | High | Separate encrypted backups or exclude hidden chats from backup; document the trade-off. |
| R3 | **Notification/push content leakage** (lock screen, or via FCM/APNs servers) | High | High | Silent/data-only pushes for hidden chats; fetch + decrypt in-app after unlock. |
| R4 | **Metadata is not protected by E2E** — who talks to whom, when, how often | High | High | Minimise/expire metadata; be honest that content ≠ relationship privacy (R7). |
| R5 | **Single VPS** — no HA, one compromise/disk failure loses everything | Med | High | Automated encrypted off-box backups; documented restore drill; plan a 2-node path. |
| R6 | **Forgotten per-chat secret** → permanent chat loss | Med | Med | Define recovery policy up front and surface it clearly to users. |
| R7 | **Hiding the thread doesn't hide the relationship** — contact, call log, timing still visible to someone with device access | High | Med | Manage contact presence; set honest user expectations. |
| R8 | **Static identity code** replayed/learned | High | Med | Use rotating/duress codes (§4.3). |
| R9 | **App-store rejection / reputational harm** if positioned as a secrecy/affair tool | Med | High | Lead with "privacy & security"; avoid deception framing in store listings (§10). |
| R10 | **Compliance conflict** — traceability mandates vs strong E2E (India) | Low now, Med at scale | High | Track DPDP Act + IT Rules; see §10. Decentralise/minimise data you can be compelled to produce. |
| R11 | Spam, abuse, account takeover | Med | Med | Rate-limiting, device verification, abuse reporting. |
| R12 | **"Delete-on-exit" hook fails to fire** (crash, OS kill, force-stop, battery death) → ephemeral messages persist | High | High | Ephemeral-by-construction: volatile in-memory key, never persist-then-delete (§5.3). |
| R13 | **Screenshots / screen recording / second camera** capture ephemeral content | High | Med | Set honest expectations; screenshot detection is a deterrent only, not prevention. |
| R14 | **Recipient retains "secret" messages** because no shared ephemeral flag | Med | High | Transmit an ephemeral flag with every secret-segment message (§5.4). |

---

## 9. Legal / compliance / positioning notes

- **Positioning:** the origin use-case (concealing a contact from a spouse) is a *secrecy* framing. Build and market this as a **privacy/security** product. A "hide it from your partner" / infidelity framing invites app-store rejection, reputational risk, and unwanted scrutiny. Same features, very different framing.
- **India — DPDP Act 2023:** if you handle other users' personal data, you have data-protection obligations (consent, breach handling, deletion).
- **India — IT Rules 2021:** large messaging intermediaries can face *traceability* requirements (identify the originator of a message). This is in direct tension with strong E2E. Not an issue at small scale, but design with the tension in mind before you grow.
- **Honesty to users:** never promise more privacy than the architecture delivers (esp. metadata, backups, push). Over-claiming is both an ethical and a legal exposure.
- *Not legal advice — consult a qualified lawyer in your jurisdiction before launch.*

---

## 10. Phased roadmap (don't build it all at once)

- **Phase 0 — Foundations:** domain + VPS + TLS, auth, 1:1 messaging over WebSocket, PostgreSQL/Redis. No E2E yet (prove the pipe).
- **Phase 1 — MVP:** integrate libsignal E2E, media, push (with silent-push design), web client. *Ship to yourselves only.*
- **Phase 2 — Signature features:** per-chat hidden chats (with all §3.2 leak surfaces handled), then ephemeral secret-conversation segments (ephemeral-by-construction, §5.3), then identity verification (rotating + duress codes).
- **Phase 3 — Hardening:** independent security review, backup/restore drill, abuse controls, store-readiness, compliance check.
- **Phase 4 — Scale (if needed):** second node, HA, monitoring.

---

## 11. Open decisions I need from you

1. **Scope (A1):** real product for many users, or private build for you + your friend? *(Biggest single fork — changes everything below it.)*
2. **iOS (A3):** include Apple/iOS, or Android + web only to start?
3. **E2E (A2):** hard requirement, or acceptable to start server-readable for speed?
4. **Budget / timeline / team size** — sets realistic phasing.
5. **Identity verification:** rotating code, duress code, or both?
6. **Ephemeral segments (A6):** confirm that secret messages carry a shared ephemeral flag so the *recipient's* copy also self-erases — not just the sender's local view. (Local-only makes the feature meaningless.)
