# Signature Feature 7 — Dual-Layer Shadow Chat with `/alias` Command System

> Design, threat model, and implementation plan. Source of truth: `private-chat-app-requirements.md` §9.
>
> **Status**
> - ✅ **Cryptographic core** — shipped + tested (`packages/crypto/src/shadow-chat.ts`).
> - 🟡 **Dual-thread messaging core** — *in progress in this work stream*: thread-aware
>   send/receive in `packages/crypto/src/messaging.ts` + `content-payload.ts`, proven by a
>   two-client e2e test. **Server-blind by construction** (see §5).
> - ⬜ **Client UX** — search-bar `/alias` interception, setup flow, private unread indicator,
>   decoy-mode suppression, isolated persistence. Follow-up (see §7).

## 1. Problem

Even a hidden chat (§3) leaves the *contact* visible — anyone can open contacts, find the person,
and see (or infer) the conversation. A shadow chat solves the contact layer: each contact can have a
completely independent, invisible parallel thread — separate history, separate sequence space,
separate timers/reactions — reachable only by typing a private `/alias` in the search bar
(§9.1, §9.2). The surface chat stays innocent and fully usable.

## 2. Cryptographic core — shipped + tested

`packages/crypto/src/shadow-chat.ts`:

- **Server-opaque thread id** (§9.4) — both parties derive it identically, client-side, with no
  server involvement:

  ```
  shadow_thread_id = HMAC-SHA256(key = shadow_master_secret,
                                 data = canonical_sort(uidA, uidB) + "shadow")
  ```

  `canonicalSortUids` joins with a separator so distinct uid pairs can't collide by concatenation,
  and is order-independent so both peers converge regardless of who is "A".

- **`/alias` grammar** (§9.3) — `isAliasInput` (the `/`-prefix interception trigger) and
  `normalizeAlias` (must start with `/`, case-insensitive, ASCII-alphanumeric only, no spaces).

- **Local-only alias storage** (§9.3) — `hashAlias` stores aliases as an HMAC hash under a
  device-local key, never plaintext; `matchAlias` resolves a typed input to its shadow chat and
  returns the matched entry only. A wrong alias and a non-existent alias yield the identical `null`,
  so the app never confirms an alias exists (§9.3 "what an observer sees" table). Independent
  per-alias hashes ⇒ knowing one alias reveals nothing about others (compartmentalisation).

All functions are pure WebCrypto, shipped byte-for-byte to web + mobile; the master secret and alias
key are device-local and never reach the server (§9.3, §9.4). Covered by `shadow-chat.test.ts`.

## 3. The hard constraint that shapes everything

**The deployed backend at `api.luminchat.app` runs the old code and cannot be redeployed for this
feature.** Therefore the shadow design must **not** change the wire envelope or the server's ack
format — otherwise shadow messages break against the live relay.

Verified in the repo (these are the only seq-related behaviours the relay has, so the design below
is safe against the live server):

- `apps/backend/src/messaging/message-relay.service.ts` accepts any `seq` that is a non-negative
  integer (`Number.isInteger(seq) && seq >= 0`) — **no monotonic / ordering / gap enforcement**.
- `apps/backend/src/realtime/realtime.gateway.ts` acks by **echoing back** `recipientUid` + `seq`.

So the relay treats `seq` as an opaque number and routes purely by `recipientUid`. We exploit this.

## 4. Dual-layer model (§9.2)

| Layer | On the wire | On device |
|---|---|---|
| **Surface chat** | envelope addressed to peer uid; `seq` 1,2,3… | conversation key = bare peer uid |
| **Shadow chat** | envelope addressed to the **same** peer uid; `seq` in a disjoint band | conversation key = `shadowConversationId(peerUid, threadId)` |

The two layers share **only** the peer's Firebase uid. The server sees one stream of messages
between two users and cannot tell which are shadow. The split is entirely client-side.

## 5. Server-blind messaging design (the chosen approach)

This **supersedes** the earlier "add a `threadId` to the envelope + relay routing" sketch, which is
impossible under the no-redeploy constraint (§3). Two mechanisms keep the threads separate without
touching the wire:

### 5.1 `threadId` rides *inside* the encrypted payload (§9.4)

`packages/crypto/src/content-payload.ts`:

- `encodeContentPayload(payload, threadId?)` — when `threadId` is present, it is added as a
  top-level field of the versioned `{ v:1, … }` envelope **before encryption**. The libsignal
  ciphertext (and thus the wire `CiphertextEnvelope`) is unchanged in shape; the server stays blind.
  When `threadId` is absent the serialized bytes are **identical** to a pre-shadow message — a
  surface message must look exactly like every other message on the wire.
- `decodeContentEnvelope(raw) → { payload, threadId }` — total and backward-compatible. A legacy
  bare-string plaintext, or any non-`{v:1}` payload, yields `threadId: null`. The existing
  `decodeContentPayload` keeps its exact signature/behaviour so nothing else changes.

### 5.2 Shadow sequence numbers live in a disjoint numeric band

`packages/crypto/src/shadow-chat.ts` exports `SHADOW_SEQ_OFFSET = 1_000_000_000`. The `Messaging`
orchestrator allocates each thread's `seq` from a counter keyed by the **conversation id**, then
lifts a shadow thread's value by the offset. This gives three guarantees at once on the *same*
on-wire `(sender, recipient)` pair, with no envelope change:

1. **No ack collision** — a shadow `seq` (≥ 1e9) never equals a surface `seq` (< 1e9), so an echoed
   ack `(recipientUid, seq)` resolves exactly the right pending send.
2. **Contiguity within the thread** — the offset is constant, so shadow seqs stay 1e9+1, 1e9+2, …
   and gap detection works there exactly as on the surface.
3. **No cross-contamination** — a reaction/edit/delete/timer that targets a shadow `seq` can never
   match a surface message (and vice-versa).

Headroom: a billion surface messages before the bands could meet — far beyond any 1:1 chat — and
`OFFSET + n` stays well inside `Number.MAX_SAFE_INTEGER`.

### 5.3 "Virtual conversation id" routes everything else

`shadowConversationId(peerUid, threadId)` (and its `isShadowConversationId` / `parse…` inverse) build
an **on-device-only** conversation key, tagged with a NUL-delimited marker that can't appear in a uid
or hex thread id. `Messaging` uses this key for:

- message-row `remoteUid`, so shadow history is stored separately from surface history;
- the per-conversation `seq` counter (§5.2);
- the disappearing-message timer map and expiry tracking (a shadow timer is independent of the
  surface timer for the same peer);
- every emitted `ConversationEvent.remoteUid`, so status/reaction/edit/delete/timer/expiry events
  land on the correct thread.

The wire envelope is still addressed to the **bare peer uid**; only the `recipientUid` echoed in the
ack is used (with `seq`) to match a pending send, so the conv id never needs to be on the wire.

**Net effect:** surface code paths are byte-for-byte unchanged (`threadId` undefined ⇒
`conv === peerUid`), and **no shared type, reducer, store port, or the wire protocol changed.** The
entire integration is localised to `messaging.ts` + `content-payload.ts` + helpers in `shadow-chat.ts`.

### 5.4 Public API (additive, backward-compatible)

- `Messaging.send(peerUid, text, { threadId })` — omit `threadId` for surface (unchanged).
- `react` / `editMessage` / `deleteMessage` / `setDisappearingTimer` gain an optional trailing
  `threadId?: string`. The target `seq` for shadow control messages is already the shadow-band seq.

## 6. Invariants the two-client e2e test must prove

`packages/crypto/src/messaging-shadow-e2e.test.ts` (two `DefaultMessaging` instances over an
in-memory relay, real puretsignal sessions):

1. A surface message and a shadow message sent to the same peer land in **two different conversation
   keys** on the receiver; neither leaks into the other's history.
2. Surface seqs are 1,2,…; shadow seqs are `OFFSET+1, OFFSET+2, …` (contiguous, disjoint band).
3. Both sends are acked and reach `sent` with **no cross-resolution** (offset prevents collision).
4. The `threadId` (and shadow plaintext) **never appear in cleartext on the wire** — assert the
   serialized frames contain neither the thread-id hex nor the shadow message text.
5. A shadow reaction applies to the shadow message only and does not touch the surface thread.

## 7. Remaining work (client UX — follow-up, gated by security review)

These build on the messaging core above and do **not** require backend changes:

1. **Search-bar `/alias` interception** (§9.3, hard requirement) — intercept `/`-prefixed input at
   the lowest input layer, clear the field immediately so nothing reaches OS search/autocomplete
   history, route through `matchAlias`; wrong-secret and no-alias are identical "No results".
2. **Setup flow** (§9.7) — long-press chat header → neutral overlay → set alias + shadow secret
   (both stored as hashes); bootstrap the shadow thread; activates only once both parties set up.
3. **Private unread indicator** (§9.6) — subtle neutral in-app hint after real-PIN unlock; no text,
   no count, hidden in decoy mode.
4. **Leak-surface hardening** (§9.5) — shadow excluded from chat list, search index, presence,
   notifications (silent/data-only), media gallery, backups; FLAG_SECURE (shared with §3).
5. **Decoy-mode suppression** (§6) — shadow chats never appear in decoy state.
6. **Isolated persistence** — shadow rows/sessions in a secret-gated vault partition; the
   `shadowConversationId` key already keeps them logically separate in the store today.

## 8. Verification & CI note

This repo follows decision **D13** (zero-PC; all builds via GitHub Actions). The development sandbox
runs **offline** (no npm registry / Google access), so dependency install, the Android SDK, and the
full local test run are not available there. The authoritative checks — `backend.yml`, `web.yml`,
`android.yml`, `pr.yml` — run on the pull request via GitHub Actions, which is the source of truth
for "CI green". Local work is verified by code review + the e2e test design above, and confirmed by
those workflows on the PR.

## 9. Relation to Feature 1 (Hidden Chats, §9.8)

Different threat models, simultaneously active:

| Feature | Threat model | What it hides |
|---|---|---|
| Hidden chat (§3) | Someone browsing the chat list | The entire thread disappears from the list |
| Shadow chat (§9) | Someone who knows you talk to this contact and checks directly | A parallel secret thread; the surface chat stays visible and innocent |
