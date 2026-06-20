# Requirements Document

## Introduction

This document specifies the requirements for the **UI Modernization & Setup-Freeze Fix** feature of the
Lumin Chat (Chit-Chat) mobile client. The requirements are **derived from the approved design document**
(`design.md`) and address three user-reported defects:

- **P1 — Setup/unlock freeze:** PIN, decoy, hidden-chat, and shadow-chat setup and unlock freeze the app
  because a pure-JS PBKDF2 at 210,000 iterations runs synchronously on Hermes' single JavaScript thread.
- **P2 — Jumbled message order:** chat messages render out of true chronological order because the rendered
  list is ordered by per-direction `seq` rather than by creation time.
- **P3 — Outdated, cluttered UI:** the conversation header is overloaded with five emoji icons and the
  visual language is dated relative to professional messengers.

The requirements also capture the standing hard constraints under which the fix MUST be implemented: the
backend is **frozen** (no wire/envelope/ack/codec change), shared logic lives in the `@chat-app/crypto`
pure core, each core change ships pure-core unit/property tests, and the cryptographic security model is
preserved or strengthened (never weakened).

Requirement numbering in this document is aligned with the Correctness Properties already present in the
design document:
- **Requirement 1** — setup/unlock no-freeze (P1).
- **Requirement 2** — message ordering (P2).
- **Requirement 3** — UI modernization (P3).
- **Requirement 4** — security and constraint preservation.

## Glossary

- **Mobile_Client**: The Lumin Chat React Native / Expo (Hermes engine) application in `apps/mobile`.
- **Secret_Hash**: The pure-core module `packages/crypto/src/secret-hash.ts` that produces and verifies
  password verifiers using PBKDF2-HMAC-SHA256.
- **Pbkdf2Provider**: The injectable port consumed by Secret_Hash that performs PBKDF2 bit derivation. The
  default implementation uses WebCrypto; the mobile implementation binds a native, off-thread provider
  (`react-native-quick-crypto`).
- **Secure_Gate**: The pure flow module `apps/mobile/src/app/secure-gate.ts` that resolves app mode
  (real vs. decoy), enforces lockout policy, and reveals hidden chats.
- **Conversation_Reducer**: The pure-core module `packages/crypto/src/conversation-reducer.ts` that reduces
  message events into the rendered `ConversationState`.
- **Messaging**: The pure-core module `packages/crypto/src/messaging.ts` that emits message events,
  including `message-appended`.
- **RenderableMessage**: The rendered message record produced by Conversation_Reducer, extended with a
  `createdAt` ordering field.
- **Conversation_Screen**: The mobile screen `apps/mobile/src/ui/ConversationScreen.tsx` that renders the
  conversation header and message list.
- **Contact_Profile_Screen**: The new mobile screen `apps/mobile/src/ui/ContactProfileScreen.tsx` that
  surfaces the actions moved off the conversation header.
- **Theme**: The mobile visual system module `apps/mobile/src/ui/theme.ts`.
- **Backend**: The deployed server at `api.luminchat.app`, which runs old code and cannot be redeployed.
- **Verifier**: A self-describing password hash string in the format
  `pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>`.
- **Surface_Thread**: A conversation thread whose messages carry `seq < 1e9`.
- **Shadow_Thread**: A conversation thread whose messages carry `seq >= 1e9`.

## Requirements

### Requirement 1

**User Story:** As a Lumin Chat user, I want PIN, decoy, hidden-chat, and shadow-chat setup and unlock to
stay responsive, so that the app never freezes while securing or opening my data.

#### Acceptance Criteria

1. WHEN a user initiates a setup or unlock operation that requires a password verifier (set real PIN, set
   decoy PIN, hide chat, unlock, or reveal hidden chat), THE Secret_Hash SHALL perform PBKDF2 bit
   derivation by calling the injected Pbkdf2Provider rather than an inline per-iteration loop.
2. WHILE a PBKDF2 derivation runs on the Mobile_Client, THE Mobile_Client SHALL perform the derivation off
   the JavaScript thread so that the JavaScript/UI thread remains responsive.
3. WHILE a setup or unlock hash is in flight, THE affected Mobile_Client screen SHALL display an
   in-progress indicator and disable the relevant submit control until the operation resolves.
4. WHEN the Pbkdf2Provider is swapped between the WebCrypto default and the native implementation, THE
   Secret_Hash SHALL continue to verify any previously stored Verifier without re-hashing or migration.
5. IF the native off-thread PBKDF2 module is unavailable at runtime, THEN THE Mobile_Client SHALL retain
   the WebCrypto default provider at the full iteration count of 210000, SHALL be permitted to run the
   derivation on the JavaScript thread, and SHALL still resolve the derivation behind the in-progress
   indicator.

### Requirement 2

**User Story:** As a user, I want messages to display in true chronological order across both directions,
so that a back-and-forth conversation reads naturally.

#### Acceptance Criteria

1. WHEN outbound and inbound messages are appended in any arrival order, including backfilled
   store-and-forward messages, THE Conversation_Reducer SHALL order the rendered RenderableMessage list by
   `createdAt` ascending.
2. WHEN two or more messages share the same `createdAt` value, THE Conversation_Reducer SHALL apply a
   stable, total tiebreak that orders by `seq` ascending and then by direction, producing a deterministic
   order independent of arrival order.
3. WHEN a message whose `(direction, seq)` key already exists is appended, THE Conversation_Reducer SHALL
   retain exactly one RenderableMessage per `(direction, seq)` key.
4. THE Conversation_Reducer SHALL derive missing-message gap markers from the inbound `seq` space only,
   independent of `createdAt` values and arrival order.
5. WHERE messages belong to distinct Surface_Thread and Shadow_Thread states, THE Conversation_Reducer
   SHALL order each thread's messages chronologically by `createdAt` with no message crossing between
   threads.
6. WHEN Messaging emits a `message-appended` event, THE Messaging SHALL include the `createdAt` value taken
   from the corresponding `MessageRow`.

### Requirement 3

**User Story:** As a user, I want a minimal, modern conversation UI with an uncluttered header, so that the
app feels as professional as WhatsApp, Telegram, and Signal.

#### Acceptance Criteria

1. THE Conversation_Screen header SHALL display, from left to right, a back control, a tappable avatar, the
   peer name with a concise status line, and an overflow control.
2. WHEN a user taps the avatar or the peer name, THE Conversation_Screen SHALL open the
   Contact_Profile_Screen.
3. WHEN a user taps the overflow control, THE Conversation_Screen SHALL present a menu containing the
   disappearing-messages, verify-identity, safety-number, and hide-chat actions.
4. THE Contact_Profile_Screen SHALL surface the disappearing-messages, safety-number, verify-identity, and
   hide-chat actions using the existing conversation callbacks.
5. THE Conversation_Screen SHALL render the message list bottom-anchored so that the newest message is
   visible without manual scrolling.
6. WHEN the calendar day of `createdAt` changes between two adjacent rendered messages, THE
   Conversation_Screen SHALL insert a day-separator label between them.
7. THE Conversation_Screen SHALL display a per-message time label derived from `createdAt` in each message
   bubble footer.
8. WHERE consecutive messages share the same direction within a short time window, THE Conversation_Screen
   SHALL group them with reduced vertical spacing and a single tail.
9. THE Mobile_Client SHALL render UI affordance icons (header, tab bar, send, status, and floating action
   controls) using `@expo/vector-icons` in place of emoji glyphs.
10. THE Theme SHALL define explicit spacing, radius, and typography scales that the Mobile_Client screens
    consume through `useTheme`.

### Requirement 4

**User Story:** As a security-conscious user, I want the cryptographic security model and the frozen
backend protocol to remain intact, so that fixing the freeze and the UI does not weaken my privacy.

#### Acceptance Criteria

1. WHEN hashing a secret, THE Secret_Hash SHALL emit a Verifier in the format
   `pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>` with `<iterations>` greater than or equal to 210000.
2. WHEN verifying a secret against any stored string, including malformed or foreign verifiers, THE
   Secret_Hash SHALL return a boolean using a constant-time full-length comparison without throwing.
3. WHEN resolving the app mode for an entered PIN, THE Secure_Gate SHALL return `real` when the real
   Verifier matches (checked first), `decoy` when only the decoy Verifier matches, and `null` otherwise,
   and SHALL preserve the existing lockout policy (5 failures within 10 minutes triggers a 30-minute
   lockout).
4. WHEN hashing a secret, THE Secret_Hash SHALL generate a fresh random salt for each call such that the
   same secret produces different verifiers, and the plaintext secret SHALL be absent from the emitted
   Verifier.
5. IF random salt generation fails, THEN THE Secret_Hash SHALL refuse to hash the secret and SHALL return
   an error rather than producing a Verifier with a weak or reused salt.
6. WHILE revealing a hidden chat, THE Secure_Gate SHALL verify the entered secret against every hidden-chat
   Verifier without short-circuiting on the first match, so that timing and outcome do not reveal which
   chat matched.
7. THE Mobile_Client SHALL keep the shared cryptographic and reducer logic in the `@chat-app/crypto` pure
   core so that web and mobile share one code path.
8. WHERE any PBKDF2 provider path is used, including the WebCrypto fallback, THE Mobile_Client SHALL keep
   the iteration count at 210000 and SHALL NOT lower any PBKDF2 parameter.
9. THE Mobile_Client SHALL preserve the existing wire envelope, acknowledgement, and codec formats so that
   the frozen Backend continues to operate without redeployment.
