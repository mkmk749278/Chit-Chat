# Wave 3 Design — Multi-Device Sync (Requirement 9)

Status: **DESIGN — review required before any implementation** (per the Wave 3 gate in
`tasks.md`). This document fulfils task 9.0. It changes the trust model, so it must pass a
security review before code lands.

## 1. Problem & current state

Phase 1 models **one device per user**. Concretely:

- `devices` is keyed by `(user_id, registration_id)`, but the client only ever has one.
- `PreKeyClaimService.resolveDevice` deliberately claims the **most recently registered**
  device (`createdAt DESC`) as a band-aid for identity churn — a documented hack.
- Stale `devices` rows are **never cleaned up**: reinstalls/regenerations accumulate rows
  forever, and "newest" can point at a device that isn't the live one.
- The whole "undecryptable message" bug class (fixed in Phase 1 by durable identity, guarded
  by the relaunch regression test) stems from this single-device + newest-device fragility.

Goal: replace the heuristic single-device model with an explicit **multi-device** model where a
user's account is a *set* of active devices, each with its own libsignal identity, and a message
is delivered to and decryptable by **all** of them.

### Goals
- A user may have N active devices; a 1:1 message is readable on every active device of both
  participants (Req 9.3).
- Adding a device is **authenticated by an existing device** without exposing private keys to
  the server (Req 9.2).
- Removing a device **revokes** its ability to read future messages (Req 9.4).
- Retire the `createdAt DESC` claim hack and add stale-row cleanup.

### Non-goals (this design)
- Group chat (separate design, Req 10).
- History transfer to a freshly linked device (out of scope v1; a new device starts seeing
  messages from link time forward — documented limitation).
- Cross-device read-receipt/typing sync beyond message delivery.

## 2. Model

- **Per-device identity.** Each device keeps its own libsignal identity (as today). A *user* is
  the set `{deviceId → public identity + prekeys}` of its **active** devices.
- **Per-(uid, deviceId) sessions.** The shared core already addresses sessions by
  `SignalAddress = { uid, deviceId }` and the store keys by `uid:deviceId`. So the crypto core
  needs little change; the orchestration (fan-out) and the backend (multi-device claim/registry)
  are where the work is.
- **Pairwise fan-out (chosen for 1:1).** To send one plaintext to a recipient with devices
  `[d1..dn]` and given the sender has its own other devices `[s2..sm]`, the sender encrypts the
  message **separately to each** of those `n + (m-1)` device sessions and emits one envelope per
  device. Rationale: 1:1 device counts are small; pairwise reuses the existing Double Ratchet
  per device with no new crypto (sender-keys are reserved for groups, Req 10). Self-fan-out to
  the sender's *other* devices is how those devices render the user's own sent messages.

## 3. Backend changes

### 3.1 Device registry
- Add `devices.state` (`active` | `revoked`) and `devices.last_seen_at`.
- `PreKeyClaimService`: **retire `createdAt DESC`.** `GET /api/keys/:uid` returns a bundle for
  **every `active` device** of the user (an array), each atomically consuming one of *that
  device's* one-time prekeys (the existing `FOR UPDATE SKIP LOCKED` logic, per device).
  - Response shape changes from one `ClaimedPreKeyBundle` to `{ devices: ClaimedPreKeyBundle[] }`
    (versioned; see §6 migration).
- Stale-row cleanup: a scheduled job (or lazy-on-claim) prunes devices `revoked` or
  `last_seen_at` older than a TTL (e.g. 90 days). `last_seen_at` is updated on WS handshake.

### 3.2 Delivery fan-out
- `MessageRelayService.relay` already fans an envelope to the recipient's live nodes via
  `presence:{uid}` (a hash of `{connId → nodeId}` across **all** the user's devices/connections).
  With per-device envelopes, the relay routes each envelope by `recipientUid` as today; each of
  the recipient's connected devices receives the envelopes addressed to it (a device ignores an
  envelope whose `recipientDeviceId` is not its own — add `recipientDeviceId` to the envelope
  routing metadata, NOT the encrypted body).
- Offline queue: keyed per `(uid, deviceId)` so a device that was offline gets exactly its
  envelopes on reconnect.

### 3.3 Device linking & authentication (Req 9.2)
Two candidate mechanisms; **recommend (A)** for v1:

- **(A) Account-mediated linking (simplest, no QR).** A new device authenticates with Firebase
  (same account) and registers itself (`POST /api/devices/register`) → becomes an `active`
  device. Existing devices are **notified** (a `device-added` control event) and surface it in a
  "your account was added on a new device" UI (a security signal, like Signal's "new linked
  device"). Trust is account-level (whoever controls the Firebase account). No private-key
  transfer. Pairs naturally with the existing phone-OTP auth.
- **(B) Device-authorized linking (stronger, later).** The new device shows a QR; an existing
  device scans it and signs an authorization, so adding a device requires possession of an
  existing device, not just the account. Higher friction; defer to v2.

Either way **private keys never leave a device** — each device generates its own identity; there
is no key export (Req 9.2).

## 4. Client (shared core) changes

- **`Messaging.send` fan-out.** Resolve the recipient's device list (claim → cache) AND the
  sender's own other devices; for each target device with no session, establish one from its
  bundle; encrypt the content payload per device; emit one envelope per device with
  `recipientDeviceId` set. Ack tracking keys on `(recipientUid, deviceId, seq)`.
- **`onEnvelope`** is largely unchanged (decrypt by `senderUid:senderDeviceId`), plus: ignore an
  envelope whose `recipientDeviceId` ≠ this device. Self-sync envelopes (from the user's own
  other device) render as **outbound** on this device.
- **Device-list cache + invalidation.** Cache the recipient's device set; invalidate on a
  `device-added`/`device-revoked` signal or a decrypt failure that suggests a changed set
  (then re-claim). A message to a device whose session is stale triggers a re-claim + re-encrypt.
- **Safety numbers (Req 1) become per-device.** The verification UI lists each peer device's
  number (or a combined fingerprint over the sorted set of the peer's identity keys). A
  `device-added` on the peer surfaces a "new device, please re-verify" prompt — the multi-device
  analogue of the "safety number changed" warning.

## 5. Revocation (Req 9.4)
- A user revokes a device → `devices.state = revoked`. It is excluded from future claims and
  fan-out, dropped from `presence`, and its WS connection is closed. Peers learn via
  `device-revoked` and drop that device's session. The revoked device cannot decrypt **future**
  messages (it no longer receives envelopes and its prekeys are no longer served); already-
  delivered messages on it are out of scope (local wipe is a separate "remote logout" feature).

## 6. Migration & backward compatibility
- The prekey-claim response shape changes (single bundle → array). Version it: keep
  `GET /api/keys/:uid` returning the legacy single bundle, add `GET /api/keys/:uid/devices`
  returning the array; old clients keep working against the legacy route during rollout, new
  clients use the array route. Retire the legacy route once clients update.
- Existing single-device users: their one device is simply the only `active` device — no data
  migration beyond backfilling `state='active'` and `last_seen_at`.

## 7. Security review checklist (must pass before code)
- [ ] Adding a device cannot be done by the server or a network attacker — only the account
      holder (A) or an existing device (B).
- [ ] No path exports or transfers a private key between devices or to the server.
- [ ] A revoked device provably stops receiving envelopes and its prekeys stop being served.
- [ ] Per-device safety numbers + a "new device" prompt make a silently-added device detectable.
- [ ] Fan-out never places plaintext on the wire (each envelope is independently E2E-encrypted).
- [ ] Device-list cache invalidation can't be abused to downgrade/drop a recipient device
      (fail closed: if the device set is uncertain, re-claim rather than skip a device).

## 8. Phased task breakdown (fills task 9.1 once approved)
1. Backend: `devices.state` + `last_seen_at` migration; update `last_seen_at` on WS handshake.
2. Backend: multi-device prekey claim (`/devices` array route) + per-device offline queue +
   `recipientDeviceId` routing metadata; retire `createdAt DESC`; stale-row cleanup job.
3. Core: `Messaging` per-device fan-out (recipient devices + sender self-devices), ack keyed per
   device, device-list cache + invalidation.
4. Core/client: `device-added`/`device-revoked` control events + per-device safety numbers.
5. Linking (A): new-device registration → active; notify existing devices; revoke flow + UI.
6. Tests: two-users-each-two-devices E2E (message readable on all 4); revoked device stops
   decrypting; new device sees messages from link time; relaunch regression still holds.

## 9. Open questions for review
- Cap on devices per user? (Signal allows a small N.)
- `last_seen` TTL for auto-pruning vs. explicit revoke only?
- Do we need history transfer to a new device in v1, or is "from link time forward" acceptable?
- Linking mechanism: ship (A) account-mediated first, or invest in (B) device-authorized now?
