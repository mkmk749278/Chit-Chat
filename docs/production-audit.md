# Chit-Chat / Lumin — Production-Readiness Audit (2026-09)

> Scope: the whole monorepo — `apps/backend`, `packages/crypto`, `packages/types`, `apps/mobile`,
> `apps/web`, `infra/`, `.github/workflows`. Perspective: production operator + security
> auditor for an end-to-end-encrypted messenger on a single VPS.
>
> No Owner Brief exists in the repository; the audit is grounded in `CLAUDE.md`,
> `.kiro/specs/`, `docs/roadmap.md`, `docs/production-readiness-roadmap.md`, and the code.
> Companion docs: `docs/production-readiness-roadmap.md` (feature gaps, now refreshed) and
> `docs/roadmap.md` (spec status).

Severity: **P0** = message loss, security hole, or store-release blocker · **P1** = reliability /
abuse exposure a real user base will hit · **P2** = hardening / hygiene.

---

## 1. Verdict

**Before this change the app was not production-ready, for one dominant reason: messages were
silently lost while the sender saw "sent".** Three independent server-side defects each dropped
messages, and together they explain the recurring field complaint "no offline delivery":

1. **Stale presence after every deploy (P0).** A redeploy kills the backend without running
   disconnect cleanup, and the new container gets a new node id. Every user connected at deploy time
   kept a `presence:{uid} → deadNode` entry *forever*. The relay then saw them as "online", published
   into a channel nobody listens on, **never queued, never pushed** — every later message to them
   while their app was closed was lost.
2. **At-most-once delivery (P0).** Live delivery wrote into whatever socket the registry pointed at;
   a mobile socket that had silently died (network switch, OS-frozen app) swallowed the message.
   The offline queue was *deleted on connect before the client processed it*, so a connection that
   dropped mid-drain lost the whole backlog.
3. **Process crash on any Redis hiccup (P0).** Inbound WebSocket frames were handled in un-awaited
   promises with no error handling; Node 20 terminates on an unhandled rejection, so one failed
   Redis call during a send took the whole backend (every user's socket) down.

All three are fixed and verified in this change (§3), along with a fourth, smaller loss path
(frames sent during the handshake, R5). With them, plus the security and abuse fixes
below, the backend and Android client are in a state a real user base can rely on for 1:1
messaging — **provided the owner actions in §5 are completed** (notably shipping a new Android
build, deciding on the web client, and store-listing compliance).

What it still is *not*: a WhatsApp-parity product. Groups, calls, multi-device, and a working web
client are not built (§6). Those are roadmap items, not defects.

---

## 2. Method

- Read every backend module, the realtime/messaging core in `packages/crypto`, the mobile
  bootstrap/push/store wiring, the web client, all infra and CI.
- Baseline before changes: `build:packages → lint → typecheck → test` green (backend 104, crypto
  562, mobile 88, web 59 tests).
- Every fix ships with unit tests. The Redis-dependent pieces were additionally exercised against a
  **real Redis 7** and the **real gateway** (Nest + `ws`) with real WebSocket clients, covering:
  offline store + wake, drop-before-ack → full replay, partial acknowledgement, live delivery with
  ids, ping/pong, legacy-client drain, stale dead-node presence, oversized frames (1009), a send
  flushed during slow token verification, and graceful shutdown (1012). The shared `RealtimeClient` was also run against the real gateway
  (protocol negotiation, keepalive, replay, acknowledgement).
- The edited `Caddyfile` was validated with Caddy 2.8 (`caddy validate` + adapted route order).

---

## 3. Findings fixed in this change

| ID | Sev | Area | Finding | Fix |
|----|-----|------|---------|-----|
| R1 | P0 | Realtime | Stale `presence:{uid}` entries from crashed/redeployed nodes made offline users look online forever → messages published to dead channels, never queued or pushed. | Per-boot node id (`NODE_ID` + random suffix); `node-alive:{nodeId}` marker refreshed each heartbeat; routing uses `lookupLive` (filters + prunes dead-node entries); presence hashes get an idle TTL and are re-asserted each heartbeat; `PUBLISH` receiver count 0 ⇒ treated as offline. |
| R2 | P0 | Realtime | At-most-once delivery: messages lost to half-dead sockets and to connections that dropped during the offline-queue drain. | **Protocol v2 (acknowledged delivery).** Every accepted envelope is appended to a per-recipient Redis Stream inbox *before* fan-out; `deliver` frames carry the inbox `id`; the client confirms with `delivered` after durable processing; the inbox is replayed on every reconnect. Client dedupes by id (in-memory + persisted ring on mobile) so replays never produce duplicate rows or "could not decrypt" errors. Negotiated via `?v=2` / `hello`, fully backward compatible (§4). |
| R3 | P0 | Realtime | Unhandled promise rejections from frame handling / handshake registration crash the process. | All inbound frame handling is caught and logged; handshake registration failures close with a retryable 4503; process-level `unhandledRejection` logger as defence in depth. |
| R4 | P0 | Ops | No graceful shutdown: SIGTERM (every deploy) cut sockets without close frames and skipped presence cleanup (feeds R1). Node ran as PID 1 without signal handling. | `enableShutdownHooks()`; gateway `beforeApplicationShutdown` withdraws its liveness marker + presence entries and closes sockets with **1012** (clients reconnect immediately); Redis clients quit last; compose `init: true` + `stop_grace_period: 30s`. |
| R5 | P1 | Realtime | Frames a client sent between the WebSocket opening and the server finishing token verification were silently dropped by `ws` (no listener attached yet). The client flushes queued sends exactly then, so messages written while offline often failed after reconnect. | The gateway buffers early frames (bounded: 64 frames / 1 MiB) from the first synchronous step of the handshake and replays them once registered; discarded if auth fails. |
| C1 | P1 | Client | No client-side liveness check: a foregrounded app whose socket died silently stayed "connected" for minutes, receiving nothing. | `RealtimeClient` keepalive (v2 servers only): `ping` every 25 s, socket replaced if no frame within 10 s. Foreground wake push (server sees no live socket) now triggers an immediate reconnect. |
| C2 | P2 | Client | Each wake push stacked another identical "New message" notification. | Fixed notification identifier (replaces); server debounces wakes (5 s/user) and uses an FCM collapse key + TTL. |
| S1 | P0 | Security | Device registration trusted a **client-supplied phone number** when the token had no phone claim → any account could claim someone else's number and receive the messages meant for them via contact discovery. | Only Firebase-verified numbers are stored (token claim, else Firebase Admin `getUser`). A verified number is cleared from any other account row (recycled numbers); lookup is deterministic. |
| S2 | P1 | Security | `/metrics` publicly readable at `api.<domain>/metrics`: through Caddy every request comes from a private Docker IP, which the monitoring guard's default allowlist accepts. | Caddy returns 404 for `/metrics*` on the public API host. (Prometheus still scrapes over the internal network.) |
| S3 | P1 | Abuse | Any signed-in user could drain another user's one-time prekeys (unbounded `GET /api/keys/:uid`), silently weakening forward secrecy of that user's new sessions. | Per-caller claim limit (30/min) + uid bounds check. |
| S4 | P1 | Abuse | No per-user limit on `send`/`typing` frames: one account could flood a victim's queue (and push out their real messages past the cap). | Per-uid limits: 300 sends/min, 60 typing/min (fail-open on limiter errors, like every other limit). |
| S5 | P1 | Abuse / DoS | `ws` default `maxPayload` is 100 MiB; the JSON body limit was 25 MB on **every** route (parsed before auth). | WS frames capped at 256 KiB (close 1009); body limit 12 MB on `/api/blobs` only, 256 KB elsewhere; Caddy `request_body max_size 13MB`. |
| S6 | P1 | Abuse / DoS | Blob store is Redis (RAM) with 7-day TTL; the rate limit alone allowed ~480 MiB/min per account → one user could OOM the single VPS, taking presence, rate limits and the inbox down. | Per-user rolling 200 MiB/day quota (atomic Lua), upload rate 60→30/min, blob id validated as UUIDv4. Optional `REDIS_MAXMEMORY` + `noeviction` knob (§5). |
| S7 | P2 | Hygiene | Relay stored/forwarded any extra fields a client put on the envelope; routing fields unbounded. | Envelope is sanitized to the wire fields; routing strings ≤128 chars; `seq` must be a safe integer. |
| S8 | P2 | Push | Dead FCM tokens were never removed; a reinstall left the old token on a stale device row. | Tokens FCM reports as unregistered/invalid are pruned; setting a token clears it from other device rows. |
| S9 | P2 | Infra | Backend container ran as root; `.dockerignore` did not exclude env files / keystores; no container healthcheck; no edge security headers. | `USER node`; secrets excluded from build context; compose healthcheck; HSTS / nosniff / referrer-policy / `-Server` (+ `X-Frame-Options: DENY` on the web host). Deploy now reloads Caddy so edge changes apply. |
| L1 | P0 | Store policy | **No account deletion** anywhere. Google Play requires in-app account deletion for apps that create accounts (and GDPR erasure applies). | `POST /api/account/delete` (rate-limited, idempotent): deletes the user row (cascades devices/prekeys/push tokens), per-user Redis state (inbox, presence, last-seen, quotas), the cached token, and the Firebase Auth user. Mobile: Settings → "Delete account" with a destructive confirmation; wipes the device on success. |
| W1 | P1 | Product honesty | The public web app runs the **demo controller**: any 6-digit code "signs in" and sent messages go nowhere, with no disclosure. | Every page now shows a "Web preview — messages typed here are not sent" banner. (Building the real web client remains a roadmap item, §6.) |

---

## 4. Rollout and compatibility (read before deploying)

Protocol v2 is negotiated, so every combination keeps working:

| Client ↓ / Server → | Old backend | New backend |
|---|---|---|
| **Old app build** (installed today) | unchanged | Served **v1 semantics** (destructive replay, legacy entries dropped on live delivery). Also benefits from R1/R3/R4 — the stale-presence loss is fixed for them too. |
| **New app build** | Never receives `hello` ⇒ no keepalive, no acks; behaves like today. | Full v2: at-least-once, dedupe, keepalive. |

- Anything left in the pre-v2 `offline:{uid}` lists is folded into the new inbox on the recipient's
  next connect — nothing queued before the deploy is stranded.
- The first deploy prunes every stale presence entry automatically (old nodes have no liveness
  marker), so users affected by R1 start receiving pushes immediately.
- `POST /api/devices/register` still accepts `phoneNumber` from old builds but ignores it.

**Deploy order:** merge → backend + web auto-deploy (backend deploy also reloads Caddy) → build and
ship the Android app from `main` (the `android` workflow) so users get acknowledged delivery,
keepalive, and account deletion.

**Watch after deploy:** backend logs for `Failed to refresh node liveness`,
`Live fan-out failed`, `Dropped a send frame over the per-user rate limit`; Redis memory
(`INFO memory`) and `XLEN inbox:*` growth (entries should drain as v2 clients acknowledge).

---

## 5. Owner actions (cannot be done from the repository)

| # | Action | Why |
|---|--------|-----|
| O1 | **Ship a new Android build** to users (Play internal track / APK). | Acknowledged delivery, keepalive, foreground-wake reconnect, collapsed notifications, and account deletion are client features. |
| O2 | Confirm the Firebase Admin service account can **`getUser` and `deleteUser`** (the default Firebase Admin SDK service account can). | Verified-phone fallback (S1) and account deletion (L1). |
| O3 | Set **`MONITORING_CIDRS`** to the Docker `monitoring` network subnet (e.g. `docker network inspect <project>_monitoring`). | Defence in depth for `/metrics` beyond the Caddy block (S2). |
| O4 | Set **`REDIS_MAXMEMORY`** in the compose `.env` to ~40% of the VPS RAM once current usage is known (`docker compose exec redis redis-cli INFO memory`). | Turns an OOM-kill of the whole box into failed writes (S6). Left unlimited by default so the deploy cannot break a host whose usage is unknown. |
| O5 | **Play Console:** account-deletion web URL + Data safety form (phone number, contacts discovery, push token; E2E-encrypted messages). **Privacy policy URL** (none exists in the repo). | Store-listing requirements; L1 provides the in-app part. |
| O6 | Decide the **web** story: build the real client (`docs/phase1-handoff.md` §3.1) or replace the page with a landing/download page. | W1 is a disclosure, not a product. |
| O7 | `JWT_SECRET` and `ENCRYPTION_KEY` are **required at boot but unused** by any code. Either remove them from `REQUIRED_ENV_VARS` or document their future use; do not rotate them expecting an effect. | Secret hygiene / operator confusion. |
| O8 | Pin `caddy`, `prom/prometheus`, `grafana/grafana`, `edoburu/pgbouncer` to the versions currently running on the VPS (`docker image ls`). They float on `:latest` today. | Reproducible deploys; a surprise major upgrade on host rebuild. Not changed here because pinning blind could downgrade Grafana's database. |

---

## 6. Remaining gaps (roadmap, not fixed here)

**P1 — reliability / scale**
- **Attachments live in Redis memory** (up to 8 MiB each, 7-day TTL). Move `BlobService` to object
  storage (the B2 secrets already exist in the deploy) behind the same interface.
- **No two-client E2E test in CI** (CC1). The gateway/Redis scenarios verified during this audit
  should become a CI job with a Redis service container.
- **Single node / single VPS**: no redundancy. The design supports more nodes (per-node channels,
  liveness markers), but Postgres/Redis are single instances; backups cover Postgres only (nightly,
  encrypted, 30 days) — the Redis inbox is persisted via AOF on the host volume only.
- **Sender retries after an ack timeout re-encrypt the same seq**, so a message whose ACK (not the
  message) was lost can appear twice for the recipient. Needs a client message id carried inside the
  encrypted payload for recipient-side dedupe.

**P1 — product parity** (unchanged from `docs/production-readiness-roadmap.md`): real web client,
group chats, audio/video calls, multi-device / linked devices, message search, reply/forward.

**P2 — client hardening** (tracked in `docs/roadmap.md` §10): `FLAG_SECURE`, certificate pinning,
root/tamper detection, SQLCipher vs the AES-CBC+HMAC vault (CC3), one-time-prekey replenishment
trigger (CC2), binding the vault key to the app PIN.

**P2 — privacy**: contact discovery is an enumerable phone→UID lookup (rate-limited, authenticated) —
a documented product trade-off; a private-contact-discovery scheme is the long-term fix.

---

## 7. Where things live (for reviewers)

- Inbox / acknowledged delivery: `apps/backend/src/messaging/inbox.service.ts`,
  `message-relay.service.ts`, `realtime/realtime.gateway.ts`; wire types in
  `packages/types/src/messaging.ts`; client in `packages/crypto/src/realtime-client.ts` and
  `messaging.ts` (`processInbound`); mobile persisted dedupe in
  `apps/mobile/src/crypto/persistent-store.ts`.
- Presence liveness: `apps/backend/src/redis/presence-registry.service.ts`,
  `realtime/node-identity.util.ts`.
- Account deletion: `apps/backend/src/account/`, `apps/mobile/src/app/chat-controller.ts`
  (`deleteAccount`), `apps/mobile/src/ui/SettingsScreen.tsx`.
- Edge / infra: `infra/caddy/Caddyfile`, `infra/docker/docker-compose.yml`,
  `apps/backend/Dockerfile`, `infra/scripts/deploy.sh`.
