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

- [x] 8. UI alias interception and default-view exclusion — **ONLY AFTER the e2e gate (5.1) passes**
  - [x] 8.1 Web search-bar alias interception in `apps/web`
    - In the chat search-bar adapter, call `isAliasInput`; resolve via `matchAlias` using `ShadowSecretStore.listAliasEntries`/`getShadowContext` only when `AppMode === 'real'`; on a match open the shadow thread (via `ConversationRegistry`) within 1 second; on no match / invalid alias / non-real mode fall through to ordinary search with identical observable behaviour and timing (no shadow-specific result, hint, or error).
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 8.1, 8.4, 8.6_

  - [x] 8.2 Mobile search-bar alias interception in `apps/mobile`
    - Implement the same alias-interception adapter on mobile, calling the identical shared pure-core path (`isAliasInput`/`matchAlias`/`ShadowSecretStore`) so web and mobile resolve through one path (C2); decoy/null modes never resolve and render exactly like the standard search field.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 8.1, 8.4, 8.6_

  - [x] 8.3 Exclude shadow threads from chat list, notifications, and previews (web + mobile)
    - Drive the default chat list from `ConversationRegistry.listSurfaceConversations()` and gate notifications/previews on `isNotifiable(event)` so `threadId`-tagged events produce no OS/in-app notification, chat-list entry, or preview on either platform.
    - _Requirements: 7.5, 7.6, 8.3_

  - [x]* 8.4 Write UI/adapter tests for interception and exclusion (web + mobile)
    - Assert `/alias` opens the correct shadow thread in real mode; wrong/non-existent alias and decoy mode are indistinguishable from a normal search (within the 50 ms timing bound); shadow threads never appear in chat list, notifications, or previews.
    - _Requirements: 1.3, 1.4, 1.5, 7.5, 7.6, 8.3, 8.4_

  > **Task 8 implementation note (cross-cutting C2).** The `/alias` decision logic was extracted into
  > a single shared pure helper `packages/crypto/src/shadow-search.ts` — `resolveSearchInput(text,
  > mode, store)` returning a discriminated `{ kind: 'shadow', threadId, peerUid } | { kind: 'search',
  > query }`, plus `createShadowSearchHandler(...)` which adds the one shared side-effect
  > (`registry.openShadowThread`). Both `apps/web/app/lib/shadow-search.ts` and
  > `apps/mobile/src/app/shadow-search.ts` construct that IDENTICAL handler, so web and mobile resolve
  > through ONE path. Shipped with `shadow-search.test.ts` (unit) + `shadow-search.property.test.ts`
  > (property, ≥100 runs) in the crypto core, web vitest tests, and a mobile `node --test` adapter
  > test (incl. a property). Web adds a real `ChatSearchBar` component; mobile wires the handler into
  > the existing chat-list search bar ahead of hidden-chat reveal, threading the shadow `threadId`
  > through `controller.send` (additive — `Messaging` already supports it; no wire/port change) and
  > excluding shadow threads from the chat list/contacts/notifications.
  >
  > **Remaining follow-ups (not blockers for task 8):** durable encrypted-`KeyStore` binding of
  > `ShadowSecretPersistence` and the alias-PROVISIONING/binding UI are out of task 8's scope (and the
  > task-8 constraint forbids changing the `KeyStore` port), so until aliases are provisioned every
  > `/alias` correctly falls through to an ordinary search, indistinguishably. The web app does not yet
  > ship a full chat-list/conversation shell, so its search bar + exclusion helpers are wired at the
  > lib/component boundary and verified by vitest. Mobile UI wiring is verified by `tsc --noEmit`
  > (no React Native unit-test runner is configured in this repo).

- [x] 9. Validate CI and the Android build (delivery)
  - [x] 9.1 Validate CI green and the Android build (install the Android SDK, run the Android + backend/web CI workflows) so the work can land in single PRs
    - Run the workspace test suite and the `.github/workflows` Android/web/backend pipelines locally; fix any build/test breakage introduced by the shadow-chat changes. This is a delivery/CI task and does not block the core implementation.
    - **Local CI-parity validation results (all CI-feasible jobs reproduced from the repo root):**
      - `@chat-app/crypto` — `build:packages` ✅ + full `node --test` suite ✅ **373/373 pass** (incl. shadow-search unit + property tests).
      - web (`apps/web`, web.yml gate) — `next lint` ✅, `tsc --noEmit` ✅, `vitest run` ✅ **11/11 pass** (incl. `shadow-search.test.ts`), `next build` ✅ (the `fs`-module warning from the libsignal dep is pre-existing and unrelated to shadow-chat).
      - backend (`apps/backend`, backend.yml gate) — lint (no script → `--if-present` skip) ✅, `tsc` build ✅, jest ✅ **99/99 pass, 17 suites** (no external DB/Firebase needed — tests use mocks). Backend was untouched by shadow-chat; confirmed no incidental breakage.
      - mobile (`apps/mobile`, validated via pr.yml's workspace fan-out) — `tsc --noEmit` typecheck ✅, `tsc -p tsconfig.test.json && node --test` ✅ **15/15 pass** (incl. mobile shadow-search adapter unit + property tests).
      - Aggregate pr.yml gates — `lint --workspaces` ✅, `typecheck --workspaces` ✅ (all 6 workspaces).
    - **Android native build — DEFERRED to GitHub Actions CI on the PR (best-effort done locally):** no Android SDK is installed in this sandbox, the native project is not committed (it is generated by `expo prebuild`), and the signed `build-android` job is itself gated on signing secrets (`ANDROID_KEYSTORE_BASE64`) so it is SKIPPED/green in CI until release setup. The mobile shadow-chat changes are pure TypeScript (`App.tsx`, `chat-controller.ts`, `shadow-search.ts`) and are fully covered locally by the mobile typecheck + `node --test` runs above. Native APK/AAB assembly is validated by the `android` workflow on the PR.
    - No regressions were introduced by the shadow-chat changes; no fixes were required.
    - _Requirements: 10.1_

- [x] 10. Final checkpoint — full feature verification
  - All unit, property (≥100 iterations each), and the gating e2e test (5.1) pass; local CI-parity is green for every feasible job (crypto, web, backend, mobile). Android native APK/AAB assembly is deferred to GitHub Actions CI on the PR (no local Android SDK; build job gated on signing secrets), as documented in task 9.1.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation and the gating e2e test (5.1) are never optional.
- Each task references the specific requirement clauses and design Correctness Properties it implements for full traceability.
- **Core-first ordering is mandatory:** content-payload → allocator → messaging → registry → **e2e gate** → secret store → UI. The e2e test (5.1) is the explicit gate that blocks all UI work (epic 8) per Requirement 10.7.
- The existing pure crypto core (`shadow-chat.ts`, `secret-hash.ts`, `app-lock.ts`, `lockout-policy.ts`, `conversation-reducer.ts`) is reused unchanged; only the additive optional `threadId` on `content-payload.ts` is permitted. No server, wire-envelope, ack-format, or codec change is introduced.
- Property tests use `fast-check` (≥100 iterations) and each references the Correctness Property it validates, reporting counterexamples on failure (Req 10.3, 10.4).
- All 10 requirements and all 10 correctness properties are covered: P1→5.2/5.1, P2→2.3/5.1, P3→2.3/5.1, P4→7.4, P5→3.1/5.1, P6→1.3, P7→1.3, P8→4.3/5.1, P9→7.4, P10→7.3.

## Task Dependency Graph (Completed Baseline — historical)

> This graph scheduled the now-completed baseline (tasks 1–10, all `[x]`). It is preserved for
> traceability. The **active** scheduling graph for the remaining (incomplete) work is the
> `## Task Dependency Graph` section at the very end of this file, which covers only the Full-Vision
> Delta tasks (epics 11–18).

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

---

# Full-Vision Delta — Implementation Plan

## Completed baseline (done)

Epics 1–10 above are **COMPLETE and green** (`[x]`) and MUST NOT be re-done. They shipped: the
additive `content-payload` `threadId`, `ShadowSequenceAllocator` (`+1e9`), `messaging.ts` `threadId`
routing, `ConversationRegistry`, the two-client e2e gate (`messaging-shadow-e2e.test.ts`),
`ShadowSecretStore` (`getShadowContext` / `listAliasEntries` / `bindAlias` single-thread-per-pair),
and the shared `shadow-search.ts` `/alias` interception wired on web + mobile with chat-list /
notification / preview exclusion.

Two gaps the baseline explicitly deferred — and that this delta closes — are: (1) the
alias-**provisioning / binding UI** was never built, so today every `/alias` correctly falls through
to ordinary search; and (2) `ShadowSecretPersistence` was effectively in-memory / unprovisioned, so
nothing survived restart.

## Delta overview

This section implements the **full-vision evolution** documented in design.md's
"Design Update — Full-Vision Evolution" and codified by requirements.md Requirements 1.7, 2.7–2.12,
9.8–9.9, 11, and 12. All work stays in **TypeScript** (the design specifies concrete TS interfaces,
not pseudocode) inside the existing `@chat-app/crypto` pure core (`packages/crypto/src`) plus the
thin `apps/web` and `apps/mobile` adapters.

The **frozen-server / no-wire-change** constraint is preserved everywhere: the alias-discriminated
`threadId` still rides only inside the encrypted content payload, sequence offsets are unchanged, and
no `CiphertextEnvelope` / ack / codec field changes (Req 3, Property 5). The only permitted core
deltas are the **optional alias discriminator** on `deriveShadowThreadId` (the reviewed cryptographic
deviation, Component 1) and the additive `setThreadPin` / `pinVerifier` on the store — the
`KeyStore` / `ShadowSecretPersistence` / messaging ports keep their shapes.

Per cross-cutting **C3**, every new pure-core unit ships `fast-check` property tests running a
minimum of **100 iterations**, each referencing the design Correctness Property it validates.
Production-grade: no scaffolds, no stubs, no placeholders — every task is fully buildable.

## Tasks

- [ ] 11. Alias-discriminated thread-id derivation (pure core, reviewed deviation)
  - [ ] 11.1 Extend `deriveShadowThreadId` with the optional alias discriminator in `packages/crypto/src/shadow-chat.ts`
    - Add the optional 4th parameter to `deriveShadowThreadId(masterSecret, uidA, uidB, alias?)`. When a grammatically valid `alias` is supplied, the HMAC-SHA256 input becomes `canonicalSortUids(uidA, uidB) + "shadow" + 0x1f + normalizeAlias(alias)` (ASCII Unit Separator `0x1f`); when `alias` is omitted/empty, emit the **byte-for-byte legacy** input `canonicalSortUids(uidA, uidB) + "shadow"` (no migration).
    - Validate the alias via the existing `normalizeAlias`; throw an invalid-input error when a supplied alias is not grammatically valid (mirrors the existing empty-secret / empty-or-identical-uid throws). Keep output a 64-char lowercase hex string; keep derivation deterministic and symmetric (order-independent) with or without the alias.
    - Do not change `canonicalSortUids`, `normalizeAlias`, `hashAlias`, `matchAlias`, or the space separator (changing it would re-key every existing thread id).
    - _Requirements: 1.7, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12_

  - [ ]* 11.2 Extend the derivation property test `packages/crypto/src/shadow-chat-derivation.property.test.ts`
    - **Property 1 (UPDATED): Deterministic, symmetric, alias-discriminated thread id** — for arbitrary non-empty `masterSecret`, uids `a`,`b`, and arbitrary optional valid alias `s`: `derive(secret,a,b,s) === derive(secret,b,a,s)`, stable across calls; distinct master secrets yield distinct ids.
    - **Property 1b: Alias-discrimination collision-resistance + legacy compatibility** — for distinct valid aliases `s1 ≠ s2`, `derive(...,s1) !== derive(...,s2)`; `derive(...)` with the alias omitted equals the **byte-for-byte legacy** id; a discriminated id is never equal to any legacy id (the `0x1f` separator is disjoint from normalized-alias and uid charsets).
    - Use `fast-check` with ≥100 iterations; report counterexamples on failure.
    - _Validates: Property 1, Property 1b / Requirements 1.7, 2.7, 2.8, 2.9, 2.10, 2.11, 10.1, 10.3, 10.4_

  - [ ]* 11.3 Extend unit tests in `packages/crypto/src/shadow-chat.test.ts`
    - Assert a representative discriminated id equals the expected HMAC over `…"shadow" + 0x1f + alias`; assert omitted-alias output equals the pre-existing legacy id constant; assert an invalid alias discriminator throws; assert symmetry/determinism with the alias present.
    - _Requirements: 2.7, 2.9, 2.12_

- [ ] 12. Durable encrypted persistence for `ShadowSecretPersistence`
  - [ ] 12.1 Implement the durable SQLCipher-backed adapter on mobile in `apps/mobile`
    - Implement a concrete `ShadowSecretPersistence` (the unchanged narrow port from `shadow-secret-store.ts`) bound to the **existing encrypted on-device vault** — the same SQLCipher database and key the mobile `KeyStore` already uses — persisting the master secret, the alias key, and the full `AliasEntry<ShadowThreadRef>` set (including each optional `pinVerifier`).
    - Make `saveAliasEntry` / `saveMasterSecret` / `saveAliasKey` **atomic** (all-or-nothing) so an aborted write leaves no partial or plaintext data (Req 9.7); never write to any unencrypted location (Req 9.5); never transmit secrets off-device (Req 9.1, C1). Wire the adapter into the mobile boot path so the `ShadowSecretStore` is provisioned from durable state on launch.
    - _Requirements: 9.1, 9.5, 9.7, 9.8, 9.9_

  - [ ] 12.2 Implement the in-memory (session) adapter on web in `apps/web`
    - Implement the same `ShadowSecretPersistence` port as an in-memory Map-backed adapter (matching the baseline "in-memory on web" constraint), persisting master secret, alias key, and the `AliasEntry` set incl. `pinVerifier` for the session; same atomic-write contract on the write paths. Wire it into the web app boot path.
    - _Requirements: 9.5, 9.8, 9.9_

  - [ ]* 12.3 Write durable-persistence tests (core + adapter)
    - **Property 12: Durable persistence round-trip** — for arbitrary master secret, alias key, and bound `AliasEntry` set persisted in `real` mode, a fresh `ShadowSecretStore` reading the same durable persistence (post-restart) recovers identical secrets and the identical entry set incl. each `pinVerifier`; a `/alias` that resolved before a simulated restart still resolves after. Use `fast-check` ≥100 iterations against a durable fake `ShadowSecretPersistence`.
    - Assert fail-closed on write error: a failing `saveAliasEntry` causes the binding write path to abort (propagate) leaving nothing persisted (Req 9.7); add a mobile-adapter atomicity check that a mid-write failure persists no partial row.
    - _Validates: Property 12 / Requirements 9.7, 9.8, 9.9_

- [ ] 13. `ShadowSecretStore` — alias-discriminated `bindAlias` + `setThreadPin` (optional per-chat PIN)
  - [ ] 13.1 Update `bindAlias` to be alias-discriminated and PIN-aware in `packages/crypto/src/shadow-secret-store.ts`
    - Change the signature to `bindAlias(mode, alias, peerUid, myUid, pin?)`. In `real` mode only: derive the **alias-discriminated** `threadId` via `deriveShadowThreadId(masterSecret, myUid, peerUid, alias)`; compute `aliasHash` via `hashAlias`; when a non-empty `pin` is supplied, hash it via `secret-hash.hashSecret` (run **off the UI thread** through an injected `Pbkdf2Provider` seam added to the store) and set `ref.pinVerifier`; persist exactly **one** hash-only `AliasEntry` durably. Never store the plaintext/normalised alias or the plaintext PIN; return `null` (persisting nothing) in any non-real mode; abort (propagate) on any persistence error.
    - Thread the injected hasher/`Pbkdf2Provider` through `ShadowSecretStoreOptions` (additive, no port-shape change); keep the existing fail-closed read-path semantics intact.
    - _Requirements: 1.8, 9.9, 11.6, 12.5, 12.6_

  - [ ] 13.2 Add `setThreadPin(mode, threadId, newPin)` to `packages/crypto/src/shadow-secret-store.ts`
    - In `real` mode only: locate the `AliasEntry` whose `ref.threadId` matches; when `newPin` is a non-empty string, hash it off-thread via `secret-hash.hashSecret` and write `ref.pinVerifier`; when `newPin` is `null`, clear `ref.pinVerifier` (set to `undefined`). Persist the updated entry durably and hash-only (plaintext PIN never stored, never transmitted). Return the updated `ShadowThreadRef`, or `null` (no-op, persisting nothing) in any non-real mode. Abort (propagate) on persistence error.
    - _Requirements: 12.5, 12.6, 12.7, 12.8_

  - [ ]* 13.3 Extend store property + unit tests (`shadow-secret-store.property.test.ts`, `shadow-secret-store.test.ts`)
    - **Property 11: Per-chat PIN gating incl. later set/change/remove** — absent `pinVerifier` ⇒ no PIN required; present ⇒ opens iff `verifySecret(pin, ref.pinVerifier)`; after `setThreadPin('real', threadId, newPin)` the next gating reflects the new state (non-empty ⇒ requires PIN; `null` ⇒ opens directly); the stored representation is only the PBKDF2 verifier (no plaintext PIN anywhere); in any non-real mode `setThreadPin` is a no-op.
    - **Property 13: Creation-flow inertness under decoy/locked** — for `mode !== 'real'`, `bindAlias` returns `null` and persists nothing and `setThreadPin` is a `null` no-op; decoy and `null` are observationally identical.
    - Confirm **Property 9** (alias plaintext never persisted) and **Property 10** (decoy reveals nothing) still hold for the new code paths. Assert the PIN hash runs through the injected off-thread `Pbkdf2Provider` seam. Use `fast-check` ≥100 iterations.
    - _Validates: Property 9, Property 10, Property 11, Property 13 / Requirements 9.9, 12.5, 12.6, 12.8_

- [ ] 14. Per-chat PIN re-entry in the shared search resolver
  - [ ] 14.1 Extend the shared resolve path in `packages/crypto/src/shadow-search.ts`
    - On an alias match in `real` mode, branch on `ref.pinVerifier`: when present, require an off-thread `verifySecret(pin, ref.pinVerifier)` (wrapped in the existing `runBusy` / `submitGate` busy pattern so a spinner shows and submit is disabled while verifying) before `openShadowThread`; when absent, open directly. A wrong PIN yields a **generic failure** with no shadow-specific signal and does not open the thread. Keep web + mobile on the **one shared handler** (C2) by extending `createShadowSearchHandler` rather than forking per platform.
    - _Requirements: 12.2, 12.3, 12.4, 12.7_

  - [ ]* 14.2 Extend `shadow-search.test.ts` / `shadow-search.property.test.ts`
    - Assert: a PIN-set alias prompts and opens iff `verifySecret` returns true; a no-PIN alias opens directly without prompting; a wrong PIN returns a generic failure (indistinguishable from other failures) and does not open; verification runs through the injected off-thread provider. Property coverage references Property 11. Use `fast-check` ≥100 iterations for the property portion.
    - _Validates: Property 11 / Requirements 12.2, 12.3, 12.4, 12.7_

- [ ] 15. Long-press shadow-chat creation UI (web + mobile) — the missing provisioning piece
  - [ ] 15.1 Mobile long-press overlay menu + creation sheet in `apps/mobile`
    - Add a press-and-hold handler on a chat-list row (`src/ui/ChatsListScreen.tsx`) AND a contact / new-chat row (`src/ui/NewChatScreen.tsx`) that opens an overlay menu rendered through a React Native **`Modal` portal** (the same primitive `SheetModal` in `src/ui/action-sheet.tsx` uses) at top z-order — NOT an absolutely-positioned row sibling. Include a **"Shadow chat"** action **only when `App_Mode === 'real'`** (absent in decoy/`null`).
    - Build the creation sheet: an **alias** field (must start with `/`, normalised/validated inline via `normalizeAlias`, refuses invalid) + an **optional PIN** field (blank by default, skippable). On confirm → `ShadowSecretStore.bindAlias('real', alias, peerUid, myUid, pin?)` → `ConversationRegistry.openShadowThread(threadId, peerUid)` → dismiss. Perform no send, advance no surface sequence, mutate no surface `ConversationState` or list entry. Keep the created thread hidden (re-enter only via `/alias`).
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10_

  - [ ] 15.2 Web long-press overlay menu + creation sheet in `apps/web`
    - Implement the equivalent top-layer overlay (a portal-rendered overlay above all chat-list / conversation content) and creation sheet on web (`apps/web/app/components`), wired to the **same** `bindAlias` + `ConversationRegistry.openShadowThread` path so `/alias` now resolves to a real bound thread end-to-end. Same real-mode-only gating, inline alias validation, optional-PIN field, and surface non-disturbance as mobile.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10_

  - [ ]* 15.3 Write creation-UI adapter tests (web + mobile)
    - Assert per platform: the "Shadow chat" action appears only in `real` mode (absent under decoy/`null`); an invalid alias is rejected and binds nothing; creation leaves the surface chat untouched (no send, no surface seq advance, no surface state mutation); the overlay renders through the top-level portal (z-order assertion). References Property 13 and Property 1b.
    - _Validates: Property 13, Property 1b / Requirements 11.2, 11.3, 11.5, 11.7, 11.8, 11.10_

- [ ] 16. Per-chat PIN settings (add / change / remove later) UI (web + mobile)
  - [ ] 16.1 Mobile shadow-chat settings/options action in `apps/mobile`
    - Add a shadow-chat settings/options action (reachable from within an open shadow thread, e.g. `src/ui/ConversationScreen.tsx`) that calls `ShadowSecretStore.setThreadPin(mode, threadId, newPin | null)` to add, change, or remove the per-chat PIN later. Not shown in any non-`real` mode. Run the PBKDF2 work off the UI thread with a progress indicator (`runBusy` / `async-submit.ts`).
    - _Requirements: 12.5, 12.7, 12.8_

  - [ ] 16.2 Web shadow-chat settings/options action in `apps/web`
    - Implement the equivalent per-chat PIN settings action on web (`apps/web/app/components/ConversationScreen.tsx`) calling `setThreadPin` for add/change/remove; hidden in non-`real` mode; off-thread with a spinner.
    - _Requirements: 12.5, 12.7, 12.8_

  - [ ]* 16.3 Write PIN-settings adapter tests (web + mobile)
    - Assert: the settings entry point is present only in `real` mode (absent under decoy/`null`, Property 13); set / change / remove each call `setThreadPin` with the right argument (non-empty vs `null`); the operation runs off-thread and shows the in-flight indicator. References Property 11.
    - _Validates: Property 11, Property 13 / Requirements 12.5, 12.7, 12.8_

- [ ] 17. UI bug fixes (independent of shadow-chat correctness properties)

  > These two tasks are tracked here because they ship in this delivery, but they are **NOT part of
  > the shadow-chat acceptance criteria or correctness properties** (design.md "Out of Scope" lists
  > both as separate fixes). They reference no shadow requirement clause or Property.

  - [ ] 17.1 Fix status-bar / notch overlap on mobile in `apps/mobile`
    - Apply a global safe-area / insets fix (`SafeAreaView` / `useSafeAreaInsets` from `react-native-safe-area-context`) across the app shell and screen headers so content and headers no longer render under the status bar / notch.
    - _UI bug fix — independent of shadow-chat correctness properties._

  - [ ] 17.2 Fix the `⋮` overflow menu drawing behind messages in `apps/mobile`
    - Re-render the conversation `⋮` overflow menu through a top-level `Modal` portal (the same modal-portal approach as the new long-press overlay) so it draws **above** the message list instead of behind message bubbles; fix its z-order/elevation.
    - _UI bug fix — independent of shadow-chat correctness properties._

  - [ ]* 17.3 Add a regression check for the `⋮` overflow-menu z-order
    - Add an adapter/regression test asserting the overflow menu mounts at the top overlay layer (portal) and is not an absolutely-positioned sibling of message rows.
    - _UI bug fix — independent of shadow-chat correctness properties._

- [ ] 18. Integration, durable e2e coverage, and CI / delivery
  - [ ] 18.1 Extend the two-client e2e in `packages/crypto/src/messaging-shadow-e2e.test.ts`
    - Add coverage proving an alias bound through the new creation path (`bindAlias` with an alias discriminator) resolves to the same shadow thread **after a simulated restart** (fresh store over the same durable persistence, Property 12); that an alias-discriminated thread stays **isolated** from the surface chat and from other shadow threads of the same contact (Property 8); and that it remains **wire-blind** — no `threadId` and no plaintext on the wire, envelope shape identical to surface (Property 5, C1). Keep the existing baseline e2e assertions intact.
    - _Validates: Property 5, Property 8, Property 12 / Requirements 9.8, 10.5, 10.6_

  - [x] 18.2 Run the workspace test suite + web / backend / mobile CI-parity gates and land in PRs
    - Run the full `@chat-app/crypto` `node --test` suite (incl. all new property tests at ≥100 iterations), the web gate (`next lint`, `tsc --noEmit`, `vitest run`, `next build`), the backend gate (`tsc`, jest), and the mobile gate (`tsc --noEmit`, `tsc -p tsconfig.test.json && node --test`) from `.github/workflows`. Fix any breakage introduced by the delta; document the results in the PR description; push branches and open PRs for review.
    - **Full-vision delta CI-parity results (run from the repo root, mirroring `.github/workflows`; build shared packages first):**
      - shared packages — `npm run build:packages` ✅ (`@chat-app/types`, `@chat-app/crypto`, `@chat-app/ui` all compile; dist refreshed before downstream gates).
      - `@chat-app/crypto` — `npm test` (`tsc -p tsconfig.json && node --test dist/*.test.js`) ✅ **418/418 pass, 0 fail** (incl. the alias-discriminated derivation property tests, durable-persistence Property 12, per-chat-PIN Property 11, decoy Property 10/13, and the extended two-client e2e in `messaging-shadow-e2e.test.ts`).
      - web (`apps/web`, web.yml gate) — `next lint` ✅ (no warnings/errors), `tsc --noEmit` ✅, `vitest run` ✅ **46/46 pass, 6 files** (incl. `shadow-search`, `shadow-creation`, `shadow-secret-persistence`, `ShadowPinSettings`), `next build` ✅ (the `fs`-module warning from the `@privacyresearch` libsignal dep is pre-existing and unrelated to shadow-chat).
      - backend (`apps/backend`, backend.yml gate) — `tsc` build ✅, jest ✅ **99/99 pass, 17 suites** (no external DB/Firebase needed — tests use mocks). Backend untouched by the delta; confirmed no incidental breakage.
      - mobile (`apps/mobile`, validated via pr.yml's workspace fan-out) — `tsc --noEmit` typecheck ✅, `tsc -p tsconfig.test.json && node --test` ✅ **47/47 pass** (incl. shadow creation-UI, PIN-settings UI, overflow-menu z-order regression, and the mobile shadow-search adapter unit + property tests).
      - aggregate pr.yml gates — `lint --workspaces --if-present` ✅, `typecheck --workspaces --if-present` ✅ (all 6 workspaces), `build --workspaces --if-present` ✅.
    - **Android native build — DEFERRED to GitHub Actions CI on the PR:** no Android SDK is installed in this sandbox, the native project is not committed (it is generated by `expo prebuild`), and the signed `build-android` job is itself gated on signing secrets (`ANDROID_KEYSTORE_BASE64`), so it is SKIPPED/green in CI until release setup. The mobile delta changes are pure TypeScript and are fully covered locally by the mobile typecheck + `node --test` runs above; native APK/AAB assembly is validated by the `android` workflow on the PR.
    - **No integration breakage was introduced by combining epics 11–18; no fixes were required.** Changes committed to branch `spec/shadow-chat-full-vision-impl` (push handled by the platform).
    - _Requirements: 10.1_

  - [x] 18.3 Final checkpoint — full-vision delta verification
    - All unit, property (≥100 iterations each), and the extended two-client e2e tests pass, and every feasible CI-parity job is green (crypto 418/418, web 46/46 + lint/typecheck/next build, backend 99/99 + tsc, mobile 47/47 + typecheck; aggregate lint/typecheck/build across all 6 workspaces). Android native APK/AAB assembly is deferred to GitHub Actions CI on the PR (no local Android SDK; build job gated on signing secrets), as documented in task 18.2.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core
  implementation tasks (and the durable e2e in 18.1) are never optional.
- Each delta task references the specific requirement clauses and design Correctness Properties it
  implements for full traceability.
- **Frozen server / no wire change is preserved:** the alias-discriminated `threadId` and the
  per-chat `pinVerifier` live only inside the encrypted body or device-local encrypted vault; no
  `CiphertextEnvelope` / ack / codec field changes (Req 3, Property 5).
- The only permitted core deltas are the optional alias discriminator on `deriveShadowThreadId`
  (Component 1's reviewed deviation) and the additive `setThreadPin` / `pinVerifier` + injected
  off-thread `Pbkdf2Provider` seam on `ShadowSecretStore`. Port shapes (`KeyStore`,
  `ShadowSecretPersistence`, messaging) are unchanged.
- Property tests use `fast-check` (≥100 iterations) and each references the Correctness Property it
  validates, reporting counterexamples on failure (Req 10.3, 10.4).
- Delta property/requirement coverage: P1/P1b→11.2; P9/P10/P11/P13→13.3; P11→14.2, 16.3; P12→12.3,
  18.1; P13/P1b→15.3; P5/P8/P12→18.1. Requirements 1.7, 2.7–2.12, 9.8–9.9, 11.1–11.10, 12.1–12.8 are
  all covered by epics 11–18.
- Epic 17 (UI bug fixes) is independent of shadow-chat correctness and references no shadow Property.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["11.1", "12.1", "12.2", "17.1", "17.2"] },
    { "id": 1, "tasks": ["11.2", "11.3", "12.3", "13.1", "17.3"] },
    { "id": 2, "tasks": ["13.2", "14.1", "15.1", "15.2"] },
    { "id": 3, "tasks": ["13.3", "14.2", "15.3", "16.1", "16.2"] },
    { "id": 4, "tasks": ["16.3", "18.1"] },
    { "id": 5, "tasks": ["18.2"] }
  ]
}
```
