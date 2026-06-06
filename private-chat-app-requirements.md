# Private Chat Application — Product & Technical Requirements

**Status:** v0.4 · **Last updated:** Session 5 — Google Play Compliance, Privacy Threat Model, Policy Mapping
**Audience:** Owner / build team · **Build standard:** Production-grade from day one. No shortcuts, no fast-tracks.

> Decisions confirmed by the owner are marked **[CONFIRMED]**. Decisions made by the document author on the owner's behalf are marked **[DECIDED]**. Every item in this document is a build commitment — nothing is aspirational.

---

## 1. Product Summary

A privacy-focused chat application (Android app + web) self-hosted on a VPS under a custom domain, distributed via Google Play Store. Built entirely via GitHub — no PC required at any stage. Every deployment, build, and automation runs through GitHub Actions.

The product is differentiated by **seven signature features**:

1. **Per-chat hidden chats with per-chat secrets** — each concealed conversation has its own independent unlock trigger.
2. **In-chat identity verification** — rotating TOTP + duress code confirms the human at the keyboard.
3. **Ephemeral secret conversation segments** — self-erasing in-chat segments, ephemeral-by-construction using volatile in-memory keys.
4. **Decoy PIN / Duress App State** — second PIN opens a sanitised fake app state.
5. **Self-destructing messages** — configurable TTL per message or conversation.
6. **View-once media** — photos and videos openable exactly once, then permanently purged.
7. **Dual-layer Shadow Chat with `/alias` command system** — every contact can have a completely invisible parallel secret conversation, accessed only by typing a private alias in the search bar.

---

## 2. All Confirmed Decisions

| # | Decision | Resolution | Source |
|---|----------|------------|--------|
| D1 | Product scope | Multi-user real product, Play Store launch | [CONFIRMED] |
| D2 | Platforms | Android app + web. iOS considered later. | [CONFIRMED] |
| D3 | Auth provider | Google Firebase Authentication | [CONFIRMED] |
| D4 | E2E encryption | Hard requirement. libsignal (Signal Protocol). | [CONFIRMED] |
| D5 | Build quality | Production-grade from day one. No shortcuts. | [CONFIRMED] |
| D6 | Identity verification | Rotating TOTP + duress code (both) | [DECIDED] |
| D7 | Ephemeral segment model | Shared ephemeral flag; erase trigger per-device | [CONFIRMED] |
| D8 | Forgotten-secret recovery | No recovery path. Forgotten secret = permanent data loss. | [CONFIRMED] |
| D9 | Key backup on device loss | No key backup. Historical E2E messages unreadable after device loss. Forward secrecy preserved. | [DECIDED] |
| D10 | Web ephemeral segments | Supported. Session keys in JS memory only, never localStorage. Honest UX warning shown. | [DECIDED] |
| D11 | Push notification strategy | Silent/data-only for sensitive messages. Per-device push key for normal message previews. | [DECIDED] |
| D12 | Infrastructure | Self-hosted VPS + custom domain. | [CONFIRMED] |
| D13 | Development workflow | GitHub-first. Zero PC required. All builds via GitHub Actions. Secrets via GitHub Secrets. | [CONFIRMED] |
| D14 | Performance target | Instant messages. Zero perceptible lag. Sub-100ms message delivery on good connection. | [CONFIRMED] |

---

## 3. Signature Feature 1 — Per-Chat Hidden Chats

### 3.1 Behaviour
- Any chat can be marked **hidden**. Each gets its own unlock secret stored as a salted bcrypt hash — never plaintext.
- Hidden chats do not appear in the chat list. Typing the secret in the search bar reveals only that one chat.
- Auto-rehide on: app backgrounded, 60-second inactivity timeout, device lock, or manual lock.
- Rate-limiting: 5 wrong attempts per 10 minutes → 30-minute lockout. Timing-only feedback, no attempt counter shown.

### 3.2 Leak Surfaces — All Hard Requirements

| Surface | Required Handling |
|---------|-------------------|
| Notifications | Silent/data-only FCM. Zero lock-screen preview. Content fetched in-app after unlock. |
| Recent apps switcher | FLAG_SECURE on all Activities. OS cannot screenshot. |
| Device & cloud backups | Hidden-chat messages excluded from all Android backup channels. `android:allowBackup="false"` scoped per chat. |
| Media auto-save | Never written to MediaStore / device gallery. |
| Global in-app search | Hidden-chat content and contact names excluded from search index. |
| Notification history | Silent pushes only. Nothing in Android notification log. |
| Contact presence | Contact still visible in contacts list — hiding thread ≠ hiding relationship. Disclosed to users. |

### 3.3 Secret Entry & Management
- Entry: search bar only. No visible UI affordance that hidden chats exist.
- Secret change: from within the revealed chat only, requires current secret + account re-auth.
- Forgotten secret: no recovery. Disclosed at secret-setting time.

---

## 4. Signature Feature 2 — In-Chat Identity Verification

### 4.1 The Problem
E2E encryption verifies the channel and device keys — not the human typing. Anyone holding an unlocked device can message as the owner. This feature verifies who is actually at the keyboard.

### 4.2 Design: Rotating TOTP + Duress Code

**Rotating TOTP code:**
- Both sides share a seed exchanged at conversation initiation, stored encrypted in app.
- Valid answer changes every 60 seconds (RFC 6238 / HMAC-SHA1). Cannot be replayed.

**Duress code:**
- A second valid-looking answer that silently fires a background alert to a pre-configured trusted contact.
- Identical UX to normal code — indistinguishable to an observer.
- Alert transport: delivered exclusively over the app's own encrypted FCM/data channel. Never uses the Android SMS or Call Log permissions (Restricted Permissions under Google Play; not requested by this app).

### 4.3 Pass / Fail Behaviour

| Outcome | What Happens |
|---------|-------------|
| Pass (normal code) | Green "Verified ✓" badge on both sides for the session. |
| Pass (duress code) | Green badge shown to requester. Silent alert fired to pre-configured contact. |
| Fail | "Unverified" badge. Sending not blocked. State persists for session. |
| No response within 2 min | "Identity unconfirmed" badge. |

### 4.4 Scope
- Per-session verification. Either party can request at any time. State resets on app lock/exit.

---

## 5. Signature Feature 3 — Ephemeral Secret Conversation Segments

### 5.1 Behaviour
- `/Start secret conversation` begins an ephemeral segment inside any visible chat. `/Default` ends it.
- Messages self-erase on: app exit, backgrounding, screen lock, or `/Default`.
- Commands are consumed by the protocol layer — never rendered as visible messages.

### 5.2 Architecture — Ephemeral By Construction
- Segment messages live in volatile memory only — encrypted under a session key held exclusively in RAM.
- Android: `SecureRandom`-generated in-memory byte array, never written to disk.
- Web: key in a JS variable in execution context, never written to localStorage or sessionStorage.
- Key gone on process death or screen lock = data unreadable whether or not cleanup code ran.
- On-exit handler is a best-effort fast path, never the security guarantee.

### 5.3 Shared Ephemeral Flag
Every secret-segment message carries `ephemeral: true` in the encrypted payload. Recipient's app treats flagged messages identically: volatile storage, erase on their own exit/lock. Server purges ciphertext immediately on delivery ACK — no server-side history ever.

### 5.4 Multi-Device Erasure Propagation
Lock/exit on any device sends an encrypted erase-propagation control message to all other linked devices. All devices erase their in-memory copies of the segment.

### 5.5 Leak Surfaces

| Surface | Required Handling |
|---------|-------------------|
| Notifications | Silent/data-only push. Never in notification history. |
| Backups | Never written to any backup channel. |
| Server | Ciphertext purged on delivery ACK. Never enters message history. |
| Multi-device | Erase propagation on lock/exit (§5.4). |
| Command escaping | Prefix `\\` to send literal `/Start secret conversation` as text. |
| In-flight interruption | Draft discarded if `/Default` or lock fires mid-compose. |

---

## 6. Signature Feature 4 — Decoy PIN / Duress App State

### 6.1 Behaviour
- Two PINs: **real PIN** (normal app, all chats) and **decoy PIN** (sanitised fake state, no hidden chats, no shadow chats, plausible-looking subset of normal conversations).
- Two states are visually indistinguishable. No indicator of which mode is active.
- Decoy PIN login optionally triggers the same silent alert as the identity verification duress code.

### 6.2 Implementation Notes
- Decoy mode is a separate app session with a separate E2E key bundle.
- Decoy contacts and messages can be pre-populated by the user.
- Decoy PIN passes the same rate-limiting and lockout logic as the real PIN.
- No "forgot PIN" flow reveals which PIN is real.

---

## 7. Signature Feature 5 — Self-Destructing Messages (Timer-Based)

### 7.1 Behaviour
- Configurable TTL per message or per conversation: 5 seconds, 30 seconds, 1 minute, 5 minutes, 1 hour, 24 hours, 7 days.
- Deletion is bilateral: fires on sender, recipient, and server.
- Timer starts from message delivery, not send time. Protects offline recipients.
- Recipient offline when TTL expires: message purged server-side; tombstone shown on reconnect.
- Sender controls TTL. Recipient cannot disable it.

### 7.2 Implementation Notes
- Server maintains a TTL index. BullMQ worker scans and issues deletion events.
- Clients honour server deletion events and also run local TTL timers (belt-and-suspenders).
- TTL messages excluded from search indexing after expiry.

---

## 8. Signature Feature 6 — View-Once Media

### 8.1 Behaviour
- Sender marks photo or video as view-once before sending.
- Recipient opens it once; media deleted from device and server copy purged on close.
- No forwarding, saving, or screenshot (FLAG_SECURE active during view).
- Unopened after 14 days: auto-purged from server, tombstone notification sent.

### 8.2 Implementation Notes
- Never written to device gallery.
- View confirmation ACK triggers server-side purge.
- View-once media stored in a separate S3 bucket with stricter TTL policy.

---

## 9. Signature Feature 7 — Dual-Layer Shadow Chat with `/alias` Command System

### 9.1 The Problem This Solves
Even with a hidden chat and a per-chat secret, the contact itself is visible. Anyone can open the contacts list, find the contact, and see the chat — or see a PIN prompt that raises suspicion. This feature solves the contact-layer visibility problem entirely by maintaining two completely independent chat threads per contact: a **surface chat** (visible, everyday, actively usable) and a **shadow chat** (completely invisible at every surface, accessible only via a private alias command).

### 9.2 Dual-Layer Model

| Layer | Name | Visible to | Accessible via |
|-------|------|-----------|----------------|
| Surface Chat | Normal conversation | Everyone | Contact screen, chat list, search |
| Shadow Chat | Secret conversation | Only the owner | `/alias` command in search bar only |

These are two entirely separate chat threads — separate message history, separate E2E key pairs, separate on-device storage, separate server thread IDs. They share only the contact's Firebase UID.

The surface chat is the user's normal, everyday conversation, used for ordinary messaging. The shadow chat is invisible by default at every level, protecting sensitive conversations from anyone who gains physical access to an unlocked device.

### 9.3 The `/alias` Command System

#### How It Works
- Every shadow chat has a **private alias** set by the user at setup time: `/journal`, `/work`, `/private`, `/notes` — any `/word` the user chooses.
- To access a shadow chat: type the alias in the search bar → secret prompt appears → enter secret → shadow chat opens.
- On exit from shadow chat → surface chat view or normal app state restored instantly.

#### Alias Rules

| Rule | Reason |
|------|--------|
| Must start with `/` | Distinguishes from normal search; never conflicts with a contact name |
| Case-insensitive | `/Private` and `/private` both work |
| Alphanumeric only, no spaces | Prevents accidental triggers |
| One alias per shadow chat | One door per room |
| Stored locally only, never synced to server | Server never knows aliases exist |
| Alias stored as HMAC hash, not plaintext | DB dump reveals nothing |
| Alias list never shown anywhere in app UI | No "manage aliases" screen in normal app state |
| Alias can be changed from inside shadow chat only | Requires current secret |

#### Multiple Independent Shadow Chats
```
/journal    → private chat with Contact A (own secret)
/work       → private chat with Contact B (own secret)
/private    → private chat with Contact C (own secret)
/notes      → private chat with Contact D (own secret)
```
Each is fully compartmentalised. Knowing one alias + secret reveals nothing about others.

#### Search Bar Interception — Hard Build Requirement
The moment input matches the `/` prefix pattern, the app intercepts it at the input layer — before it reaches any OS search history, autocomplete, or suggestion cache. The field is cleared immediately. Nothing reaches Android's search suggestion system. This is not optional and must be implemented at the lowest possible input interception point.

#### What an Observer Sees

| User types | Result | Observer sees |
|-----------|--------|---------------|
| `/private` + correct secret | Shadow chat opens | Brief typing, screen changes |
| `/private` + wrong secret | "No results" shown | Looks like a failed normal search |
| `/private` (alias doesn't exist for this device) | "No results" shown | Identical to wrong secret |
| Any normal text | Normal search results | Normal search |

Wrong-secret and no-alias cases produce **identical behaviour** — the app never confirms an alias exists.

### 9.4 Shadow Thread ID Derivation
The server does not know any thread is a shadow thread. From the server's perspective it is just two separate conversations between the same two users. The shadow thread ID is derived client-side:

```
shadow_thread_id = HMAC-SHA256(
  key  = shadow_master_secret  (stored locally in encrypted DB, never sent to server),
  data = canonical_sort(user_a_uid, user_b_uid) + "shadow"
)
```

Both parties derive the same shadow thread ID independently without server involvement.

### 9.5 Shadow Chat Leak Surfaces — All Hard Requirements

| Surface | Required Handling |
|---------|-------------------|
| Chat list | Never appears. No unread badge. No last-message preview. |
| Contact screen | No chat badge, no last-message, no unread count, no "last seen" update from shadow activity. |
| Notifications | Silent/data-only FCM only. No banner, no lock-screen entry, no badge count change. |
| Search | Completely excluded from all search surfaces. |
| Media gallery | Shadow chat media never written to device gallery. |
| Backups | Shadow chat excluded from all backup channels. |
| Recent apps | FLAG_SECURE active. |
| Typing / last seen | Shadow chat activity does not update surface chat presence data. |
| Notification shade | Zero entry in the notification log for shadow messages. |

### 9.6 Private Unread Indicator
Since there are no notifications, users need to know shadow messages are waiting without any visible indicator.

**Chosen design: subtle in-app indicator (Option B)**
After unlocking the app with the real PIN, a small neutral visual indicator (a dot on the user's own profile avatar, or a colour shift on the search bar) signals that unread shadow messages exist. No text, no count, no name. Not visible in decoy PIN mode. This is the chosen design — it leaks nothing to an observer but informs the real user.

### 9.7 Shadow Chat Setup Flow (First Time)
1. In any surface chat: trigger long-press on the chat header → a neutral overlay appears for 5 seconds.
2. "Set up shadow conversation" option shown.
3. User sets: alias (e.g. `/private`) and shadow secret. Both stored locally as hashes.
4. Shadow chat E2E key exchange: bootstrapped over the existing surface chat E2E channel, then becomes fully independent.
5. Both parties must set up independently. Shadow chat is only active once both sides have configured it.
6. From this point the shadow thread is fully isolated from the surface thread.

### 9.8 Relation to Feature 1 (Hidden Chats)
These serve different threat models and can be active simultaneously:

| Feature | Threat model | What it hides |
|---------|-------------|---------------|
| Hidden chat (§3) | Someone browsing the chat list | The entire chat thread disappears from list |
| Shadow chat (§9) | Someone who knows you talk to this contact and checks directly | A parallel secret thread; surface chat remains visible and innocent |

---

## 10. Additional Security Infrastructure

### 10.1 Screen Security (FLAG_SECURE)
Applied to all Activities and WebViews app-wide. Prevents OS screenshots in the recent-apps switcher. Not toggle-able by user.

### 10.2 Encrypted Local Database (SQLCipher)
All on-device data (messages, keys, aliases, secrets) stored in SQLCipher-encrypted SQLite. The DB encryption key is derived from the user's PIN + device hardware-backed keystore. Plaintext SQLite is not acceptable for a privacy app.

### 10.3 Certificate Pinning
The app pins the server's TLS certificate via `react-native-ssl-pinning`. Connections not matching the pinned cert are rejected. Prevents MITM via fake CA certificate installation on device.

### 10.4 Root / Tamper Detection
Rootbeer or equivalent library detects rooted devices. On detection: app displays an honest warning that security guarantees are weakened. Does not hard-block (user's choice) but warning is persistent and non-dismissable without acknowledgement.

### 10.5 Contact Verification (Safety Numbers)
- Each conversation has a Safety Number (fingerprint of both parties' identity keys via libsignal).
- QR code scan in person confirms no MITM on the E2E channel.
- "Security verified ✓" badge on the conversation after QR verification.
- Contact key change (new device/reinstall) clears badge and shows warning.

### 10.6 Linked Device Management
- Session management screen: all linked devices with device name, last-seen, IP geolocation (city level).
- Remote one-tap session revocation from any device.
- New device login pushes notification to all existing devices.
- Emergency revoke-all option from the notification.

### 10.7 Two-Factor Authentication for Sensitive Actions
TOTP-based 2FA (authenticator app) required for: changing decoy PIN, revoking all devices, exporting account data. Separate from the in-chat identity verification TOTP. Uses the same RFC 6238 algorithm.

---

## 11. Table-Stakes Features

| Feature | Notes |
|---------|-------|
| Auth | Firebase: phone OTP, email/password, Google Sign-In. |
| Contacts / discovery | Phone-number hashing before upload. Blocking. |
| 1:1 messaging | Text, images, video, audio, files, voice notes. |
| Group messaging | Up to 256 members. Owner/Admin/Member roles. Announcement-only mode. Invite links with expiry. |
| E2E encryption | libsignal for all messages. |
| Delivery / read state | Single tick (sent), double tick (delivered), filled tick (read). |
| Message reactions | Emoji reactions on any message. |
| Message reply / quote | Reply to specific message with inline quote. |
| Message edit | Edit within 15-minute window. Edit history visible. |
| Message delete | Delete for everyone (all devices + server). |
| Forwarding | "Forwarded" label shown on forwarded messages. |
| Typing indicators | Toggleable per user. |
| Presence / last seen | Toggleable per user. |
| Message history sync | Across app + web via E2E multi-device protocol. |
| Push notifications | FCM (Android + web). Silent push for sensitive types. |
| Account / data export | DPDP/GDPR-compliant export. |
| Account deletion | Full purge within 30 days. |
| Reporting & blocking | In-app report flow, admin moderation queue. |
| App PIN / biometric | App-level lock independent of device lock. |
| Admin dashboard | Internal operator dashboard: user counts, message volume, abuse reports, storage usage. Not visible to end users. |

---

## 12. Performance Architecture — Zero Lag, Instant Messages

**Target:** Sub-100ms message delivery on a good connection. Zero perceptible lag under normal load. This section defines every architectural decision that achieves this target and must never be compromised.

### 12.1 WebSocket Connection Strategy

**Persistent connections — never poll.**
- Every connected client maintains one persistent WebSocket connection to the server.
- Messages travel over the open socket: no HTTP round-trip overhead, no connection setup latency per message.
- Connection is established once on app open and kept alive for the session duration.
- Heartbeat/ping every 25 seconds to keep the connection alive through NAT and mobile network timeouts.
- Reconnection: exponential backoff starting at 500ms, cap at 30 seconds, with jitter to prevent thundering herd on server restart.

**WebSocket server architecture:**
- NestJS with the `@nestjs/websockets` + `ws` adapter (not Socket.IO — `ws` has lower overhead).
- Each WebSocket server node can handle 10,000–50,000 concurrent connections depending on VPS size.
- All WebSocket nodes share state via Redis pub/sub. A message arriving at node A for a user on node B is routed via Redis — no direct node-to-node communication needed.

### 12.2 Message Delivery Pipeline

```
Sender device
  → WebSocket send (in-memory, ~0ms on device)
  → Server receives on WebSocket handler (~5–20ms network)
  → Server validates Firebase JWT (cached in Redis, ~0ms if cached)
  → Server stores ciphertext in PostgreSQL (async, non-blocking write)
  → Server publishes to Redis pub/sub channel for recipient (~1ms)
  → Recipient's WebSocket node receives from Redis
  → Server pushes to recipient's open WebSocket (~1ms)
  → Recipient device receives and renders
Total target: < 50ms on same region, < 100ms cross-region
```

**Critical: the DB write is async and non-blocking.** The message is delivered to the recipient via Redis pub/sub before the PostgreSQL write completes. The write happens in parallel. This eliminates DB write latency from the message delivery path entirely.

### 12.3 Redis Architecture for Speed

Redis is the speed layer. Every hot path goes through Redis first:

| Redis Usage | Purpose |
|-------------|---------|
| Pub/sub channels | Real-time message routing between WebSocket nodes |
| Presence cache | Online/offline status, last seen — never read from Postgres for this |
| JWT token cache | Firebase token verification result cached for token lifetime. Eliminates Firebase API call on every message. |
| Rate limit counters | In-memory counters — never hit Postgres for rate limiting |
| Typing indicator state | TTL keys: `typing:{thread_id}:{user_id}` expires in 3 seconds. No DB involved. |
| Prekey cache | Recently fetched libsignal prekey bundles cached to avoid repeated Postgres reads |
| Unread counts | Maintained in Redis, flushed to Postgres asynchronously |
| Session state | WebSocket connection registry: which node holds which user's connection |

Redis is configured with `maxmemory-policy allkeys-lru` and sufficient RAM to hold all hot data in memory. Redis persistence (`AOF` with `appendfsync everysec`) ensures no data loss on restart.

### 12.4 PostgreSQL Optimisation

PostgreSQL is the durable store — not the fast path. Design accordingly:

**Critical indexes (must exist from day one):**
```sql
-- Message retrieval by thread, paginated
CREATE INDEX idx_messages_thread_id_created ON messages(thread_id, created_at DESC);

-- Prekey bundle lookup for E2E key exchange
CREATE INDEX idx_prekeys_user_device ON prekeys(user_id, device_id);

-- TTL deletion worker
CREATE INDEX idx_messages_expires_at ON messages(expires_at) WHERE expires_at IS NOT NULL;

-- Unread count queries
CREATE INDEX idx_messages_recipient_read ON messages(recipient_id, is_read) WHERE is_read = false;
```

**Connection pooling:** PgBouncer in transaction-mode pooling in front of PostgreSQL. NestJS connects to PgBouncer, not directly to Postgres. Prevents connection exhaustion under load.

**Write strategy:** All non-critical writes (delivery receipts, read receipts, presence updates) are batched and written every 500ms rather than one write per event. Reduces write IOPS by 10–50×.

### 12.5 Client-Side Performance

**Optimistic UI — messages appear instantly on the sender's screen:**
- When user hits send, the message is rendered immediately in the UI with a "pending" state (single grey tick).
- The WebSocket send happens in parallel.
- When server ACKs receipt, the tick updates to delivered.
- If send fails (network drop), the message shows a retry indicator — it is never silently discarded.
- The user never waits for the network to see their own message. Zero send-side lag perception.

**Message list rendering:**
- FlatList (React Native) / virtual list (web) with windowed rendering. Only visible messages are in the DOM/render tree.
- Messages are paginated: load last 50 on open, load earlier messages on scroll with no UI freeze.
- All message rendering is memoised — a new message in a 500-message thread does not re-render the existing 499.

**Media:**
- Thumbnails generated server-side and delivered at display size — never download a 4MB image to show a 48×48 thumbnail.
- Progressive image loading: blurred placeholder → full image.
- Media uploads go directly to S3 presigned URL — bypasses the backend entirely for upload throughput.

### 12.6 Network Resilience

**Offline queue:**
- Messages sent while offline are queued locally in SQLCipher.
- On reconnect, the queue is flushed in order.
- Users can compose and "send" while offline; messages deliver when connection returns.

**Message gap detection:**
- Each message carries a monotonic sequence number per thread.
- On reconnect, client checks if its last received sequence number matches the server's. If gaps exist, missing messages are fetched via REST API, not WebSocket.
- Prevents silent message loss on flaky connections.

**FCM as wake-up only:**
- For a user who is offline (app closed), FCM sends a silent push to wake the app.
- App reconnects WebSocket and fetches missed messages via the gap-detection mechanism.
- FCM is the doorbell, not the message carrier. This eliminates FCM delivery latency from the normal online-user message path entirely.

### 12.7 VPS Network Configuration for Low Latency

```
DNS:
  chat.yourdomain.com    → VPS IP (A record)
  api.yourdomain.com     → VPS IP (A record)
  ws.yourdomain.com      → VPS IP (A record)   ← WebSocket endpoint
  cdn.yourdomain.com     → Backblaze B2 / CDN  ← Media delivery

Caddy config:
  ws.yourdomain.com {
    reverse_proxy localhost:3001 {
      transport http {
        compression off           # Never compress WebSocket frames
      }
    }
  }
```

- TCP `SO_NODELAY` enabled on WebSocket connections — disables Nagle's algorithm, sends frames immediately without waiting to batch.
- `SO_KEEPALIVE` enabled — detects dead connections within 60 seconds rather than waiting for timeout.
- VPS network buffer sizes tuned: `net.core.rmem_max`, `net.core.wmem_max` set to 16MB in `/etc/sysctl.conf`.
- Caddy configured with HTTP/2 for REST endpoints and HTTP/1.1 upgrade for WebSocket connections.

### 12.8 Performance Monitoring (Production Targets)

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| WebSocket message delivery (p50) | < 50ms | > 100ms |
| WebSocket message delivery (p99) | < 200ms | > 500ms |
| REST API response time (p99) | < 300ms | > 1000ms |
| Redis command latency (p99) | < 5ms | > 20ms |
| PostgreSQL query time (p99) | < 50ms | > 200ms |
| WebSocket reconnect time | < 2s | > 5s |
| Message loss rate | 0% | Any |

All metrics tracked via Prometheus, displayed in Grafana, alert via PagerDuty or similar.

---

## 13. Architecture & Technology Stack

### 13.1 Full Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| E2E Encryption | libsignal-protocol (Signal Protocol) | Do not invent crypto. Battle-tested, audited. |
| Auth | Firebase Authentication | Phone OTP, email, Google Sign-In. |
| Backend | Node.js + NestJS | TypeScript end-to-end, production-grade DI, strong WebSocket + async support. |
| Realtime transport | WebSocket (`ws` library, not Socket.IO) | Lower overhead than Socket.IO. Direct wire protocol. |
| Database | PostgreSQL + PgBouncer | Durable store. PgBouncer for connection pooling. |
| Cache / pub-sub | Redis 7 | All hot paths. Message routing. Presence. Rate limiting. |
| Job queue | BullMQ + Redis | TTL deletion, media purge, notification delivery. |
| Mobile | React Native (Expo + EAS Build) | Android-first. iOS-ready when needed. TypeScript shared with web. |
| Web | Next.js (React) | Production-grade SSR. Shares TypeScript crypto core with mobile. |
| Push | FCM | Wake-up signal only for offline users. Silent/data push for sensitive messages. |
| Edge / TLS | Caddy | Automatic HTTPS, Let's Encrypt. HTTP/2 + WebSocket upgrade. |
| File storage | Backblaze B2 (S3-compatible) | Media, view-once bucket, backup storage. Encrypted at rest. |
| Local DB (mobile) | SQLCipher | Encrypted SQLite. All on-device data. |
| Monitoring | Prometheus + Grafana | Metrics from day one. |
| Error tracking | Sentry | Backend + mobile + web clients. |
| Logging | Structured JSON → Loki | Queryable, retentive. |
| CI/CD | GitHub Actions | Zero PC required. All builds, tests, deploys. |

### 13.2 VPS & Domain Setup

**VPS spec (production launch minimum):**
- 4 vCPU / 8 GB RAM / 160 GB NVMe SSD
- Provider: Hetzner (best price/performance in Europe/India) or DigitalOcean
- Location: closest to primary user base (India → Singapore or Mumbai region)
- OS: Ubuntu 22.04 LTS

**Domain subdomains:**
```
yourdomain.com          → Web app (Next.js)
api.yourdomain.com      → REST API (NestJS)
ws.yourdomain.com       → WebSocket server (NestJS)
cdn.yourdomain.com      → Media CDN (Backblaze B2 + Caddy proxy)
grafana.yourdomain.com  → Internal monitoring (IP-restricted)
```

**Off-box backups:**
- Automated daily encrypted PostgreSQL dump → Backblaze B2.
- Automated daily Redis AOF backup → Backblaze B2.
- Retention: 30 days.
- Restore drill performed before launch and quarterly thereafter.

### 13.3 E2E Multi-Device Architecture

- Each device generates its own identity key pair and signed prekey bundle on registration.
- Sender fetches prekey bundles for all recipient's linked devices, encrypts separately to each.
- Web client is a linked device (mirrors Signal's model).
- Server holds public prekeys only — never private keys.
- Multi-device erase propagation (§5.4) implemented as encrypted control messages on the same E2E channel.

---

## 14. GitHub-First Development — Zero PC Workflow

All development, building, testing, and deployment happens via GitHub. No PC is required at any stage. All work is done from a phone (Termux, SSH to VPS, or GitHub mobile) or any browser.

### 14.1 Repository Structure

```
github.com/your-org/chat-app/
├── apps/
│   ├── mobile/          # React Native (Expo)
│   ├── web/             # Next.js
│   └── backend/         # NestJS
├── packages/
│   ├── crypto/          # libsignal wrapper, shared TypeScript
│   ├── types/           # Shared TypeScript types
│   └── ui/              # Shared UI components
├── infra/
│   ├── caddy/           # Caddyfile
│   ├── docker/          # Docker Compose for VPS services
│   └── scripts/         # Deploy scripts (called by GitHub Actions)
└── .github/
    └── workflows/       # All GitHub Actions pipelines
```

### 14.2 GitHub Actions Pipelines

**Pipeline 1 — Backend CI/CD (`backend.yml`)**
```
Trigger: push to main (apps/backend/**)
Steps:
  1. Checkout
  2. Install dependencies (npm ci)
  3. Run linter (ESLint)
  4. Run tests (Jest)
  5. Build TypeScript
  6. SSH to VPS (using GitHub Secret: VPS_SSH_KEY)
  7. Pull latest code on VPS
  8. Run docker compose up --build -d (zero-downtime rolling restart)
  9. Run DB migrations (TypeORM migration:run)
  10. Health check: curl https://api.yourdomain.com/health
  11. Notify on failure (Sentry / Slack webhook)
```

**Pipeline 2 — Web CI/CD (`web.yml`)**
```
Trigger: push to main (apps/web/**)
Steps:
  1. Checkout
  2. npm ci
  3. ESLint + TypeScript typecheck
  4. Jest tests
  5. Next.js build
  6. SSH to VPS → docker compose up --build (web service only)
  7. Health check
```

**Pipeline 3 — Android Build (`android.yml`)**
```
Trigger: push to main (apps/mobile/**) OR manual dispatch
Steps:
  1. Checkout
  2. Setup Node + Java (GitHub-hosted runner has both)
  3. npm ci
  4. Write google-services.json from GitHub Secret: GOOGLE_SERVICES_JSON
  5. Write keystore file from GitHub Secret: ANDROID_KEYSTORE_BASE64
  6. Build APK/AAB: eas build --platform android --non-interactive
     OR: cd android && ./gradlew bundleRelease
  7. Sign with keystore (from secret)
  8. Upload AAB to Play Store via Fastlane supply
     OR: upload as GitHub Release artifact for manual Play Console upload
  9. Notify success/failure
```

**Pipeline 4 — PR checks (`pr.yml`)**
```
Trigger: pull_request to main
Steps:
  1. Lint (all packages)
  2. TypeScript typecheck (all packages)
  3. Unit tests (all packages)
  4. Build check (no deploy)
  Comment: test results on the PR
```

**Pipeline 5 — Database Backup (`backup.yml`)**
```
Trigger: cron 0 2 * * * (2 AM daily)
Steps:
  1. SSH to VPS
  2. pg_dump → encrypted with GPG (key from GitHub Secret: BACKUP_GPG_KEY)
  3. Upload to Backblaze B2 (credentials from GitHub Secrets)
  4. Verify upload
  5. Delete backups older than 30 days
```

### 14.3 GitHub Secrets — Complete Classification

All secrets are stored in GitHub repository or organisation secrets. Zero plaintext secrets in code or config files. Every secret listed below must exist before any pipeline runs.

**Category A — VPS Access**

| Secret Name | What It Is | Used In |
|-------------|-----------|---------|
| `VPS_SSH_KEY` | Private SSH key for VPS deployment user | backend.yml, web.yml, backup.yml |
| `VPS_HOST` | VPS IP address or hostname | All deploy pipelines |
| `VPS_USER` | SSH username on VPS (e.g. `deploy`) | All deploy pipelines |

**Category B — Firebase**

| Secret Name | What It Is | Used In |
|-------------|-----------|---------|
| `FIREBASE_PROJECT_ID` | Firebase project ID | backend.yml (env var) |
| `FIREBASE_PRIVATE_KEY` | Firebase Admin SDK private key (JSON field) | backend.yml |
| `FIREBASE_CLIENT_EMAIL` | Firebase Admin SDK client email | backend.yml |
| `GOOGLE_SERVICES_JSON` | Full google-services.json (base64 encoded) | android.yml |

**Category C — Android Signing**

| Secret Name | What It Is | Used In |
|-------------|-----------|---------|
| `ANDROID_KEYSTORE_BASE64` | Release keystore file (base64 encoded) | android.yml |
| `ANDROID_KEY_ALIAS` | Key alias in the keystore | android.yml |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password | android.yml |
| `ANDROID_KEY_PASSWORD` | Key password | android.yml |

**Category D — Play Store**

| Secret Name | What It Is | Used In |
|-------------|-----------|---------|
| `PLAY_STORE_JSON_KEY` | Google Play service account JSON (for Fastlane/API uploads) | android.yml |

**Category E — Database**

| Secret Name | What It Is | Used In |
|-------------|-----------|---------|
| `DATABASE_URL` | PostgreSQL connection string (full URL with credentials) | backend.yml |
| `REDIS_URL` | Redis connection string | backend.yml |
| `PGBOUNCER_URL` | PgBouncer connection string | backend.yml |

**Category F — Storage**

| Secret Name | What It Is | Used In |
|-------------|-----------|---------|
| `B2_KEY_ID` | Backblaze B2 application key ID | backend.yml, backup.yml |
| `B2_APPLICATION_KEY` | Backblaze B2 application key | backend.yml, backup.yml |
| `B2_BUCKET_NAME` | Main media bucket name | backend.yml |
| `B2_VIEWONCE_BUCKET_NAME` | View-once media bucket name | backend.yml |

**Category G — Monitoring & Alerting**

| Secret Name | What It Is | Used In |
|-------------|-----------|---------|
| `SENTRY_DSN_BACKEND` | Sentry DSN for backend | backend.yml |
| `SENTRY_DSN_MOBILE` | Sentry DSN for mobile | android.yml |
| `SENTRY_DSN_WEB` | Sentry DSN for web | web.yml |
| `SENTRY_AUTH_TOKEN` | Sentry auth token for source map uploads | android.yml, web.yml |
| `GRAFANA_ADMIN_PASSWORD` | Grafana admin password | Set on VPS directly, not in Actions |

**Category H — Backup Encryption**

| Secret Name | What It Is | Used In |
|-------------|-----------|---------|
| `BACKUP_GPG_KEY` | GPG private key for backup encryption | backup.yml |
| `BACKUP_GPG_PASSPHRASE` | GPG key passphrase | backup.yml |

**Category I — Application Security**

| Secret Name | What It Is | Used In |
|-------------|-----------|---------|
| `JWT_SECRET` | App-level JWT signing secret (for any non-Firebase tokens) | backend.yml |
| `SHADOW_MASTER_KEY_SALT` | Salt for shadow thread ID derivation (server-side component) | backend.yml |
| `ENCRYPTION_KEY` | Server-side encryption key for metadata fields | backend.yml |

### 14.4 VPS Server Setup (One-Time, Done via SSH from Phone)

This is the only manual step in the entire workflow. Done once at project start via Termux SSH from phone.

```bash
# On VPS (Ubuntu 22.04)
# 1. Create deploy user (Actions SSH as this user, not root)
adduser deploy
usermod -aG sudo deploy
# Add GitHub Actions public key to deploy user's authorized_keys

# 2. Install Docker + Docker Compose
apt install docker.io docker-compose-plugin

# 3. Add deploy user to docker group
usermod -aG docker deploy

# 4. Install Caddy
apt install caddy

# 5. Clone repo
git clone https://github.com/your-org/chat-app.git /app

# 6. Copy .env files (one-time; all values come from GitHub Secrets in CI)
# On VPS, .env files are written by the deploy pipeline from GitHub Secrets

# 7. Sysctl tuning for WebSocket performance
echo "net.core.rmem_max=16777216" >> /etc/sysctl.conf
echo "net.core.wmem_max=16777216" >> /etc/sysctl.conf
echo "net.ipv4.tcp_nodelay=1" >> /etc/sysctl.conf
sysctl -p
```

After this one-time setup, all subsequent deployments are triggered by git push — zero SSH access needed.

### 14.5 Docker Compose on VPS

All services on the VPS run in Docker Compose. GitHub Actions deploys by SSH-ing in and running `docker compose up --build -d`.

```yaml
services:
  backend:
    build: ./apps/backend
    restart: always
    env_file: .env.backend
    ports: ["3000:3000", "3001:3001"]   # REST + WebSocket
    depends_on: [postgres, redis, pgbouncer]

  web:
    build: ./apps/web
    restart: always
    env_file: .env.web
    ports: ["3002:3000"]

  postgres:
    image: postgres:16-alpine
    restart: always
    volumes: ["pgdata:/var/lib/postgresql/data"]
    env_file: .env.postgres

  pgbouncer:
    image: pgbouncer/pgbouncer:latest
    restart: always
    env_file: .env.pgbouncer
    ports: ["5432:5432"]
    depends_on: [postgres]

  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --appendonly yes --appendfsync everysec
    volumes: ["redisdata:/data"]

  caddy:
    image: caddy:latest
    restart: always
    ports: ["80:80", "443:443"]
    volumes:
      - "./infra/caddy/Caddyfile:/etc/caddy/Caddyfile"
      - "caddy_data:/data"
    depends_on: [backend, web]

  prometheus:
    image: prom/prometheus:latest
    restart: always
    volumes: ["./infra/prometheus.yml:/etc/prometheus/prometheus.yml"]

  grafana:
    image: grafana/grafana:latest
    restart: always
    env_file: .env.grafana
    ports: ["3003:3000"]
    volumes: ["grafana_data:/var/lib/grafana"]
```

### 14.6 Day-to-Day Development Workflow (No PC)

```
Write code on phone → Termux (code editor: micro or vim) or GitHub web editor
         ↓
git add . && git commit -m "message" && git push
         ↓
GitHub Actions triggers automatically
         ↓
PR checks: lint + typecheck + tests (2–3 min)
         ↓
Merge to main → deploy pipeline runs (3–5 min for backend/web)
                                    (15–20 min for Android build)
         ↓
Health check confirms deploy success
         ↓
Done. App is live. No PC touched.
```

---

## 15. Firebase Authentication Integration

### 15.1 Auth Flows
- Phone OTP (primary): Firebase sends SMS OTP; token issued on verification.
- Email/password with email verification.
- Google Sign-In (OAuth via Firebase).

### 15.2 Backend Session Handling
- Firebase issues JWT (ID token) to client on auth.
- All API and WebSocket connections send token in `Authorization: Bearer` header.
- Backend verifies with Firebase Admin SDK. Result cached in Redis for token lifetime.
- Firebase UID is canonical user identifier throughout all backend services.

### 15.3 Device Registration Flow
1. User authenticates with Firebase → receives ID token.
2. App generates libsignal identity key pair + registration ID locally.
3. App sends `{ firebase_id_token, public_identity_key, signed_prekey_bundle, registration_id }` to `/api/devices/register`.
4. Backend verifies Firebase token, creates user record (if new), stores public key bundle.
5. App receives server-issued `device_id` for WebSocket identification.

---

## 16. Google Play Compliance & Positioning

This application is a **privacy and personal-data-protection messaging tool**. Every feature in this document exists to protect the lawful user's own data and communications from unauthorised physical access, coercion, shoulder-surfing, theft, and surveillance. No feature monitors, tracks, profiles, or deceives any third party. This section ensures the product is built and presented in a way that satisfies the Google Play Developer Program Policies.

> **Compliance principle:** Features are concealed from a thief, an abuser, or an attacker who seizes the user's unlocked device — never concealed from Google, and never from the user who configured them. Full, proactive disclosure to Google during review is mandatory (§16.5).

### 16.1 Intended Users & Threat Model
The app is built for people with a legitimate need for strong on-device privacy:
- Journalists and their sources.
- Human-rights workers, activists, and aid workers in hostile environments.
- Survivors of domestic abuse and coercive control.
- Lawyers, doctors, and others handling confidential client or patient information.
- Anyone protecting sensitive personal data if their device is lost, stolen, or inspected under duress.

Every concealment feature maps to a real-world theft or coercion threat — not to concealing activity from a partner, employer, or authority for dishonest purposes.

### 16.2 Positioning & Marketing Rules (Hard Requirements)
- Listing category: **Communication**, presented as a privacy & security messenger.
- Approved framing: "private messaging," "data protection under duress," "anti-theft privacy," "confidential communication."
- **Prohibited framing anywhere** — store listing, screenshots, in-app copy, alias examples, review notes, marketing: "hide from your partner/spouse," "cheat," "affair," "secret from [person]," or any wording implying deception of a specific individual.
- Alias and example naming throughout the product and these docs uses neutral, privacy-oriented words only (`/journal`, `/work`, `/private`, `/notes`). No relationship-implying examples.
- Duress and decoy features are always described as protection for at-risk users, never as tools to deceive another person.

### 16.3 Google Play Policy Compliance Mapping

| Google Play policy area | Relevant features | How we comply |
|--------------------------|-------------------|---------------|
| Deceptive Behavior — hidden/undocumented functionality | Hidden chats (§3), Shadow chats (§9), Decoy PIN (§6), `/alias` interception (§9.3) | All concealment features are documented to the user at setup and **fully disclosed to Google** via a reviewer demo account, review notes, and a public help page (§16.5). Concealed from device attackers only — never from Google. |
| Deceptive Behavior — misleading claims | Duress/decoy features | Marketed honestly as duress protection for at-risk users (§16.2). No claim implies deceiving a specific person. |
| User Data — Data Safety | Messaging, keys, metadata | Data Safety form answered honestly. E2E encryption declared. Data minimisation, no third-party data sharing (§16.7). |
| Permissions & APIs that Access Sensitive Information | Duress alert, contact discovery | No SMS, Call Log, Accessibility, or QUERY_ALL_PACKAGES. Duress alert sent over the app's own FCM/data channel (§16.4). Contacts hashed before upload. |
| Stalkerware / Surveillance | Duress alert, linked-device management | The app only ever protects or alerts on behalf of its **own** authenticated user. No feature monitors, tracks, or collects data about any other person without their knowledge. Does not meet the stalkerware definition. |
| Device & Network Abuse | Root detection, cert pinning | Defensive only. Warns the user; never exploits, roots, or modifies the device or other apps. |
| Background activity & data | Silent FCM, ephemeral segments | Background work limited to message delivery and the user's own configured duress alert. No undisclosed background collection. |
| Families policy | Audience | Rated for an appropriate mature audience; no content directed at children. |

### 16.4 Permissions Policy (Hard Requirements)
- **No SMS permission. No Call Log permission.** These are Restricted Permissions under Google Play; this app does not qualify for them and must never request them.
- **No Accessibility Service** repurposed for non-accessibility functionality.
- **No QUERY_ALL_PACKAGES.**
- Duress alerts, all notifications, and all message transport use the app's own encrypted FCM/data channel only.
- Every requested permission has a declared, user-facing purpose and a matching Data Safety entry. No undeclared permissions ship.
- Background location not requested. Linked-device IP geolocation (§10.6) is derived server-side from the connection IP, not from a device location permission, and is disclosed to the user.

### 16.5 Disclosure & Review Strategy (Hard Requirement)
Because the app contains intentionally concealed features, proactive disclosure to Google is mandatory to stay clear of the hidden-functionality policy:
- Provide a **reviewer demo account** with the real PIN, decoy PIN, a sample hidden-chat secret, and a sample shadow-chat alias + secret pre-configured.
- Include **review notes** explaining every concealment feature, its legitimate privacy purpose, and how to trigger it.
- Maintain a public **support/help page** documenting the privacy features, so they are demonstrably documented functionality rather than hidden behaviour.
- Keep an internal compliance record mapping each release's features to this §16 mapping.

### 16.6 Play Store Build Requirements (from day one)
- Privacy Policy URL live before submission, covering all data types, retention, and the duress/decoy features.
- Data Safety form answered honestly and kept in sync with every release.
- Target SDK: latest stable Android API level required by Google Play at submission time.
- 64-bit native libraries (required for libsignal native bindings).
- No undeclared permissions. No background data collection beyond stated purpose.
- `android:allowBackup="false"` in manifest (or per-component exclusion rules).
- Content rating questionnaire completed honestly.

### 16.7 Data Safety & Privacy Policy
- Declare that messages and media are end-to-end encrypted and the operator cannot read content.
- Declare every data type collected (account identifier, hashed phone number, device metadata) and its purpose.
- No data sold. No data shared with third parties for advertising.
- Document retention and deletion: account deletion purges within 30 days; ephemeral/self-destruct content is not retained server-side.
- Privacy policy explicitly explains the duress, decoy, and hidden-chat features in privacy terms.

### 16.8 India Compliance
- DPDP Act 2023: consent, breach notification within 72 hours, deletion on request.
- IT Rules 2021: traceability requirements at significant scale (>5M users). Design with that tension in mind before that scale; document it honestly.
- Not legal advice — engage a qualified lawyer experienced in Indian DPDP/IT Rules and app-store policy before Play Store submission.

---

## 17. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|-----------|
| R1 | Rolling own encryption | Med | Critical | Use libsignal. External audit before launch. |
| R2 | Backup leakage (hidden/shadow chats) | High | High | All sensitive chat types excluded from all backup channels. |
| R3 | Notification content leakage | High | High | Silent/data-only push for all sensitive message types. |
| R4 | Metadata not protected by E2E | High | High | Minimise and expire metadata. Honest user disclosure. |
| R5 | Single VPS — no HA | Med | High | Encrypted off-box backups daily. Documented restore drill. |
| R6 | Forgotten per-chat / shadow secret | Med | Med | No recovery by design. Disclosed at setup. |
| R7 | Alias in Android search autocomplete cache | High | High | Search bar interception at input layer before OS cache (§9.3). Hard build requirement. |
| R8 | Static identity code replayed | Resolved | — | TOTP + duress code (§4). Risk closed. |
| R9 | Play Store rejection | Med | High | Privacy/security framing only (§16.2). No deceptive descriptions. Full reviewer disclosure (§16.5). |
| R10 | DPDP / IT Rules compliance | Low now, Med at scale | High | Data minimisation from day one. |
| R11 | Spam, abuse, account takeover | Med | Med | Rate-limiting, device verification, in-app reporting. |
| R12 | Delete-on-exit hook failure | Resolved | — | Ephemeral-by-construction (§5.2). Risk closed. |
| R13 | Screenshots capture ephemeral / shadow content | High | Med | FLAG_SECURE. Honest expectations. |
| R14 | Recipient retains secret messages | Resolved | — | Shared ephemeral flag (§5.3). Risk closed. |
| R15 | Firebase Auth downtime | Low | High | Long-lived session tokens. Active sessions unaffected by short outages. |
| R16 | Multi-device E2E key desync | Med | High | Strict prekey validation. Key-change warnings to users. |
| R17 | Decoy PIN user confusion | Med | Med | Clear setup flow. Both PINs tested at setup. |
| R18 | Shadow chat setup asymmetry | Med | Med | Both parties must configure before shadow chat activates (§9.7). |
| R19 | WebSocket message loss on reconnect | Med | High | Sequence number gap detection + REST catch-up on reconnect (§12.6). |
| R20 | Redis failure → message routing outage | Low | High | Redis AOF persistence. Restart recovery < 30s. Monitor with alert. |
| R21 | GitHub Actions secret exposure in logs | Med | High | All secrets passed as env vars, never echoed. `--no-print-env` in all scripts. |
| R22 | Hidden-functionality policy strike (concealment features undisclosed) | Med | Critical | Proactive disclosure to Google: reviewer demo account, review notes, public help page (§16.5). |
| R23 | Rejection for restricted permissions | Low | High | No SMS / Call Log / Accessibility / QUERY_ALL_PACKAGES. Duress alert over own FCM channel only (§16.4). |
| R24 | Listing or marketing reads as deception tooling | Med | High | Enforced privacy-only framing and neutral alias examples (§16.2). No relationship-implying copy anywhere. |
| R25 | Misclassified as stalkerware | Low | Critical | App only acts on behalf of its own authenticated user; never monitors a third party (§16.3). |

---

## 18. Phased Build Roadmap

Every phase ships at production quality. No "clean this up later."

### Phase 0 — Infrastructure, CI/CD & Auth Foundation
- VPS provisioned (4vCPU/8GB). Ubuntu 22.04. Docker Compose running.
- Caddy TLS live. All subdomains resolving.
- PostgreSQL + PgBouncer + Redis deployed. Automated backup pipeline live.
- GitHub repository structure created. All GitHub Secrets classified and entered (§14.3).
- All 5 GitHub Actions pipelines created and tested.
- Firebase project created. Auth configured (phone OTP, email, Google).
- NestJS backend skeleton: Firebase token verification middleware, device registration endpoint.
- Prometheus + Grafana live. Sentry connected. Structured logging active.
- WebSocket connection established and health-checked end-to-end.
- **Nothing deployed to users yet.**

### Phase 1 — Core E2E Messaging
- libsignal integrated: prekey store on backend, client integration on mobile and web.
- 1:1 E2E messaging over WebSocket. Ciphertext only on server.
- Multi-device E2E key distribution (the hardest phase — weeks of work).
- Optimistic UI on mobile and web.
- Message sequence numbers + gap detection + reconnect catch-up.
- FCM push (silent push only).
- Delivery and read receipts.
- SQLCipher on mobile.
- **Internal testing only.**

### Phase 2 — Table-Stakes Completion
- Group messaging with E2E.
- Media (images, video, audio, files) via Backblaze B2 presigned URLs.
- Message reactions, reply/quote, edit, delete for everyone.
- Typing indicators (Redis TTL keys).
- Presence / last seen (toggleable).
- App PIN + biometric lock.
- Contact privacy-preserving discovery.
- Per-device push notification key — preview push for normal messages.
- Certificate pinning.
- Root detection.
- **Beta testing — small group of trusted users.**

### Phase 3 — Signature Features (in order)
1. Per-chat hidden chats — all §3.2 leak surfaces verified before shipping.
2. Decoy PIN / duress app state.
3. Self-destructing messages (BullMQ TTL worker).
4. View-once media.
5. Shadow chat + `/alias` command system — all §9.5 leak surfaces verified, search bar interception confirmed.
6. Ephemeral secret conversation segments (volatile key architecture).
7. In-chat identity verification (TOTP + duress code).
8. Contact verification (safety numbers + QR).
9. Linked device management.
10. 2FA for sensitive actions.
11. Private unread indicator for shadow chats.
12. Admin dashboard.

### Phase 4 — Hardening & Launch Prep
- External independent security audit. Mandatory before Play Store submission.
- Penetration test.
- Backup restore drill.
- Abuse controls and rate-limiting audit.
- Performance benchmark against §12.8 targets.
- Privacy Policy and Data Safety form finalised.
- Play Store submission.
- DPDP compliance review with qualified lawyer.

### Phase 5 — Post-Launch & Scale
- Second VPS node + load balancer (HA).
- CDN for media delivery.
- iOS build (React Native codebase already supports it).
- Advanced alerting (PagerDuty or equivalent).

---

## 19. Infrastructure & Cost Summary

### 19.1 Engineering Team
| Role | Scope |
|------|-------|
| Backend engineer | NestJS, PostgreSQL, Redis, libsignal prekey server, WebSockets, BullMQ, performance architecture |
| Mobile engineer | React Native (Expo), libsignal client, Firebase SDK, SQLCipher, Android |
| Frontend engineer | Next.js, WebSocket client, libsignal web |
| Security reviewer (external, Phase 4) | Protocol audit, pen test |

### 19.2 Monthly Running Costs
| Item | Cost |
|------|------|
| VPS 4vCPU/8GB (Hetzner CX41) | ~€15/month (~₹1,400) |
| Domain | ~₹1,000/year |
| Backblaze B2 storage | ~$6/TB/month |
| FCM | Free |
| Firebase Auth (phone OTP) | Free up to 10,000/month; $0.0055/auth beyond |
| Sentry | Free up to 5k errors/month |
| GitHub Actions | Free up to 2,000 min/month (public repo) or 3,000 min/month (Pro) |

### 19.3 Full Library & Service List
| Item | Purpose |
|------|---------|
| `libsignal-client` | Signal Protocol E2E encryption |
| `@nestjs/websockets` + `ws` | WebSocket server |
| `ioredis` | Redis client (NestJS) |
| `bullmq` | Job queue |
| `typeorm` | ORM + migrations |
| `pg` + PgBouncer | PostgreSQL client + connection pool |
| `@react-native-firebase/auth` | Firebase Auth on mobile |
| Firebase Admin SDK | Backend token verification |
| `react-native-ssl-pinning` | Certificate pinning |
| `react-native-keychain` | Secure key storage (Android Keystore) |
| SQLCipher (via `react-native-sqlcipher-storage`) | Encrypted local DB |
| Expo EAS Build | Android builds via GitHub Actions |
| `bcryptjs` | Per-chat and shadow secret hashing |
| `otplib` | TOTP for identity verification + 2FA |
| `rootbeer` (Android) | Root detection |
| Caddy | TLS + reverse proxy |
| Prometheus + Grafana | Metrics + dashboards |
| Sentry SDK | Error tracking |

---

*Document version 0.4 — Google Play compliance hardening: privacy threat model, policy compliance mapping, permissions policy, proactive reviewer-disclosure strategy, and neutral privacy-first framing throughout. All decisions confirmed or decided. Ready for Phase 0 kickoff.*
