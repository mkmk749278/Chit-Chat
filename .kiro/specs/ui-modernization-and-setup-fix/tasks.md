# Implementation Plan: UI Modernization & Setup-Freeze Fix

## Overview

This plan implements the three root-caused fixes from `design.md` in priority order, each independently
shippable:

- **P1 (freeze fix)** — make PBKDF2 bit derivation injectable in the shared pure core (`secret-hash.ts`)
  without changing the verifier format or constant-time compare, bind a native off-thread provider on
  mobile, and add async busy UI so no heavy hash blocks the JS thread.
- **P2 (ordering fix)** — add a `createdAt` ordering key to `RenderableMessage`, order the rendered list by
  time with a stable tiebreak (gap detection stays on inbound `seq`), thread `createdAt` through
  `messaging.ts`, then make the mobile list bottom-anchored with day separators, time labels, and grouping.
- **P3 (UI modernization)** — refresh `theme.ts` scales, adopt `@expo/vector-icons`, redesign the
  conversation header with an overflow menu, and add a Contact/Profile screen.

Implementation language is **TypeScript** (existing monorepo). Pure-core tests use `node --test` +
`fast-check`. Every `@chat-app/crypto` change carries an accompanying test task. Hard constraints honored:
backend frozen (no wire/envelope/ack/codec change), shared pure core, PBKDF2 iterations stay `>= 210000`.

## Tasks

- [ ] 1. P1 — Inject a `Pbkdf2Provider` port into the pure core
  - [ ] 1.1 Add the `Pbkdf2Provider` port and route derivation through it in `secret-hash.ts`
    - In `packages/crypto/src/secret-hash.ts`, define `interface Pbkdf2Provider { deriveBits(password, salt, iterations, keyLenBytes): Promise<Uint8Array> }`, plus `setPbkdf2Provider` / `getPbkdf2Provider` with a WebCrypto-backed default that performs exactly the current `subtle.importKey`/`subtle.deriveBits` calls
    - Refactor the internal `derive(...)` to call `getPbkdf2Provider().deriveBits(...)` instead of inlining the WebCrypto calls; keep `DEFAULT_SECRET_ITERATIONS = 210_000`, the `pbkdf2$sha256$<iters>$<salt>$<hash>` format, salt generation via `crypto.getRandomValues`, and the constant-time `timingSafeEqual` byte-for-byte unchanged
    - Export `Pbkdf2Provider`, `setPbkdf2Provider`, `getPbkdf2Provider` from `packages/crypto/src/index.ts`
    - _Requirements: 1.1, 4.1, 4.2, 4.4, 4.5, 4.7, 4.8_

  - [ ]* 1.2 Write property test for KDF provider interchangeability
    - **Property 5: KDF provider interchangeability (migration safety)**
    - Generate random secrets; verify a verifier produced under one provider verifies `true` under the other, and `verifySecret(s, hashSecret(s))` holds under any single provider (use a low iteration count for speed, as the existing suite does)
    - **Validates: Requirements 1.4, 4.1**

  - [ ]* 1.3 Write property test for verifier format and fresh salting
    - **Property 6: Verifier format + salting unchanged**
    - Assert `hashSecret` emits `pbkdf2$sha256$<iters>$<salt>$<hash>` with `<iters> >= 210000`, a fresh salt per call (same secret => different verifiers), and the plaintext never appears in the verifier
    - **Validates: Requirements 4.1, 4.4**

  - [ ]* 1.4 Write property test for constant-time, total verification
    - **Property 7: Constant-time, total verification**
    - For random secrets and random/foreign/malformed `stored` strings, `verifySecret` returns a boolean without throwing and compares the full hash length without early-out
    - **Validates: Requirements 4.2**

  - [ ]* 1.5 Write provider-seam test proving no inline KDF loop
    - **Property 8: No synchronous KDF on the JS thread (test seam)**
    - Inject a fake `Pbkdf2Provider` that records calls / returns deterministic bytes; assert `secret-hash` performs bit derivation **only** through `getPbkdf2Provider().deriveBits(...)` and never inlines a per-iteration loop
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [ ]* 1.6 Write regression property test for decoy / lockout / reveal-all
    - **Property 9: Decoy / lockout / indistinguishability preserved**
    - Reuse the existing `app-lock`/`lockout-policy` property style to confirm `resolveAppMode` returns `real` (checked first), `decoy` (only decoy matches), or `null`, the 5-failure/10-min -> 30-min lockout is unchanged, and `revealHiddenChat` checks all candidates without short-circuiting
    - **Validates: Requirements 4.3**

- [ ] 2. P1 — Mobile native off-thread KDF adapter and wiring
  - [ ] 2.1 Add the native KDF dependency and prebuild/CI configuration
    - Add `react-native-quick-crypto` (and its JSI host peer) to `apps/mobile/package.json`; update the Expo prebuild/dev-client config and `.github/workflows/android.yml` so the native binary is built and re-signed with the existing key
    - Confirm `@expo/vector-icons` is available via Expo SDK 51 (no new native module) for use in P3
    - Make no change to any wire envelope, ack, or codec
    - _Requirements: 1.2, 1.5, 4.8, 4.9_

  - [ ] 2.2 Implement the native `Pbkdf2Provider` adapter
    - Create `apps/mobile/src/crypto/pbkdf2-native.ts` exporting `nativePbkdf2Provider` that calls `QuickCrypto.pbkdf2(password, salt, iterations, keyLenBytes, 'sha256', cb)` (JSI, background thread) and resolves a `Uint8Array`, rejecting on error; retain no plaintext
    - _Requirements: 1.1, 1.2, 4.8_

  - [ ] 2.3 Install the native provider at boot with a secure fallback
    - In `apps/mobile/src/polyfills.ts`, after the existing `setWebCrypto(...)` block, call `setPbkdf2Provider(nativePbkdf2Provider)` inside a `try/catch`; on failure keep the WebCrypto default at the full 210000 iterations (never lower any parameter)
    - _Requirements: 1.2, 1.5, 4.8_

- [ ] 3. P1 — Async busy UI for setup/unlock screens
  - [ ] 3.1 Add busy/disabled state to `AppLockScreen`
    - In `apps/mobile/src/ui/AppLockScreen.tsx`, add an optional `busy?` prop plus a local `busy` flag; while the unlock hash is in flight, show an `ActivityIndicator` and disable the submit control until it resolves
    - _Requirements: 1.3_

  - [ ] 3.2 Add busy/disabled state to `OnboardingScreen` (PIN set)
    - In `apps/mobile/src/ui/OnboardingScreen.tsx`, gate the set-PIN submit behind a `busy` flag with a spinner and disabled control while hashing
    - _Requirements: 1.3_

  - [ ] 3.3 Add busy/disabled state to `SettingsScreen` (real + decoy PIN)
    - In `apps/mobile/src/ui/SettingsScreen.tsx`, apply the same busy/disabled pattern to set/clear of both the real and decoy PIN
    - _Requirements: 1.3, 4.3_

  - [ ] 3.4 Add busy state to the hide-chat sheet and hidden-chat reveal
    - In `apps/mobile/src/ui/ConversationScreen.tsx`, add a busy flag to the hide-chat sheet (`onHideChat`); in `apps/mobile/src/ui/ChatsListScreen.tsx` (and the container wiring) add a `revealing` flag for the search-bar `revealHiddenChat`, keeping the check-all-candidates flow intact
    - _Requirements: 1.3, 4.6_

  - [ ]* 3.5 Write example tests for busy/disabled states
    - Cover that AppLock/Onboarding/Settings/hide-sheet disable their submit control and show progress while a hash is in flight
    - _Requirements: 1.3_

- [ ] 4. Checkpoint - P1 freeze fix complete and shippable
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. P2 — Time-ordered rendering in the pure core
  - [ ] 5.1 Add `createdAt` ordering to `conversation-reducer.ts`
    - In `packages/crypto/src/conversation-reducer.ts`, add optional `createdAt?: number` to `RenderableMessage`; change `upsertMessage` to sort by `(createdAt asc, seq asc, messageKey asc)` with absent/non-finite values treated as `0`; keep dedup by `(direction, seq)` and `computeMissingBefore` derived from inbound `seq`s only
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ]* 5.2 Write property test for chronological render order
    - **Property 1: Chronological render order across both directions**
    - Generate random interleavings/duplications of in/out events with random `createdAt`/`seq`; assert the list is non-decreasing in `createdAt` and is a stable total order under `(createdAt, seq, direction)`
    - **Validates: Requirements 2.1, 2.2**

  - [ ]* 5.3 Write property test for dedup under time ordering
    - **Property 2: Dedup preserved under time ordering**
    - For random sequences of `message-appended` / `inbound-delivery-error` events, assert each `(direction, seq)` appears exactly once regardless of arrival order
    - **Validates: Requirements 2.3**

  - [ ]* 5.4 Write property test for gap-detection invariance
    - **Property 3: Gap detection is invariant to the ordering change**
    - Assert `missingBefore` equals the inbound seqs immediately following a gap strictly between lowest and highest received inbound seq, independent of `createdAt` and arrival order
    - **Validates: Requirements 2.4**

  - [ ]* 5.5 Write property test for shadow-thread ordering isolation
    - **Property 4: Shadow-thread ordering isolation**
    - For a mix of surface (`seq < 1e9`) and shadow (`seq >= 1e9`) messages routed to per-thread states, assert each thread orders chronologically by `createdAt` with no cross-thread leakage
    - **Validates: Requirements 2.5**

  - [ ] 5.6 Thread `createdAt` into `message-appended` events in `messaging.ts`
    - In `packages/crypto/src/messaging.ts`, include `createdAt` (from the existing `MessageRow.createdAt`) in emitted `message-appended` messages for outbound and inbound paths, and stamp `inbound-delivery-error` rows with the receive time; add no new event variants and no wire change
    - _Requirements: 2.6_

  - [ ]* 5.7 Write unit test for `createdAt` threading in messaging
    - Assert emitted `message-appended` events carry the `MessageRow.createdAt` value and that failed-decrypt rows receive a `createdAt`
    - _Requirements: 2.6_

- [ ] 6. P2 — Mobile bottom-anchored, grouped message list
  - [ ] 6.1 Rework the `ConversationScreen` message list rendering
    - In `apps/mobile/src/ui/ConversationScreen.tsx`, render the list `inverted` (bottom-anchored so the newest message shows without manual scroll), insert centered day-separator pills when the calendar day of `createdAt` changes between adjacent messages, add a per-message `HH:mm` time label in the bubble footer, and group consecutive same-direction messages within a short window (reduced spacing, single tail); preserve existing bubble semantics (reactions, edited/deleted, view-once, status)
    - _Requirements: 3.5, 3.6, 3.7, 3.8_

- [ ] 7. Checkpoint - P2 ordering complete and shippable
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. P3 — Theme scales and vector-icon strategy
  - [ ] 8.1 Extend `theme.ts` with spacing, radius, and typography scales
    - In `apps/mobile/src/ui/theme.ts`, add explicit `spacing`, `radius`, and `type` (typography) scales consumed via `useTheme`, retaining the current light/dark palettes
    - _Requirements: 3.10_

  - [ ]* 8.2 Add the `icons.tsx` wrapper over `@expo/vector-icons`
    - Create `apps/mobile/src/ui/icons.tsx` exporting a typed `Icon` component mapping semantic names (`back`, `more-vert`, `timer`, `shield`, `verified`, `calls`, `settings`, `send`, status, FAB) to `@expo/vector-icons`
    - _Requirements: 3.9_

  - [ ] 8.3 Replace emoji affordance glyphs with vector icons across screens
    - Replace UI-affordance emoji (tab icons, send arrow, status `clock`/checks, FAB) in `apps/mobile/src/ui/TabBar.tsx`, `ChatsListScreen.tsx`, and other affected screens with the `Icon` component; keep content emoji (reaction palette, "message deleted" copy) as-is
    - _Requirements: 3.9_

- [ ] 9. P3 — Conversation header redesign, overflow menu, and Contact profile
  - [ ] 9.1 Redesign the conversation header and add the overflow menu
    - In `apps/mobile/src/ui/ConversationScreen.tsx`, replace the five-icon header with `back | tappable avatar | name + concise status (flex) | overflow`; tapping avatar/name opens the profile, the `more-vert` control opens an overflow menu mapping the disappearing-messages, verify-identity, safety-number, and hide-chat actions to the existing callbacks (no container/state rewire); surface a verification badge for `incoming`/`unverified`
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 9.2 Create the `ContactProfileScreen`
    - Create `apps/mobile/src/ui/ContactProfileScreen.tsx` (presentational) surfacing disappearing-messages, safety-number, verify-identity, and hide-chat actions via the existing callbacks (`onSetTimer`, `getSafetyNumber`, `onRequestVerification`/`onRespondVerification`, `onHideChat`/`onUnhideChat`), reusing the existing action sheets
    - _Requirements: 3.4_

  - [ ]* 9.3 Write example tests for header actions reachability
    - Assert all four moved actions are reachable via the overflow menu and the profile screen, and that the header shows back/avatar/name/status/overflow
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [ ] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation
  tasks are never optional.
- Each `@chat-app/crypto` change (1.1, 5.1, 5.6) has an accompanying test task (1.2-1.6, 5.2-5.5, 5.7).
- Phases are sequenced highest-value-first and each ends at an independently shippable checkpoint:
  P1 (tasks 1-3) freeze fix, P2 (tasks 5-6) ordering, P3 (tasks 8-9) UI.
- Hard constraints honored throughout: backend frozen (no wire/envelope/ack/codec change), shared pure core,
  PBKDF2 iterations stay `>= 210000` on every provider path including the WebCrypto fallback.
- Property tests use `fast-check` under `node --test`, tagged `Feature: ui-modernization-and-setup-fix,
  Property N: ...`, min 100 runs per property.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "5.1", "2.1", "8.1"] },
    { "id": 1, "tasks": ["1.2", "5.2", "5.6", "2.2", "8.2"] },
    { "id": 2, "tasks": ["1.3", "5.3", "5.7", "2.3", "8.3"] },
    { "id": 3, "tasks": ["1.4", "5.4", "3.1", "3.2", "3.3"] },
    { "id": 4, "tasks": ["1.5", "5.5", "3.4"] },
    { "id": 5, "tasks": ["1.6", "3.5", "6.1"] },
    { "id": 6, "tasks": ["9.1", "9.2"] },
    { "id": 7, "tasks": ["9.3"] }
  ]
}
```
