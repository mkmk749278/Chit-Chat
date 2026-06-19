# Implementation Plan: Shadow Chat

## Overview

This plan implements the Shadow Chat feature **core-first**, exactly as mandated by the design's
"Out of Scope / Delivery Notes → Core-first sequencing": extend `content-payload` → build
`ShadowSequenceAllocator` → thread `threadId` through `messaging` → build `ConversationRegistry` →
**land the two-client end-to-end gate (`messaging-shadow-e2e.test.ts`)** → persist device-local
secrets (`ShadowSecretStore`) → and only after the gate passes, wire the UI alias interception and
default-view exclusion.

Everything is implemented in **TypeScript** inside the existing `@chat-app/crypto` shared pure core
(`packages/crypto/src`) plus the thin web (`apps/web`) and mobile (`apps/mobile`) adapters. The
existing pure crypto core (`shadow-chat.ts`, `secret-hash.ts`, `app-lock.ts`, `lockout-policy.ts`,
`content-payload.ts`, `conversation-reducer.ts`) is **reused without changing its cryptographic
semantics**; the only additive core change permitted is the optional `threadId` on
`content-payload.ts`. The server at `api.luminchat.app` is **frozen** — no wire/envelope/ack/codec
change is introduced anywhere.

Per cross-cutting **C3**, every pure-core unit is shipped with `fast-check` property tests running a
minimum of **100 iterations**, each referencing the design Correctness Property it validates.

> **The two-client e2e test (task 5.1) is the explicit GATE.** Per Requirement 10.7, NO UI work
> (tasks under epic 8) may begin until that gate passes.

## Tasks

- [x] 1. Extend `content-payload.ts` with an optional, backward-compatible `threadId`
  - [x] 1.1 Add optional `threadId` to encode/decode in `packages/crypto/src/content-payload.ts`
    - Add an optional `threadId?: string` parameter to `encodeContentPayload(payload, threadId?)`; when omitted, emit a byte-for-byte identical string to the current pre-shadow output.
    - Introduce `DecodedContentPayload { payload: ContentPayload; threadId?: string }` and change `decodeContentPayload` to return it, keeping decode **total** (never throws) and preserving all existing per-`type` validation verbatim.
    - Read `threadId` once at the envelope level: treat it as present only when `typeof env.threadId === 'string' && env.threadId.length > 0 && env.threadId.length <= 255`; otherwise report absent (surface).
    - Export the new type from `packages/crypto/src/index.ts`; do not alter `CONTENT_PAYLOAD_VERSION` or any `type`-specific schema.
    - _Requirements: 5.1, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x]* 1.2 Write unit tests for the `threadId` extension in `content-payload.test.ts`
    - Assert `encodeContentPayload(p)` (no threadId) equals the legacy string for representative payloads of every `type` (byte-for-byte, Property 6).
    - Assert round-trip recovery of payload + `threadId` for non-empty threadIds (1–255 chars), and `threadId === undefined` for omitted/empty/non-string/over-255 values that fall back to surface.
    - Assert per-`type` validation pass/fail outcome is identical whether or not `threadId` is present.
    - _Requirements: 5.1, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x]* 1.3 Write property test `content-payload-threadid.property.test.ts`
    - **Property 6: Surface backward-compatibility (byte-for-byte)** — for arbitrary payloads, `encodeContentPayload(payload)` matches the legacy encoder output.
    - **Property 7: Content-payload threadId round-trip + totality** — for arbitrary payloads and arbitrary non-empty threadIds, decode recovers both; and for arbitrary/fuzzed strings (including empty and max-length), `decodeContentPayload` returns a result and never throws.
    - Use `fast-check` with ≥100 iterations; report counterexamples on failure.
    - _Validates: Property 6, Property 7 / Requirements 5.1, 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 10.2, 10.3, 10.4_

- [x] 2. Implement `ShadowSequenceAllocator` (`+1e9` offset, per-thread contiguous counter)
  - [x] 2.1 Create `packages/crypto/src/shadow-sequence-allocator.ts`
    - Export `SHADOW_SEQ_OFFSET = 1_000_000_000`.
    - Implement `ShadowSequenceAllocator implements SequenceAllocator` constructed with `(keyStore: KeyStore, threadId: string)`; `next(recipientUid)` keys the dedicated counter `shadow:${threadId}` via `KeyStore.nextSeq` (ignoring `recipientUid`) and returns `SHADOW_SEQ_OFFSET + n`, where the first issued value is `SHADOW_SEQ_OFFSET + 1`.
    - Guarantee strict +1 contiguity per thread; on any KeyStore read/persist failure, do not consume a counter value and propagate an allocation error (fail without creating a gap).
    - Export from `packages/crypto/src/index.ts`; reuse the existing `KeyStore` port unchanged (no new port).
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 9.3_

  - [x]* 2.2 Write unit tests in `shadow-sequence-allocator.test.ts`
    - Verify first allocation is `SHADOW_SEQ_OFFSET + 1`, successive values increase by exactly 1, independence from `recipientUid`, persistence across allocator instances (shared fake `KeyStore`), and error propagation with no counter consumption on a failing `KeyStore`.
    - _Requirements: 4.1, 4.2, 4.5, 4.6, 9.3_

  - [x]* 2.3 Write property test `shadow-sequence-allocator.property.test.ts`
    - **Property 2: Surface/shadow sequence disjointness** — every allocated shadow seq is `>= SHADOW_SEQ_OFFSET`, so it never collides with any surface seq `< SHADOW_SEQ_OFFSET` in `${recipientUid}:${seq}` / `${direction}:${seq}` key spaces.
    - **Property 3: Shadow sequence contiguity within a thread** — for arbitrary call counts and arbitrary recipient UIDs, allocations for one thread yield `1e9+1, 1e9+2, …` strictly increasing by 1.
    - Use `fast-check` with ≥100 iterations.
    - _Validates: Property 2, Property 3 / Requirements 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 3. Thread `threadId` routing through `messaging.ts` (surface path unchanged when absent)
  - [x] 3.1 Extend outbound `send` and `SendOptions` in `packages/crypto/src/messaging.ts`
    - Add optional `threadId` to `SendOptions`; when present, select `ShadowSequenceAllocator(keyStore, threadId)` (seq `>=1e9`), else the existing surface allocator (seq `<1e9`).
    - Call `encodeContentPayload({ type:'text', body, … }, threadId)` so `threadId` rides inside the encrypted body; build the `CiphertextEnvelope` exactly as today (only `seq` differs) and assert the serialized envelope carries no `threadId` and no plaintext field.
    - Keep the pending/ack key `${recipientUid}:${seq}` (disjoint across surface/shadow by construction); tag the emitted optimistic `ConversationEvent` with `threadId`.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 4.4, 5.2_

  - [x] 3.2 Route inbound `onEnvelope` and add `threadId` to react/edit/delete/timer in `messaging.ts`
    - In `onEnvelope`, consume `{ payload, threadId }` from `decodeContentPayload`; when `threadId` is present, tag all emitted events with it (seq is `envelope.seq`, already `>=1e9`) and preserve the existing `targetOutbound`→local-direction flip for reaction/edit/delete `targetSeq`.
    - Add optional `{ threadId }` to `react`, `editMessage`, `deleteMessage`, and `setDisappearingTimer` so those operations stay scoped to their thread; when `threadId` is absent the inbound/outbound path is byte-for-byte the current surface behaviour and creates no shadow state.
    - _Requirements: 3.1, 3.4, 5.2, 7.2, 7.3, 7.7_

  - [x]* 3.3 Write unit tests for messaging routing in `messaging.test.ts`
    - Assert a surface send/receive (no `threadId`) is observationally identical to current behaviour (ordering, delivery/read transitions, rendered content) and produces no shadow state.
    - Assert a shadow send produces an envelope with seq `>=1e9`, no `threadId`/plaintext on the wire, correct ack matching, and `threadId`-tagged events; assert react/edit/delete/timer carry the `threadId` through.
    - _Requirements: 3.1, 3.2, 3.4, 3.6, 4.4, 5.2, 7.2, 7.3, 7.7_

- [x] 4. Implement `ConversationRegistry` (per-thread state, reusing the pure reducer)
  - [x] 4.1 Create `packages/crypto/src/conversation-registry.ts`
    - Define `ConversationKey` (`{ kind:'surface'; remoteUid }` | `{ kind:'shadow'; threadId; peerUid }`) and a `Map<string, ConversationState>` keyed `surface:${remoteUid}` / `shadow:${threadId}`; dispatch each event through the **existing unchanged `reduce`** so gap detection (`computeMissingBefore`) is per-thread.
    - Implement `apply(event)` (route by tagged `threadId`/`remoteUid`), `getState(key)` (create empty on first access), `listSurfaceConversations()` (surface only — zero shadow entries), and `isNotifiable(event)` (false for shadow).
    - Reject an inbound event whose `threadId` has no existing shadow `ConversationState`: leave all states unmodified and surface an unknown-thread error.
    - Export from `index.ts`; do not modify `conversation-reducer.ts`.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_

  - [x]* 4.2 Write unit tests in `conversation-registry.test.ts`
    - Assert one state instance per key, surface/shadow events route to disjoint instances, `listSurfaceConversations` excludes shadow, `isNotifiable` is false for shadow, per-thread gap detection, and unknown-thread rejection leaves all states unchanged.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_

  - [x]* 4.3 Write property test `conversation-registry.property.test.ts`
    - **Property 8: Thread isolation (no cross-thread bleed)** — for arbitrary interleavings of surface/shadow message, reaction, edit, delete, and timer events, the surface and shadow `ConversationState`s share no message/reaction/edit/delete/timer, and an event tagged with a `threadId` affects only that thread.
    - Use `fast-check` with ≥100 iterations.
    - _Validates: Property 8 / Requirements 7.2, 7.3, 7.4_

- [x] 5. Two-client end-to-end test — **GATING DELIVERABLE (blocks all UI work, Req 10.7)**
  - [x] 5.1 Create `packages/crypto/src/messaging-shadow-e2e.test.ts` (mirrors `messaging-e2e.test.ts`) — **THIS IS THE GATE; tasks under epic 8 (UI) MUST NOT begin until this passes**
    - Wire two `DefaultMessaging` instances (A and B) over the in-memory transport with real libsignal sessions, sharing one shadow `masterSecret`; assert both independently derive the **same** `threadId` (Property 1).
    - Exchange ≥10 surface and ≥10 shadow messages with ≥1 of each in both directions; assert each client's surface and shadow `ConversationState` contain only their own messages with disjoint seq ranges (`<1e9` vs `>=1e9`) (Properties 2, 8).
    - Apply a reaction and a disappearing-timer in the shadow thread; assert they do not appear in the surface thread and vice-versa (Property 8); induce a gap per thread and assert `missingBefore` is computed per thread (Property 3).
    - Capture every transport frame and assert **no `threadId` and no plaintext ever appear on the wire**, and that a shadow envelope and a surface envelope expose an identical field-name set, identical field count, identical field types, and identical field ordering (Property 5, C1).
    - _Validates: Property 1, Property 2, Property 3, Property 5, Property 8 / Requirements 2.1, 2.2, 2.3, 3.2, 4.3, 10.5, 10.6, 10.7_

  - [x]* 5.2 Write property test for thread-id derivation referencing existing `shadow-chat.ts`
    - **Property 1: Deterministic, symmetric thread id (no handshake)** — for arbitrary non-empty `masterSecret` and uids `a`,`b`: `deriveShadowThreadId(secret,a,b) === deriveShadowThreadId(secret,b,a)`, stable across calls, 64-char lowercase hex; distinct master secrets yield different ids; empty secret / empty / identical uids reject.
    - Use `fast-check` with ≥100 iterations; reuse `shadow-chat.ts` unchanged.
    - _Validates: Property 1 / Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 6. Checkpoint — core pure-logic + e2e gate complete
  - Ensure all tests pass (content-payload, allocator, messaging, registry, and the e2e gate), ask the user if questions arise. Do not proceed to UI work until the e2e gate (5.1) is green.

- [x] 7. Implement `ShadowSecretStore` (device-local secrets + alias mappings, real-PIN gated)
  - [x] 7.1 Create `packages/crypto/src/shadow-secret-store.ts`
    - Implement `getShadowContext(mode)` returning `{ masterSecret, aliasKey }` only when `mode === 'real'`, else `null`; `listAliasEntries(mode)` returning stored entries only in `real`, else `[]`; and `putAlias(entry)` persisting only the `aliasHash` (HMAC via existing `hashAlias`) + `ref { peerUid, threadId }` — never the plaintext/normalised alias.
    - Persist master secret, aliasKey, and alias entries strictly through the existing encrypted `KeyStore`; never transmit them to any network endpoint. Provide a binding helper that derives `threadId` via `deriveShadowThreadId` and stores the `AliasEntry` (real mode only).
    - Fail closed: on any `KeyStore` error in real mode, release no context and no entries (return `null`/`[]`) and surface a persistence error; on a failed write, abort leaving no partial/plaintext data. Reuse `app-lock.ts` `AppMode`/`resolveAppMode` unchanged.
    - Export from `index.ts`.
    - _Requirements: 1.7, 1.8, 8.2, 8.3, 8.5, 8.7, 9.1, 9.2, 9.4, 9.5, 9.6, 9.7_

  - [x]* 7.2 Write unit tests in `shadow-secret-store.test.ts`
    - Assert real-mode release of context/entries; decoy/null modes return `null`/`[]`; hash-only persistence (no plaintext alias anywhere); fail-closed on KeyStore error in real mode; aborted write leaves nothing persisted.
    - _Requirements: 8.2, 8.3, 8.5, 8.7, 9.1, 9.2, 9.4, 9.6, 9.7_

  - [x]* 7.3 Write property test `shadow-secret-store.property.test.ts` — decoy reveals nothing
    - **Property 10: Decoy mode reveals nothing** — for any state entered with `mode === 'decoy'` or `null`, `getShadowContext` returns `null` and `listAliasEntries` returns `[]`, so no threadId can be derived and no alias resolves; results are observationally identical between decoy and null.
    - Use `fast-check` with ≥100 iterations.
    - _Validates: Property 10 / Requirements 8.2, 8.3, 8.6_

  - [x]* 7.4 Write property test for alias hashing/matching referencing existing `shadow-chat.ts`
    - **Property 9: Alias plaintext is never persisted** — for arbitrary aliases/keys, the only stored representation is the HMAC `aliasHash`; the normalised/plaintext alias never appears in any persisted structure.
    - **Property 4: Alias indistinguishability** — for arbitrary key, entry set, and input that is either an invalid alias or whose hash is absent, `matchAlias` returns `null`, scanning every entry (non-short-circuiting).
    - Use `fast-check` with ≥100 iterations; reuse `shadow-chat.ts` unchanged.
    - _Validates: Property 9, Property 4 / Requirements 1.4, 1.6, 9.2_

- [ ] 8. UI alias interception and default-view exclusion — **ONLY AFTER the e2e gate (5.1) passes**
  - [ ] 8.1 Web search-bar alias interception in `apps/web`
    - In the chat search-bar adapter, call `isAliasInput`; resolve via `matchAlias` using `ShadowSecretStore.listAliasEntries`/`getShadowContext` only when `AppMode === 'real'`; on a match open the shadow thread (via `ConversationRegistry`) within 1 second; on no match / invalid alias / non-real mode fall through to ordinary search with identical observable behaviour and timing (no shadow-specific result, hint, or error).
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 8.1, 8.4, 8.6_

  - [ ] 8.2 Mobile search-bar alias interception in `apps/mobile`
    - Implement the same alias-interception adapter on mobile, calling the identical shared pure-core path (`isAliasInput`/`matchAlias`/`ShadowSecretStore`) so web and mobile resolve through one path (C2); decoy/null modes never resolve and render exactly like the standard search field.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 8.1, 8.4, 8.6_

  - [ ] 8.3 Exclude shadow threads from chat list, notifications, and previews (web + mobile)
    - Drive the default chat list from `ConversationRegistry.listSurfaceConversations()` and gate notifications/previews on `isNotifiable(event)` so `threadId`-tagged events produce no OS/in-app notification, chat-list entry, or preview on either platform.
    - _Requirements: 7.5, 7.6, 8.3_

  - [ ]* 8.4 Write UI/adapter tests for interception and exclusion (web + mobile)
    - Assert `/alias` opens the correct shadow thread in real mode; wrong/non-existent alias and decoy mode are indistinguishable from a normal search (within the 50 ms timing bound); shadow threads never appear in chat list, notifications, or previews.
    - _Requirements: 1.3, 1.4, 1.5, 7.5, 7.6, 8.3, 8.4_

- [ ] 9. Validate CI and the Android build (delivery)
  - [ ] 9.1 Validate CI green and the Android build (install the Android SDK, run the Android + backend/web CI workflows) so the work can land in single PRs
    - Run the workspace test suite and the `.github/workflows` Android/web/backend pipelines locally; fix any build/test breakage introduced by the shadow-chat changes. This is a delivery/CI task and does not block the core implementation.
    - _Requirements: 10.1_

- [ ] 10. Final checkpoint — full feature verification
  - Ensure all unit, property (≥100 iterations each), and the e2e gate tests pass, and CI/Android build is green; ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation and the gating e2e test (5.1) are never optional.
- Each task references the specific requirement clauses and design Correctness Properties it implements for full traceability.
- **Core-first ordering is mandatory:** content-payload → allocator → messaging → registry → **e2e gate** → secret store → UI. The e2e test (5.1) is the explicit gate that blocks all UI work (epic 8) per Requirement 10.7.
- The existing pure crypto core (`shadow-chat.ts`, `secret-hash.ts`, `app-lock.ts`, `lockout-policy.ts`, `conversation-reducer.ts`) is reused unchanged; only the additive optional `threadId` on `content-payload.ts` is permitted. No server, wire-envelope, ack-format, or codec change is introduced.
- Property tests use `fast-check` (≥100 iterations) and each references the Correctness Property it validates, reporting counterexamples on failure (Req 10.3, 10.4).
- All 10 requirements and all 10 correctness properties are covered: P1→5.2/5.1, P2→2.3/5.1, P3→2.3/5.1, P4→7.4, P5→3.1/5.1, P6→1.3, P7→1.3, P8→4.3/5.1, P9→7.4, P10→7.3.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "5.2", "9.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.2", "2.3", "3.1"] },
    { "id": 2, "tasks": ["3.2"] },
    { "id": 3, "tasks": ["3.3", "4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3"] },
    { "id": 5, "tasks": ["5.1"] },
    { "id": 6, "tasks": ["7.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "7.4"] },
    { "id": 8, "tasks": ["8.1", "8.2"] },
    { "id": 9, "tasks": ["8.3"] },
    { "id": 10, "tasks": ["8.4"] }
  ]
}
```
