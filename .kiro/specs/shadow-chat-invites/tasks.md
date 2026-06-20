# Implementation Plan: Shadow Chat Invites

## Overview

This plan implements **Shadow Chat Invites** **core-first**, in the dependency order the design's
Components and Dependencies sections mandate: extend `content-payload.ts` with the four additive
shadow control types → extend `ShadowSecretStore` (invited-thread binding + clear/revoke + the
additive local-only atomic delete on `ShadowSecretPersistence`) → add the device-local
**row↔thread association** that makes per-`threadId` history purges possible → extend
`ConversationRegistry` (recipient routing override + clear/close) → build the new
`ShadowInviteCoordinator` (invite / accept / decline / revoke lifecycle, pre-accept queue,
auto-cleanup) → intercept the four control types in `messaging.ts` → **land the two-client
end-to-end gate (`messaging-shadow-invites-e2e.test.ts`) that provisions DISTINCT master secrets per
client** → and only after the gate passes, wire the web + mobile UI adapters (long-press invite,
request card, routing sheet, pending view, settings Clear/Revoke).

Everything is implemented in **TypeScript** inside the existing `@chat-app/crypto` shared pure core
(`packages/crypto/src`) plus the thin web (`apps/web`) and mobile (`apps/mobile`) adapters. This
feature **evolves** the shipped Shadow Chat: `shadow-chat.ts` (`deriveShadowThreadId`,
`canonicalSortUids`, `normalizeAlias`, `hashAlias`, `matchAlias`), `app-lock.ts`, `secret-hash.ts`,
the `+1e9` `ShadowSequenceAllocator`, and the `KeyStore.purgeMessages` primitive are **reused
without changing their semantics**. The only additive core changes permitted are: four discriminated
variants on `content-payload.ts`, additive methods on `ShadowSecretStore` / `ConversationRegistry` /
the narrow `ShadowSecretPersistence` port, a new `ShadowInviteCoordinator` module, and the
verification-style interception seam in `messaging.ts`. The server at `api.luminchat.app` is
**frozen** — no wire/envelope/ack/codec change is introduced anywhere; every new behaviour rides
inside the existing `CiphertextEnvelope`.

Per the design's Testing Strategy, every pure-core unit is shipped with `fast-check` property tests
running a minimum of **100 iterations**, each referencing the design Correctness Property (1–18) it
validates.

> **The two-client e2e test (task 8.1) is the explicit GATE.** It provisions **two independently
> provisioned stores with DIFFERENT device-local master secrets** — the opposite of the shipped
> harness that injected one shared secret and masked the convergence bug. **No UI work (epics 10–11)
> may begin until that gate passes** and proves Accept symmetry (Property 3).

## Tasks

- [ ] 1. Extend `content-payload.ts` with the four additive shadow control types
  - [ ] 1.1 Add `shadow-invite` / `shadow-accept` / `shadow-decline` / `shadow-revoke` variants in `packages/crypto/src/content-payload.ts`
    - Add four additive discriminated variants to `ContentPayload`, modelled on the existing `verify-request` / `verify-response` / `verify-result` control variants: `{ type:'shadow-invite'; inviteId; key; label? }`, `{ type:'shadow-accept'; inviteId }`, `{ type:'shadow-decline'; inviteId }`, `{ type:'shadow-revoke'; inviteId; threadId }`.
    - Do **not** change `CONTENT_PAYLOAD_VERSION` or alter any existing variant; keep encoding additive and decoding **total** (never throws), so a peer that predates the feature decodes all four to `{ type:'unsupported' }`.
    - Export any new types through `packages/crypto/src/index.ts`.
    - _Requirements: 9.5, 11.3, 12.1_

  - [ ] 1.2 Add per-type validation to `decodeEnvelopePayload`
    - `shadow-invite`: `inviteId` non-empty string **and** `key` a base64 string that decodes to **exactly 32 bytes**; `label` optional string; else `{ type:'unsupported' }`.
    - `shadow-accept` / `shadow-decline`: `inviteId` non-empty string; else `{ type:'unsupported' }`.
    - `shadow-revoke`: `inviteId` non-empty string **and** `threadId` a 1..255-char string (reuse the codec's existing `isThreadId` bound); else `{ type:'unsupported' }`.
    - These control payloads carry **no routable conversation `threadId`** for the surface/shadow routing path: `shadow-invite/-accept/-decline` carry none; `shadow-revoke` carries `threadId` only as an in-payload **reference** for the coordinator, not as the `DecodedContentPayload.threadId` routing field.
    - Keep `decodeContentPayload` returning `DecodedContentPayload` byte-for-byte as today for every pre-existing payload type.
    - _Requirements: 9.3, 12.1, 12.2, 12.3, 12.4_

  - [ ]* 1.3 Extend `content-payload.test.ts` with the four control types
    - Assert round-trip (encode→decode) for each valid variant; assert malformed inputs decode to `unsupported`: `shadow-invite.key` not base64-32-bytes; `shadow-accept`/`-decline` missing `inviteId`; `shadow-revoke` missing `inviteId` or with `threadId` outside 1..255 chars.
    - Assert every existing variant's encode/decode output is unchanged.
    - _Requirements: 9.5, 12.2, 12.3, 12.4, 12.5_

  - [ ]* 1.4 Write property test `content-payload-shadow-controls.property.test.ts`
    - **Property 10: Total inbound decode** — for arbitrary strings as decrypted plaintext, `decodeContentPayload` returns without throwing; an arbitrary malformed `shadow-invite` (bad `key`) decodes to `unsupported`.
    - Round-trip equivalence for arbitrary valid `shadow-invite/-accept/-decline/-revoke` payloads (Req 12.5).
    - `fast-check`, ≥100 iterations.
    - _Validates: Property 10 / Requirements 9.5, 11.3, 12.1, 12.2, 12.3, 12.4, 12.5_

- [ ] 2. Extend `ShadowSecretStore` — invited-thread binding keyed by the SHARED thread key
  - [ ] 2.1 Add `InvitedThreadRef` + `bindInvitedThread` / `markInvitedThreadActive` / `discardInvitedThread` in `packages/crypto/src/shadow-secret-store.ts`
    - Define `InvitedThreadRef extends ShadowThreadRef` with `threadKey: Uint8Array`, `routing: 'hidden'|'merge'`, `state: 'awaiting-accept'|'active'|'declined'`, `inviteId`.
    - `bindInvitedThread(mode, threadKey, peerUid, myUid, { alias?, pin?, routing, inviteId, state })`: real-mode only (else `null`); derive `threadId = deriveShadowThreadId(threadKey, myUid, peerUid)` with **no alias discriminator**; **recompute** rather than trust any transmitted id; persist the `InvitedThreadRecord` (and an `AliasEntry` when `alias` supplied so `/alias` re-opens it); when `pin` supplied, store only a `pinVerifier` from `secret-hash.hashSecret`, never the plaintext.
    - `markInvitedThreadActive(mode, inviteId)`: promote `awaiting-accept → active`; idempotent.
    - `discardInvitedThread(mode, inviteId)`: remove a pending record + its key on decline/expiry; nothing partial persisted.
    - Reuse the existing fail-closed write semantics: on any persistence error, **abort by propagating**, leaving nothing partial/plaintext.
    - Export new types from `index.ts`.
    - _Requirements: 2.3, 2.5, 2.6, 2.8, 5.1, 5.2, 5.3, 8.1, 8.2, 8.3, 11.4_

  - [ ] 2.2 Add `clearShadowThread` and `revokeShadowThread` to `ShadowSecretStore`
    - `clearShadowThread(mode, threadId)`: real-mode only (decoy/null → `null`); **validate** an `InvitedThreadRecord` for `threadId` exists and return its ref; **KEEP** the record + shared `threadKey` untouched (the chat keeps working); touch no stored secret; idempotent.
    - `revokeShadowThread(mode, threadId)`: real-mode only (decoy/null → `null`); **atomically DELETE** the shared `threadKey`, the `InvitedThreadRecord`, and any `AliasEntry` for `threadId` via the new port method (task 2.3), then return `{ peerUid, inviteId }`; fail-closed — a persistence failure **aborts (propagates)**, leaving the record + key intact (no keyless-record strand); idempotent (a second revoke returns `null`).
    - _Requirements: 5.3, 6.1, 6.6, 6.7, 7.1, 7.5, 7.6, 7.8, 11.4_

  - [ ] 2.3 Add the additive local-only atomic delete to the `ShadowSecretPersistence` port
    - Add `deleteInvitedThread(threadId)` to the narrow `ShadowSecretPersistence` port: remove the `InvitedThreadRecord`, its shared `threadKey`, and any `AliasEntry` pointing at `threadId` in **one all-or-nothing local write** (mirror the existing atomic `saveAliasEntry` contract).
    - On failure, **abort by propagating**, leaving nothing partial so a retry is safe. Device-local persistence only — **no** wire/envelope/codec change; the `KeyStore` port shape stays unchanged (the adapter backs it with the existing encrypted store).
    - _Requirements: 7.8, 15.1, 15.2, 15.3, 15.4_

  - [ ]* 2.4 Extend `shadow-secret-store.test.ts`
    - `bindInvitedThread`: real-mode gating (null in decoy/null), 32-byte-key derivation, alias-entry creation, `pinVerifier`-only PIN storage, fail-closed abort on write error.
    - `markInvitedThreadActive` / `discardInvitedThread` idempotence + no partial state.
    - `clearShadowThread` keeps record + key and returns the ref; `revokeShadowThread` deletes key+record+alias atomically and returns `{ peerUid, inviteId }`; fail-closed abort leaves nothing partial; decoy/null no-op returns `null`.
    - _Requirements: 5.1, 6.1, 6.6, 6.7, 7.1, 7.5, 7.6, 7.8, 8.1, 15.1, 15.2_

  - [ ]* 2.5 Write property test `shadow-invited-thread.property.test.ts`
    - **Property 1: Thread-key agreement / convergence** — ∀ 32-byte `key`, distinct non-empty `uidA,uidB`: `deriveShadowThreadId(key,uidA,uidB) === deriveShadowThreadId(key,uidB,uidA)`.
    - **Property 2: Key uniqueness ⇒ thread uniqueness** — ∀ distinct `k1≠k2`, same UID pair: distinct `threadId`s (overwhelming probability).
    - **Property 11: Backward compatibility** — ∀ legacy `bindAlias` inputs: the derived `threadId` is byte-for-byte identical before and after this feature (the `masterSecret`+alias path is unchanged).
    - **Property 17: Revoked threads are non-re-derivable** — after `revokeShadowThread`, no persisted material remains from which `deriveShadowThreadId(threadKey, …)` reproduces the `threadId`.
    - `fast-check`, ≥100 iterations; reuse `shadow-chat.ts` unchanged.
    - _Validates: Property 1, 2, 11, 17 / Requirements 2.3, 2.4, 2.7, 7.5, 11.1, 11.2, 11.4_

- [ ] 3. Add the device-local row↔thread association for per-`threadId` history purges
  - [ ] 3.1 Implement an additive, device-local row→thread association
    - The persisted `MessageRow` (`ports.ts`) carries no `threadId` today; add a **device-local** association that tags appended shadow rows with their `threadId` (or maintains a `threadId → rowIds` index), with a `rowIdsForThread(threadId)` resolver consumed by Clear/Revoke.
    - Implement as a local persistence addition only — **no** wire/envelope/codec field, no change to the `MessageRow` wire representation, backend stays frozen.
    - Wire row tagging into the shadow message persist path so every newly-persisted shadow row is recorded under its `threadId`.
    - _Requirements: 14.1, 14.2, 14.3, 14.4_

  - [ ]* 3.2 Unit tests for the association
    - Assert a persisted shadow row is resolvable by `threadId`; `rowIdsForThread` returns exactly the rows for that thread and nothing for an unknown/closed thread; no wire/envelope field is added.
    - _Requirements: 14.1, 14.2, 14.3_

- [ ] 4. Extend `ConversationRegistry` — recipient routing override + clear/close
  - [ ] 4.1 Add `markSurfaceVisible` / `clearThread` / `closeThread` in `packages/crypto/src/conversation-registry.ts`
    - `markSurfaceVisible(threadId)`: recipient-only **view-level** override — include the shadow thread in `listSurfaceConversations()` under `peerUid` and make it notifiable, **without** touching the pure reducer or merging sequence spaces (the thread keeps its own isolated `ConversationState` and `+1e9` seqs). Idempotent; no-op for the inviter.
    - `clearThread(threadId)`: reset `shadow:${threadId}` `ConversationState` to empty using the same row-removal effect as the reducer's existing `messages-expired` path (no tombstone), scoped to that thread only; keep the thread open and routable. Idempotent.
    - `closeThread(threadId)`: remove the thread's `ConversationState` entirely and stop routing to it; scoped to `shadow:${threadId}`, never touching surface or other threads. Idempotent.
    - Do not modify `conversation-reducer.ts`.
    - _Requirements: 3.2, 3.3, 3.4, 6.3, 6.4, 7.4_

  - [ ]* 4.2 Extend `conversation-registry.test.ts`
    - `markSurfaceVisible`: surface-list inclusion + notifiable, with the thread's own state/seqs unchanged; no-op for inviter.
    - `clearThread`: empties one shadow thread leaving others + surface intact, thread stays routable after clear.
    - `closeThread`: removes the thread entirely, scoped; closing an unknown/closed thread is a no-op.
    - _Requirements: 3.2, 3.3, 3.4, 6.3, 6.4, 7.4_

  - [ ]* 4.3 Write property test `conversation-registry-routing.property.test.ts`
    - **Property 5: Per-thread isolation** (carried forward, including under `merge`) — a `threadId`-tagged event mutates only `shadow:${threadId}`.
    - **Property 7: Recipient-routing-choice correctness** — `hidden` ⇒ absent from `listSurfaceConversations()` + non-notifiable; `merge` ⇒ present under `peerUid` + notifiable; in **both** cases the thread's own `ConversationState` and `+1e9` seqs are unchanged.
    - **Property 18: Clear keeps the chat working** — after `clearThread` the state is empty yet a subsequent applied event on the same `threadId` routes to `shadow:${threadId}` (no other conversation touched).
    - `fast-check`, ≥100 iterations.
    - _Validates: Property 5, 7, 18 / Requirements 3.2, 3.3, 3.4, 4.4, 6.3, 6.4_

- [ ] 5. Build `ShadowInviteCoordinator` (NEW) — invite / accept / decline lifecycle
  - [ ] 5.1 Create `packages/crypto/src/shadow-invite-coordinator.ts`
    - Define `RandomSource` (injected CSPRNG), `ShadowInviteEvent` (`invite-sent` / `invite-received` / `invite-accepted` / `invite-declined` / `invite-resolved` / `thread-revoked`), `RecipientRouting = 'hidden'|'merge'`, `InvitePending`, and the `ShadowInviteCoordinator` interface from design Component A. Platform-agnostic; holds no transport; emits events via `onInvite`.
    - `createInvite(peerUid, myUid, alias?, pin?)`: real-mode only (else `null`, send nothing); generate a fresh `threadKey = random.bytes(32)`; derive the converged `threadId`; `store.bindInvitedThread(..., routing:'hidden', state:'awaiting-accept')`; send exactly one `shadow-invite { inviteId, key: base64(threadKey), label? }` over the existing E2E channel; emit `invite-sent`. The inviter's `surface:${peerUid}` state stays **byte-for-byte unchanged** (no surface row inserted).
    - `acceptInvite(inviteId, routing, alias?, pin?)`: real-mode only (else `null`); `store.bindInvitedThread(..., state:'active')`; `registry.openShadowThread(threadId, peerUid)` and, when `routing === 'merge'`, also `registry.markSurfaceVisible(threadId)`; send `shadow-accept { inviteId }` that does **not** encode the routing choice; auto-remove the inbound invite record + card (emit `invite-resolved` 'accepted').
    - `declineInvite(inviteId)`: send `shadow-decline { inviteId }`; persist no shadow data; auto-remove inbound record + card (emit `invite-declined` then `invite-resolved` 'declined').
    - Keep the inviter's `RecipientRouting` fixed at `hidden` (documented asymmetry).
    - Export from `index.ts`.
    - _Requirements: 1.1, 1.2, 1.6, 2.1, 2.2, 3.1, 3.5, 3.6, 8.1, 8.2, 10.2, 10.4, 10.5_

  - [ ] 5.2 Pre-accept queue + flush-on-accept
    - While a thread is `awaiting-accept`, append messages typed into it to a local, untransmitted `Pre_Accept_Queue` (never on the wire).
    - On inbound `shadow-accept`: `markInvitedThreadActive`, `openShadowThread`, then flush every queued message **exactly once, in enqueue order**, with strictly increasing contiguous shadow seqs `≥ SHADOW_SEQ_OFFSET` (reuse `ShadowSequenceAllocator`); clear the queue.
    - On decline/expiry: discard all queued messages without transmitting; never transmit any shadow message while `awaiting-accept`.
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 8.2_

  - [ ] 5.3 `expireStaleInvites` + invite-control auto-cleanup
    - `expireStaleInvites(now)`: on each side independently, discard pending records whose 7-day TTL elapsed (record + key + queued messages), emit `invite-resolved` 'expired'; idempotent (safe on a timer / app-foreground).
    - On accept: delete the recipient's `shadow-invite` record + card; retain only the active `InvitedThreadRecord` on both sides. On decline/expiry: leave **no** invite residue. Emit exactly one `invite-resolved` per terminal state.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ] 5.4 `handleInbound` interception + `onInvite` subscription
    - `handleInbound(peerUid, payload)`: return `true` (consume) for `shadow-invite/-accept/-decline/-revoke`, `false` otherwise. Total — never throws.
    - `shadow-invite`: real mode → emit `invite-received` (render Accept/Decline card in surface chat); decoy/null → silently ignore (return `true`, render nothing, create no thread).
    - `shadow-accept` → promote pending → active, open thread, flush queue, emit `invite-accepted`. `shadow-decline` → discard pending record + key + queue, emit `invite-declined`/`invite-resolved`.
    - Emit no conversation row and pass nothing to `ConversationRegistry` as a message.
    - _Requirements: 1.3, 1.4, 10.1, 13.1, 13.2, 13.3_

  - [ ] 5.5 `revokeShadowThread` (self) + inbound `shadow-revoke` (peer)
    - `revokeShadowThread(threadId)` (self, real mode only): capture `rowIds` **before** deletion; `store.revokeShadowThread` (delete key+record+alias, returns `{ peerUid, inviteId }`); if `null` → total no-op; `keyStore.purgeMessages(rowIds)`; `registry.closeThread(threadId)`; **persist the local deletion first** (fail-closed, no ack); then send exactly one `shadow-revoke { inviteId, threadId }` (no key, no content) over E2E; emit `thread-revoked { initiatedBy:'self' }`. If the socket is down, the `shadow-revoke` rides the existing pending-send flush-on-reconnect.
    - Inbound `shadow-revoke` (peer, inside `handleInbound`, real mode only): capture `rowIds`, `store.revokeShadowThread`; if `null` → total no-op (return `true`); else `purgeMessages`, `closeThread`, emit `thread-revoked { initiatedBy:'peer' }`. Decoy/null → inert no-op (return `true`, delete nothing, send nothing).
    - Unknown/already-revoked `threadId` → total no-op that changes nothing and sends nothing; never throws.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.9, 13.4_

  - [ ]* 5.6 Unit tests in `shadow-invite-coordinator.test.ts`
    - invite/accept/decline lifecycle, decoy/null inertness (createInvite/acceptInvite return null, send nothing, invites ignored), pre-accept queue flush order/contiguity, event emission, `invite-resolved` fires once per terminal state with no residual record.
    - revoke: deletes key+record, purges history, closes thread, sends exactly one `shadow-revoke`, emits `thread-revoked{self}`; inbound mirrors it `{peer}`; decoy/null inert; unknown/duplicate revoke total no-op.
    - _Requirements: 1.1, 4.1, 4.2, 4.3, 7.1, 7.4, 7.6, 8.4, 10.1, 10.2, 13.1, 13.4_

  - [ ]* 5.7 Write property test `shadow-invite-coordinator.property.test.ts`
    - **Property 6: Decoy inertness** — ∀ inbound invites and `createInvite`/`acceptInvite` in decoy/null: no context released, no thread, no revealing event; decoy ≡ null within 50 ms.
    - **Property 8: No-surface-disturbance for the inviter** — ∀ invite lifecycles (sent/accepted/declined/expired, arbitrary pre-accept messages): the inviter's `surface:${peerUid}` state is byte-for-byte identical to no-invite.
    - **Property 9: Pre-accept queue safety** — ∀ pre-accept sequences then Accept: each queued message flushed exactly once, in order, with strictly increasing contiguous shadow seqs `≥ SHADOW_SEQ_OFFSET`; on decline/expiry none transmitted.
    - **Property 13: No invite-control residue** — ∀ lifecycles ending accept/decline/expiry: only the active `InvitedThreadRecord` (accept) or nothing (decline/expiry) persists; `invite-resolved` emitted exactly once.
    - **Property 16: Revoke decoy inertness** — ∀ inbound `shadow-revoke` / `revokeShadowThread` in decoy/null: nothing deleted, no key touched, nothing sent; decoy ≡ null within 50 ms.
    - `fast-check`, ≥100 iterations.
    - _Validates: Property 6, 8, 9, 13, 16 / Requirements 4.1, 4.2, 4.3, 8.3, 8.4, 8.5, 10.1, 10.2, 10.3, 10.4, 13.4_

- [ ] 6. Intercept the four shadow control types in `messaging.ts`
  - [ ] 6.1 Add the verification-style interception seam in `packages/crypto/src/messaging.ts`
    - In `onEnvelope`, after `decodeContentPayload`, pass `shadow-invite/-accept/-decline/-revoke` to `ShadowInviteCoordinator.handleInbound(peerUid, payload)`; when it returns `true`, **stop** normal conversation routing — emit no conversation event, pass nothing to `ConversationRegistry`. An inbound `shadow-revoke` is thus handled entirely by the coordinator and never becomes a message row.
    - Outbound: the coordinator builds the control payload and hands the plaintext to the existing `send` path (encrypt → envelope → transmit), so the wire frame is an ordinary `CiphertextEnvelope` with no `threadId`/plaintext. No `Messaging` port shape change.
    - Ensure `shadow-revoke` rides the existing pending-send flush-on-reconnect when the socket is down (Req 7.9).
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 13.1, 13.2, 13.3, 7.9_

  - [ ]* 6.2 Extend `messaging.test.ts` / `messaging-shadow.test.ts`
    - Assert the four control types are intercepted (no conversation event, nothing reaches the registry); a non-shadow payload returns `false` and routes normally; an inbound `shadow-revoke` purges + closes without a message row.
    - Assert outbound invite/accept/decline/revoke envelopes carry no `threadId`/plaintext on the wire and expose an identical field-name set/count/types/ordering to a surface envelope between the same UIDs.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 13.1, 13.2, 13.3_

- [ ] 7. Checkpoint — core pure-logic complete (pre-gate)
  - Ensure all core tests pass (content-payload, secret-store, row↔thread association, registry, coordinator, messaging). Do not start the UI epics until the e2e gate (8.1) is green. Surface any questions to the user.

- [ ] 8. Two-client end-to-end test — **GATING DELIVERABLE (blocks all UI work)**
  - [ ] 8.1 Create `packages/crypto/src/messaging-shadow-invites-e2e.test.ts` — **THIS IS THE GATE; epics 10–11 (UI) MUST NOT begin until it passes**
    - Wire two `DefaultMessaging` instances (A inviter, B recipient) over the in-memory transport with real libsignal sessions, each provisioned with a **DIFFERENT device-local `masterSecret`** (the opposite of the shipped harness).
    - Run invite → accept → converge: assert A and B independently store the **identical** `threadId` (**Property 3: Accept symmetry**, the regression the shipped e2e masked).
    - Exchange ≥1 message in each direction post-Accept; assert every shadow message routes to `shadow:${threadId}` only and **never** to `surface:${peerUid}` on either side (**Property 12**); assert pre-accept messages queue and flush correctly (Property 9).
    - Run the `hidden` leg and the `merge` leg; assert the routing-choice rendering difference while the underlying state stays an isolated shadow thread, and that the inviter's surface state is undisturbed in both (Property 7, 8).
    - Capture every transport frame: assert **no `threadId`/plaintext on the wire** and that shadow/invite/accept/decline/revoke envelopes expose an identical field set/count/types/ordering to a surface envelope (**Property 4**).
    - _Validates: Property 3, 4, 7, 8, 9, 12 / Requirements 2.5, 3.1, 3.2, 3.3, 4.2, 4.4, 9.1, 9.2, 9.3_

  - [ ] 8.2 Add the revoke + clear + invite-cleanup e2e legs
    - **Revoke leg:** after a converged thread, A revokes; assert B receives `shadow-revoke`, both vaults end with key + record + history + alias gone, the thread is closed on both sides, the `threadId` cannot be re-derived, and the server saw only an opaque envelope (Properties 14, 15, 17).
    - **Clear leg:** A clears, sends a new message on the same `threadId`, and B still receives it (the chat survives) (Property 18).
    - **Invite-cleanup leg:** after decline/expiry no `shadow-invite` record or request card remains on either side; after accept only the active `InvitedThreadRecord` persists (Property 13).
    - _Validates: Property 13, 14, 15, 17, 18 / Requirements 6.4, 6.5, 7.1, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3_

  - [ ]* 8.3 Write revoke property test `shadow-revoke.property.test.ts`
    - **Property 14: Revoke symmetry** — once a `shadow-revoke` is applied, both sides end with the thread closed, `threadKey` deleted, history purged, no `AliasEntry` for `threadId`.
    - **Property 15: Revoke server-blindness** — the `shadow-revoke` envelope matches a surface envelope's field set/count/types/ordering and carries no key/plaintext/`threadId` on the wire.
    - Drive arbitrary revoke orderings (local-first, peer offline, duplicate/stale revoke) and assert idempotent, fail-closed teardown.
    - `fast-check`, ≥100 iterations.
    - _Validates: Property 14, 15 / Requirements 7.1, 7.2, 7.3, 7.5, 7.6, 9.4_

- [ ] 9. Checkpoint — core + e2e gate complete
  - Confirm the e2e gate (8.1) and the revoke/clear/cleanup legs (8.2) are green and Accept symmetry (Property 3) is proven with distinct master secrets. Only then proceed to UI.

- [ ] 10. Web UI adapter (`apps/web`) — thin rendering of coordinator events
  - [ ] 10.1 Long-press / contact-menu "Shadow chat" invite entry point
    - Add a "Shadow chat" action to the contact menu that calls `createInvite(peerUid, myUid, alias?, pin?)`; **omit** the option entirely in decoy/locked mode. Show the inviter's hidden `awaiting-accept` pending view (never in the surface list).
    - _Requirements: 1.1, 1.5, 1.6, 10.4_

  - [ ] 10.2 Accept/Decline request card + routing-choice sheet
    - Render the `invite-received` event as an Accept/Decline card attached to the surface contact (not a reducer message row); on Accept open a routing sheet offering `hidden` (default) and `merge`; call `acceptInvite`/`declineInvite`. Auto-dismiss the card on `invite-resolved`.
    - _Requirements: 1.3, 3.1, 8.1, 10.5_

  - [ ] 10.3 Settings: "Clear shadow chat" / "Revoke shadow chat" (per chat, real-mode only)
    - Add the two settings actions per shadow chat; Clear runs the local purge (keep key), Revoke runs `revokeShadowThread`. Both **absent / no-op in decoy/locked**. Remove the thread/alias handle on `thread-revoked`.
    - _Requirements: 6.1, 6.7, 7.1, 6.6, 7.7_

- [ ] 11. Mobile UI adapter (`apps/mobile`) — same surface, native long-press
  - [ ] 11.1 Native long-press "Shadow chat" + pending view; remove the buggy local-secret path
    - Wire the contact long-press to `createInvite`; render the hidden pending view; **omit** the option in decoy/locked. Retire `chat-controller.ts`'s device-local `shadowMasterSecret` provisioning for invited threads (it now flows from the shared per-thread key); keep `provisionShadowContext` only for legacy alias-only `masterSecret`/`aliasKey`.
    - _Requirements: 1.1, 1.5, 1.6, 2.1, 2.2, 11.4_

  - [ ] 11.2 Request card + routing sheet + settings Clear/Revoke (mobile)
    - Mirror 10.2 + 10.3 natively: Accept/Decline card in the main chat, routing sheet (`hidden` default / `merge`), settings Clear/Revoke per chat, decoy/locked inert.
    - _Requirements: 1.3, 3.1, 6.1, 7.1, 8.1, 10.5_

  - [ ]* 11.3 Update `apps/mobile/src/data/shadow-create-e2e.test.ts` sibling for the invite flow
    - Add a device-faithful test that provisions distinct master secrets, runs invite → accept → converge on-device (msrcrypto WebCrypto), and asserts identical `threadId` and no surface leak.
    - _Requirements: 2.5, 4.4, 10.4_

- [ ] 12. Final checkpoint — full feature
  - Run the whole `@chat-app/crypto` suite plus the web/mobile adapter tests; confirm Properties 1–18 are covered, the backend wire format is unchanged, decoy/locked inertness holds, and legacy alias-only threads still derive identical `threadId`s. Surface any open questions to the user.
</content>
</invoke>
