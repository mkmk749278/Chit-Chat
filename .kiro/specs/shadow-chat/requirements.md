# Requirements Document

## Introduction

This document specifies the requirements for the **Shadow Chat** feature of the Chit-Chat
privacy messenger. It is the standalone breakout of **Wave 3 / Requirement 8** ("Hidden chats,
**shadow chat**, decoy PIN") from `.kiro/specs/phase2-messaging-features/requirements.md`, which
explicitly deferred this feature until it had its own design and security review. These
requirements are **derived from** the approved design document
(`.kiro/specs/shadow-chat/design.md`) and trace to that design's behaviour, constraints, and its
fourteen Correctness Properties.

A **shadow chat** is a completely independent, invisible parallel thread with an existing contact.
The contact already appears in the normal ("surface") chat list; the shadow thread is reachable
**only** by typing a private `/alias` (for example `/contact1`) into the chat search bar. Typing the
exact correct alias opens that contact's shadow thread; a wrong alias and a non-existent alias are
**indistinguishable**, because the app never confirms that an alias exists. A contact may have **any
number** of shadow threads — there is no per-contact or overall cap — each created from a long-press
**"Shadow chat"** action and keyed by a distinct `/alias`, and each may **optionally** carry its own
per-chat PIN that is blank by default.

The feature is shaped end-to-end by one hard constraint: **the deployed backend at
`api.luminchat.app` is frozen and cannot be redeployed.** No requirement below may introduce a
wire-envelope change, an acknowledgement-format change, or any new server-visible frame.
Consequently the shadow `threadId` rides **inside** the encrypted content payload, the server stays
fully blind, and surface chat behaviour is byte-for-byte unchanged whenever no `threadId` is present.

The pure cryptographic core already exists and is implemented and tested (`shadow-chat.ts`,
`secret-hash.ts`, `content-payload.ts`, `app-lock.ts`, `lockout-policy.ts` in `@chat-app/crypto`).
Its cryptographic semantics MUST NOT change, with two reviewed additive exceptions: extending
`content-payload.ts` with an optional `threadId`, and extending `deriveShadowThreadId` with an
**optional alias discriminator** so a contact may hold any number of distinct shadow threads (see
Requirement 2). These requirements cover the remaining work:
messaging integration, the per-thread conversation store, the two-client end-to-end test, the
search-bar alias interception, the long-press shadow-chat creation flow, the optional per-chat PIN
lock, and durable device-local secret persistence.

### Relationship to parent requirements and cross-cutting constraints

These requirements implement and refine the parent Phase 2 acceptance criteria for **Requirement 8**:
8.1 (a decoy PIN reveals nothing about hidden content), 8.2 (hidden chats are excluded from the
default chat list, notifications, and previews), and 8.3 (the presence or absence of hidden content
is not detectable from the wire or from metadata available without the real PIN). They also carry
forward the cross-cutting constraints: **C1** (the server never receives message plaintext), **C2**
(platform-agnostic feature logic lives in the shared `@chat-app/crypto` core so web and mobile render
through one path), and **C3** (each feature ships with pure-core unit/property tests, plus an
integration test before being marked done).

### Explicitly out of scope (deferred)

Multi-device shadow synchronisation (parent Requirement 9 — shadow threads follow the current
single-device model); any backend or server-side change; OS-level backup, snapshot, or
storage-size analysis (documented in the hidden-chat threat model, not addressed here); and the
non-shadow hidden-chat secret/UX surfaces beyond the decoy/real PIN gating needed for plausible
deniability.

Two **UI-layout bugs** are explicitly **out of scope** for this feature and are tracked separately as
their own fixes: (a) the status-bar/notch overlap, and (b) the `⋮` overflow menu drawing behind
messages. They are not part of this feature's acceptance criteria. The only cross-reference is that
the new long-press shadow-chat menu (Requirement 11) is specified to render as a top-level overlay
with correct z-order so it does not reproduce the same class of z-order defect.

## Glossary

- **Client_App**: The Chit-Chat client on either the Mobile_App (React Native / Expo, `apps/mobile`)
  or the Web_App (Next.js, `apps/web`); a requirement attributed to the Client_App applies to both
  platforms unless a platform is named explicitly.
- **Backend_Server**: The deployed Phase 0/1 backend at `api.luminchat.app` (REST on `api.`,
  WebSocket on `ws.`). For this feature the Backend_Server is **frozen**: its code, wire envelope,
  acknowledgement format, and codec are unchanged.
- **Surface_Chat**: The normal, visible 1:1 conversation with a contact, identified by the contact's
  Firebase UID, exactly as delivered in Phase 1.
- **Shadow_Thread**: An invisible, independent parallel conversation with the same contact,
  identified by a derived `threadId`. A contact may have **any number** of Shadow_Threads, each bound
  to a distinct Alias; there is no per-contact or overall cap.
- **threadId**: The deterministic, symmetric hexadecimal identifier of a Shadow_Thread, produced by
  the Thread_Id_Deriver. Absent ⇒ Surface_Chat; present ⇒ Shadow_Thread.
- **Master_Secret**: The device-local shadow master secret that seeds `threadId` derivation. Never
  transmitted off the device; released only in real-PIN mode.
- **Alias_Key**: The device-local HMAC key used to hash and match aliases. Never transmitted off the
  device; released only in real-PIN mode.
- **Shadow_Context**: The pair `{ Master_Secret, Alias_Key }` returned by the Shadow_Secret_Store in
  real-PIN mode.
- **Alias**: A user-private string beginning with `/` (for example `/contact1`) typed into the chat
  search bar to open a Shadow_Thread; its normalised grammar is `/` followed by one or more
  lowercase alphanumeric characters.
- **Alias_Entry**: A device-local mapping `{ aliasHash, ref: { peerUid, threadId, pinVerifier? } }`
  where `aliasHash` is the HMAC of the normalised Alias under the Alias_Key and the optional
  `pinVerifier` is the hash-only PBKDF2 verifier of the Alias's optional per-chat PIN. The plaintext
  Alias and the plaintext per-chat PIN are never stored.
- **Thread_Id_Deriver**: The pure-core function
  `deriveShadowThreadId(masterSecret, uidA, uidB, alias?)` that computes a `threadId` as a hex
  HMAC-SHA256 over the canonically sorted UID pair plus the literal `"shadow"`, optionally followed by
  the ASCII Unit Separator `0x1f` and the normalised Alias when an Alias discriminator is supplied.
- **Alias_Resolver**: The search-bar adapter logic that detects alias input and resolves it to a
  Shadow_Thread via the pure-core `isAliasInput` / `matchAlias` functions.
- **Content_Payload_Codec**: The pure-core `encodeContentPayload` / `decodeContentPayload` pair that
  serialises and parses the encrypted message body, including the optional `threadId`.
- **Content_Envelope**: The encoded content payload that is encrypted as the libsignal plaintext; it
  carries the discriminated message `type`, the body, and the optional `threadId`.
- **Ciphertext_Envelope**: The on-wire WebSocket frame carrying routing metadata (sender UID,
  recipient UID, sender deviceId, sequence number) and the libsignal ciphertext, with no plaintext
  and no `threadId`.
- **Messaging**: The shared `@chat-app/crypto` send/receive component that routes inbound and
  outbound messages between Surface_Chat and Shadow_Thread by `threadId`.
- **Shadow_Sequence_Allocator**: The pure-core allocator that issues shadow sequence numbers offset
  by `SHADOW_SEQ_OFFSET` (`1e9`), contiguous per Shadow_Thread, from a dedicated `shadow:${threadId}`
  counter.
- **SHADOW_SEQ_OFFSET**: The constant `1_000_000_000` (`1e9`) that separates shadow sequence numbers
  from surface sequence numbers in the shared acknowledgement and reducer key spaces.
- **Conversation_Registry**: The component that holds a separate Conversation_State per conversation
  (Surface_Chat or Shadow_Thread), routes events by key, and excludes Shadow_Threads from the default
  chat list, notifications, and previews.
- **Conversation_State**: The immutable per-conversation snapshot (message history, gap-detection
  state, reactions, edits, deletes, timers) produced by the shared pure reducer.
- **Shadow_Secret_Store**: The device-local component that persists the Master_Secret, the Alias_Key,
  and the Alias_Entry mappings, releasing them only in real-PIN mode.
- **App_Lock**: The pure-core `resolveAppMode` logic that resolves an entered PIN to App_Mode `real`,
  `decoy`, or `null`.
- **App_Mode**: The result of PIN resolution — `real` (full access), `decoy` (innocuous deniable
  state), or `null` (no PIN matched; indistinguishable between "no PIN set" and "wrong PIN").
- **Key_Store**: The on-device encrypted storage (SQLCipher on mobile, in-memory on web) used for
  sequence counters and device-local secrets.
- **Long_Press_Menu**: The overlay popup menu opened by a press-and-hold (long-press) gesture on a
  chat-list row or a contact / new-chat row; in App_Mode `real` it includes a "Shadow chat" action.
- **Shadow_Chat_Creation_Sheet**: The sheet opened from the "Shadow chat" action that collects a new
  Alias and an optional per-chat PIN before binding a new Shadow_Thread.
- **Per_Chat_PIN**: An optional, user-chosen secret that gates re-entry to a single Shadow_Thread.
  Its default is none; when set it is stored only as the hash-only PBKDF2 `pinVerifier` on the
  Alias_Entry. It is independent of the App_Lock PIN.
- **Secret_Hasher**: The pure-core `secret-hash.ts` component (`hashSecret` / `verifySecret`,
  PBKDF2-HMAC-SHA256) used to produce and verify the per-chat PIN `pinVerifier`.
- **Pbkdf2_Provider**: The injected, off-UI-thread provider that runs PBKDF2 work for the
  Secret_Hasher so that per-chat PIN hashing and verification never block the user interface.

## Requirements

### Requirement 1: Open a Shadow Thread via a Private Alias

**User Story:** As an at-risk user, I want to open a contact's shadow thread by typing a private `/alias` into the chat search bar, so that I can reach a hidden conversation without anything else in the app revealing that the conversation exists.

#### Acceptance Criteria

1. WHEN a user enters search-bar text that, after removing all leading and trailing whitespace, begins with the `/` character, THE Alias_Resolver SHALL treat the text as alias input and evaluate it through the pure-core alias-matching path.
2. THE Alias_Resolver SHALL classify alias input as a grammatically valid normalised alias only when, after trimming surrounding whitespace and removing the single leading `/`, the remaining normalised text is between 1 and 64 characters in length and contains no whitespace characters; otherwise THE Alias_Resolver SHALL classify the alias input as invalid.
3. WHEN the Client_App is in App_Mode `real` and the entered alias input is a grammatically valid normalised alias whose hash equals a stored Alias_Entry's `aliasHash`, THE Alias_Resolver SHALL resolve the input to that entry's Shadow_Thread reference `{ peerUid, threadId }` and SHALL open that Shadow_Thread within 1 second of the match completing.
4. IF the entered alias input is not a grammatically valid normalised alias, OR is a grammatically valid normalised alias whose hash matches no stored Alias_Entry, THEN THE Alias_Resolver SHALL return no shadow result and SHALL present the input as an ordinary search, such that a wrong alias and a non-existent alias produce identical observable behaviour, including a total elapsed matching time that differs between the two cases by no more than 50 milliseconds.
5. WHILE the Client_App is in any App_Mode other than `real`, THE Alias_Resolver SHALL NOT resolve any alias input to a Shadow_Thread and SHALL present the input as an ordinary search.
6. THE Alias_Resolver SHALL examine every stored Alias_Entry when matching an alias, without short-circuiting on the first match, such that the total elapsed matching time varies by no more than 50 milliseconds regardless of which entry matches or whether any entry matches.
7. THE Client_App SHALL allow any number of distinct Shadow_Threads to be associated with each contact, and any number of Shadow_Threads overall, each Shadow_Thread bound to a distinct Alias, and SHALL impose no per-contact or global cap on the number of Shadow_Threads.
8. WHEN a binding between an alias and a contact's Shadow_Thread is created in App_Mode `real`, THE Client_App SHALL derive the `threadId` from the Thread_Id_Deriver and SHALL store the mapping as an Alias_Entry hash through the Shadow_Secret_Store.

### Requirement 2: Deterministic, Symmetric Thread-Id Derivation

**User Story:** As a privacy-conscious user, I want both devices to agree on a shadow thread's identity without any setup exchange, so that opening a hidden conversation leaves no negotiation traffic an observer could correlate.

#### Acceptance Criteria

1. WHEN the Thread_Id_Deriver is given a non-empty Master_Secret and two non-empty contact UIDs, THE Thread_Id_Deriver SHALL compute the `threadId` as a 64-character lowercase hexadecimal string equal to the HMAC-SHA256, keyed by the Master_Secret, computed over the two UIDs sorted in ascending byte-wise lexicographic order and concatenated with the literal ASCII string `"shadow"`.
2. THE Thread_Id_Deriver SHALL produce an identical `threadId` for a given Master_Secret and UID pair regardless of the order in which the two UIDs are supplied.
3. THE Thread_Id_Deriver SHALL produce a `threadId` that is byte-for-byte identical across repeated calls for the same Master_Secret and UID pair.
4. WHEN two distinct Master_Secrets are used for the same UID pair, THE Thread_Id_Deriver SHALL produce different `threadId` values, so that thread identities are compartmentalised by Master_Secret.
5. IF the Thread_Id_Deriver is given an empty Master_Secret, or either UID is empty or missing, or the two supplied UIDs are identical, THEN THE Thread_Id_Deriver SHALL return an error indicating invalid input and SHALL NOT produce a `threadId`.
6. THE Thread_Id_Deriver SHALL derive the `threadId` using only the provided Master_Secret and UID pair as inputs, requiring no handshake, network round-trip, or message exchange between the two devices to converge on that value.
7. WHEN the Thread_Id_Deriver is supplied a grammatically valid normalised Alias discriminator together with a non-empty Master_Secret and two distinct non-empty UIDs, THE Thread_Id_Deriver SHALL compute the `threadId` as the HMAC-SHA256, keyed by the Master_Secret, over the two UIDs sorted in ascending byte-wise lexicographic order, concatenated with the literal ASCII string `"shadow"`, followed by the ASCII Unit Separator byte `0x1f`, followed by the normalised Alias.
8. WHEN the Thread_Id_Deriver is supplied two distinct grammatically valid normalised Aliases for the same Master_Secret and UID pair, THE Thread_Id_Deriver SHALL produce two different `threadId` values, so that distinct Aliases identify distinct Shadow_Threads for the same contact.
9. WHEN no Alias discriminator is supplied (the Alias argument is omitted, empty, or absent), THE Thread_Id_Deriver SHALL produce a `threadId` that is byte-for-byte identical to the value produced by the pre-discriminator derivation for the same Master_Secret and UID pair, so that previously derived single-thread identifiers remain valid without migration.
10. THE Thread_Id_Deriver SHALL produce, for every Master_Secret, UID pair, and valid Alias, a discriminated `threadId` that is not equal to any `threadId` derived without an Alias discriminator, because the `0x1f` separator cannot occur in a normalised Alias or in a UID, making the discriminated and non-discriminated identifier spaces disjoint.
11. WHEN an Alias discriminator is supplied, THE Thread_Id_Deriver SHALL produce an identical `threadId` regardless of the order in which the two UIDs are supplied and SHALL produce a byte-for-byte identical `threadId` across repeated calls for the same Master_Secret, UID pair, and Alias, so that both peers converge on the same discriminated identifier offline from only the shared Master_Secret and the shared Alias with no handshake.
12. IF the Thread_Id_Deriver is supplied an Alias discriminator that is not a grammatically valid normalised Alias, THEN THE Thread_Id_Deriver SHALL return an error indicating invalid input and SHALL NOT produce a `threadId`.

> Aligns with design Correctness Property 1 (deterministic, symmetric, alias-discriminated, no-handshake derivation), Correctness Property 1b (alias-discrimination collision-resistance and legacy compatibility), and parent Requirement 8 / §9.4 (no-handshake derivation).

### Requirement 3: Server-Blind Wire Compatibility

**User Story:** As a security owner, I want shadow messages to be indistinguishable from surface messages on the wire, so that the frozen backend stays fully blind and cannot detect or enumerate hidden threads.

#### Acceptance Criteria

1. THE Client_App SHALL carry the `threadId` only inside the encrypted Content_Envelope and SHALL NOT place the `threadId` in the Ciphertext_Envelope or any other server-visible field.
2. WHEN the Client_App transmits a shadow message, THE Ciphertext_Envelope placed on the WebSocket SHALL contain no `threadId` field and no message plaintext, and SHALL be indistinguishable from the Ciphertext_Envelope of a surface message between the same UID pair, where indistinguishable means the two envelopes have an identical set of field names, an identical field count, identical field data types for each corresponding field, and identical field ordering.
3. THE Client_App SHALL NOT introduce any new WebSocket frame, any change to the Ciphertext_Envelope shape, any change to the acknowledgement format, or any change to the codec used by the Backend_Server.
4. THE Client_App SHALL transmit shadow message content only as libsignal ciphertext and SHALL NOT transmit shadow message plaintext to the Backend_Server or any other network endpoint.
5. THE Backend_Server SHALL remain unmodified, such that it relays a shadow Ciphertext_Envelope and echoes its acknowledgement using only the UID pair and the client-chosen sequence number, with no server-visible field by which it can determine whether the message belongs to a Surface_Chat or a Shadow_Thread.
6. IF the Client_App cannot construct a shadow Ciphertext_Envelope that is indistinguishable from a surface Ciphertext_Envelope as defined in criterion 2, THEN THE Client_App SHALL NOT transmit the shadow message to the Backend_Server, SHALL retain the shadow message content locally, and SHALL surface a send-failure indication to the user.

> Aligns with design Correctness Property 5, parent Requirement 8.3, and cross-cutting C1.

### Requirement 4: Shadow Sequence Allocation

**User Story:** As a user, I want shadow messages to use their own sequence-number space, so that gap detection works within a hidden thread and shadow activity never contaminates the surface conversation's ordering, acknowledgements, reactions, or timers.

#### Acceptance Criteria

1. WHEN the Shadow_Sequence_Allocator issues a sequence number for a Shadow_Thread, THE Shadow_Sequence_Allocator SHALL return `SHADOW_SEQ_OFFSET` plus the next value of a dedicated per-thread counter keyed by `shadow:${threadId}` in the Key_Store, where the counter's first issued value is 1, such that the first allocation for any Shadow_Thread returns exactly `SHADOW_SEQ_OFFSET + 1`.
2. WHEN the Shadow_Sequence_Allocator issues successive sequence numbers for the same Shadow_Thread, THE Shadow_Sequence_Allocator SHALL return values that are strictly increasing and contiguous, increasing by exactly 1 on each successive allocation for that thread, such that per-thread gap detection is well defined.
3. THE Client_App SHALL allocate every surface sequence number below `SHADOW_SEQ_OFFSET` and every shadow sequence number at or above `SHADOW_SEQ_OFFSET`, such that the invariant `surfaceSeq < SHADOW_SEQ_OFFSET <= shadowSeq` holds for every surface sequence number `surfaceSeq` and every shadow sequence number `shadowSeq`, making the surface and shadow sequence spaces disjoint.
4. WHERE a shadow sequence number and a surface sequence number are used for the same recipient UID, THE Client_App SHALL keep their acknowledgement-matching keys (`${recipientUid}:${seq}`) and their reducer keys (`${direction}:${seq}`) non-colliding by virtue of the disjoint sequence spaces.
5. THE Shadow_Sequence_Allocator SHALL key its counter on the `threadId` and SHALL NOT let the recipient UID affect the issued sequence number.
6. IF a Key_Store read or persist operation fails while the Shadow_Sequence_Allocator is allocating a sequence number for a Shadow_Thread, THEN THE Shadow_Sequence_Allocator SHALL NOT issue a sequence number, SHALL leave the per-thread counter unchanged so that no sequence value is consumed and no gap is created, and SHALL return an error indicating the allocation failed.

> Aligns with design Correctness Properties 2 and 3 and parent Requirement 8.2.

### Requirement 5: Surface Chat Backward Compatibility

**User Story:** As an existing user, I want my normal conversations to behave exactly as before, so that adding shadow support changes nothing observable about surface chats, including with peers on older app versions.

#### Acceptance Criteria

1. WHEN the Client_App encodes a surface message that carries no `threadId`, THE Content_Payload_Codec SHALL produce a Content_Envelope string that is byte-for-byte identical to the output the pre-shadow code produced for the same input payload.
2. WHEN a message carries no `threadId` on either the inbound or the outbound path, THE Messaging send, receive, and reduce path SHALL produce the same observable result as the pre-shadow Surface_Chat behaviour for the same input — specifically the same message ordering, the same delivery and read state transitions, and the same rendered message content — and SHALL create no additional shadow-related state.
3. WHEN the Content_Payload_Codec decodes a message whose `threadId` is missing, absent (null or undefined), an empty string, or any value that is not a non-empty string, THE Content_Payload_Codec SHALL route the message to the Surface_Chat.
4. IF a Client_App that has no shadow support receives a `threadId`-bearing Content_Envelope, THEN THE receiving Client_App SHALL ignore the unrecognised `threadId` and render the decrypted message in the Surface_Chat, with no message data loss and no decryption failure.
5. THE Client_App SHALL treat any peer for which no shared Master_Secret is held as never being a shadow counterpart, because a Shadow_Thread requires both peers to hold the shared Master_Secret.

> Aligns with design Correctness Property 6 ("surface behaviour byte-for-byte unchanged when no threadId present") and design Error Handling Scenario 4 (legacy / mixed-version peers).

### Requirement 6: Content-Payload threadId Round-Trip and Total Decoding

**User Story:** As a developer, I want the content-payload serializer and parser to carry the optional `threadId` reliably and to never crash on malformed input, so that shadow routing is correct and the encrypted body remains robust.

#### Acceptance Criteria

1. WHEN the Content_Payload_Codec encodes a payload together with a `threadId` that is a non-empty string of 1 to 255 characters, THE Content_Payload_Codec SHALL include that `threadId`, byte-for-byte unchanged, in the resulting Content_Envelope string.
2. WHEN the Content_Payload_Codec decodes a Content_Envelope produced by encoding a payload with a non-empty `threadId` of 1 to 255 characters, THE Content_Payload_Codec SHALL recover a payload byte-for-byte equal to the original payload and a `threadId` exactly equal (character-for-character) to the encoded `threadId`.
3. WHEN the Content_Payload_Codec decodes a Content_Envelope produced by encoding a payload without a `threadId`, THE Content_Payload_Codec SHALL recover a payload byte-for-byte equal to the original payload and SHALL report the `threadId` as absent.
4. IF a decoded Content_Envelope carries a `threadId` value that is missing, an empty string, not a string, or longer than 255 characters, THEN THE Content_Payload_Codec SHALL report the `threadId` as absent and SHALL recover the payload byte-for-byte equal to the original payload.
5. THE Content_Payload_Codec SHALL apply identical per-type payload validation rules and produce an identical pass/fail outcome for a given payload regardless of whether the optional `threadId` is present or absent.
6. THE Content_Payload_Codec SHALL return a decode result for any input string without throwing.
7. IF the Content_Payload_Codec receives an input string that cannot be decoded into a valid Content_Envelope, THEN THE Content_Payload_Codec SHALL return a decode-failure result with `threadId` absent and SHALL NOT throw.

> Aligns with design Correctness Property 7 (round-trip plus totality) and cross-cutting C1.

### Requirement 7: Per-Thread Conversation Isolation and Default-View Exclusion

**User Story:** As an at-risk user, I want each shadow thread's history and activity kept fully separate from the surface conversation and hidden from the default views, so that hidden content never leaks through shared state, the chat list, notifications, or previews.

#### Acceptance Criteria

1. THE Conversation_Registry SHALL maintain exactly one Conversation_State instance per conversation, keyed by `surface:${remoteUid}` for a Surface_Chat and `shadow:${threadId}` for a Shadow_Thread, such that no two conversations reference the same Conversation_State instance.
2. WHEN a `threadId`-tagged event is applied, THE Conversation_Registry SHALL route the event exclusively to the Conversation_State keyed by `shadow:${threadId}`, leaving every other Conversation_State's messages, reactions, edits, deletes, and disappearing-timer values unchanged.
3. WHEN a reaction, edit, delete, or disappearing-timer event is applied with a given `threadId`, THE Conversation_Registry SHALL apply the event only to the Conversation_State keyed by `shadow:${threadId}` and SHALL leave the Surface_Chat Conversation_State and all other Shadow_Thread Conversation_States unmodified.
4. THE Conversation_Registry SHALL compute gap detection independently per conversation, using only the sequence numbers recorded in that conversation's Conversation_State and ignoring sequence numbers belonging to all other conversations.
5. WHEN the default chat-list view is requested, THE Conversation_Registry SHALL return only Surface_Chat entries and SHALL return zero Shadow_Thread entries.
6. WHEN an inbound event carries a `threadId`, THE Client_App SHALL suppress every operating-system notification, in-app notification, and message-preview rendering for that event, such that no Shadow_Thread content appears in any notification, the chat list, or any preview.
7. WHEN an inbound event carries no `threadId`, THE Conversation_Registry SHALL route the event only to the Surface_Chat Conversation_State keyed by `surface:${remoteUid}`.
8. IF an inbound event references a `threadId` that has no corresponding Shadow_Thread Conversation_State in the Conversation_Registry, THEN THE Conversation_Registry SHALL reject the event, SHALL leave every existing Conversation_State unmodified, and SHALL surface an error indication identifying the unknown thread.

> Aligns with design Correctness Property 8 and parent Requirement 8.2.

### Requirement 8: Decoy and Real PIN Gating for Plausible Deniability

**User Story:** As an at-risk user under coercion, I want a decoy PIN that opens an innocuous state revealing nothing about hidden threads, so that I retain plausible deniability and the existence of the shadow feature cannot be proven.

#### Acceptance Criteria

1. WHEN a PIN is entered, THE App_Lock SHALL resolve it to App_Mode `real`, `decoy`, or `null`, evaluating the real PIN before the decoy PIN, and SHALL present identical user feedback (no mode-specific message, animation, or error indication) across all three outcomes such that the resolution-to-feedback time differs by no more than 50 milliseconds between any of `real`, `decoy`, and `null`, making `null` indistinguishable between "no PIN set" and "wrong PIN".
2. WHILE the Client_App is in App_Mode `decoy` or `null`, THE Shadow_Secret_Store SHALL return no Shadow_Context, such that no `threadId` can be derived.
3. WHILE the Client_App is in App_Mode `decoy` or `null`, THE Shadow_Secret_Store SHALL return an empty list of Alias_Entry mappings, such that no alias resolves and no Shadow_Thread is listed, notified, or previewed.
4. WHILE the Client_App is in App_Mode `decoy` or `null`, THE Alias_Resolver SHALL render alias input through the same interface as the standard non-shadow search field, SHALL return only matches drawn from the non-shadow dataset, SHALL NOT display any Shadow_Thread, special result, hint, or distinct error, and SHALL NOT open any Shadow_Thread.
5. WHEN the Client_App is in App_Mode `real`, THE Shadow_Secret_Store SHALL release the Shadow_Context and the stored Alias_Entry mappings to the shadow feature.
6. WHILE the Client_App is in App_Mode `decoy` or `null`, THE Client_App SHALL produce observationally identical results across both modes — including visible state, returned data, presented feedback, and response timing differing by no more than 50 milliseconds — such that no observer can determine which of the two modes is active.
7. IF the Shadow_Secret_Store encounters an error WHILE the Client_App is in App_Mode `real`, THEN THE Shadow_Secret_Store SHALL fail closed by releasing no Shadow_Context and no Alias_Entry mappings, and THE Client_App SHALL remain observationally identical (visible state, returned data, feedback, and response timing within 50 milliseconds) to App_Mode `decoy` or `null`.

> Aligns with design Correctness Property 10 and parent Requirement 8.1 / §6.1.

### Requirement 9: Device-Local Secret and Mapping Persistence

**User Story:** As a privacy-conscious user, I want shadow secrets and alias mappings stored only on my device and never in plaintext, so that the secrets never reach the server and a device or database dump reveals neither the alias text nor the existence of a mapping.

#### Acceptance Criteria

1. THE Shadow_Secret_Store SHALL persist the Master_Secret and the Alias_Key only within the encrypted Key_Store on the device, and SHALL NOT transmit the Master_Secret or the Alias_Key — in plaintext, encrypted, or any derived form — to the Backend_Server or to any other network endpoint.
2. THE Shadow_Secret_Store SHALL store each alias-to-thread mapping only as an Alias_Entry whose `aliasHash` is the HMAC of the normalised alias under the Alias_Key, and SHALL NOT persist the plaintext alias, the normalised alias, or any reversible encoding of either in any structure.
3. THE Shadow_Sequence_Allocator SHALL persist its per-thread counter under the conversation key `shadow:${threadId}` in the Key_Store such that, for each thread, every successive allocated value is exactly one greater than the previously allocated value, with no gaps, no duplicate values, and no counter resets across Shadow_Sequence_Allocator instances.
4. THE Client_App SHALL gate access to the Master_Secret, the Alias_Key, and the Alias_Entry mappings behind App_Mode `real`, consistent with Requirement 8.
5. THE Client_App SHALL store shadow secrets and mappings only through the existing encrypted Key_Store mechanism (SQLCipher on the Mobile_App, in-memory on the Web_App) and SHALL NOT write them to any unencrypted storage location.
6. WHILE App_Mode is not `real`, THE Client_App SHALL deny all read and write access to the Master_Secret, the Alias_Key, and the Alias_Entry mappings.
7. IF a Key_Store write of a shadow secret or alias mapping fails, THEN THE Shadow_Secret_Store SHALL abort the write operation, SHALL NOT leave any partial or plaintext secret or mapping persisted, and SHALL surface an error indication to the Client_App identifying the failed persistence operation.
8. THE Shadow_Secret_Store SHALL persist the Master_Secret, the Alias_Key, and the Alias_Entry mappings — including each Alias_Entry's optional per-chat PIN `pinVerifier` — durably within the encrypted Key_Store on the Mobile_App (SQLCipher vault), such that they survive Client_App restarts, and as in-memory state on the Web_App; WHEN the Mobile_App is restarted, an Alias that resolved to a Shadow_Thread before the restart SHALL resolve to the same Shadow_Thread after the restart.
9. THE Shadow_Secret_Store SHALL persist each optional per-chat PIN only as the hash-only `pinVerifier` within the corresponding Alias_Entry, and SHALL NOT persist the plaintext per-chat PIN, nor any reversible encoding of it, in any structure.

> Aligns with design Correctness Property 9 (alias plaintext never persisted), Correctness Property 12 (durable persistence round-trip across restarts), and parent §9.3 / §9.4 and cross-cutting C1.

### Requirement 10: Verifiability and Core-First Delivery

**User Story:** As an engineer, I want the shadow feature proven correct by pure-core tests and a two-client end-to-end test before any UI work begins, so that surface/shadow separation is demonstrated and the no-undecryptable-message failure class is not reintroduced.

#### Acceptance Criteria

1. THE shadow feature SHALL ship pure-core unit and property tests (no network, filesystem, or UI dependencies) covering the Content_Payload_Codec `threadId` round-trip and decode totality, the Thread_Id_Deriver alias-discriminated derivation (distinct valid Aliases for the same pair yielding distinct `threadId` values, an omitted Alias reproducing the byte-for-byte legacy `threadId`, and disjointness of the discriminated and legacy identifier spaces), the Shadow_Sequence_Allocator offset and contiguity, the Conversation_Registry routing and exclusion, the Shadow_Secret_Store real-versus-decoy behaviour, the optional per-chat PIN gating including set, change, and removal performed after creation (hash-only persistence and off-UI-thread verification), the durable persistence round-trip across a simulated Client_App restart, and the alias indistinguishability and hash-only persistence.
2. WHEN the Content_Payload_Codec decode test executes, THE shadow feature SHALL verify decode totality such that every input byte sequence (including empty, maximum-length, and arbitrary random sequences) returns either a valid decoded payload or a defined decode-failure result, and SHALL fail the test if any input raises a thrown exception or unhandled error.
3. Each property test SHALL execute a minimum of 100 randomised iterations and SHALL reference the design Correctness Property it validates.
4. IF any single randomised iteration of a property test produces a counterexample that violates the referenced Correctness Property, THEN THE property test SHALL fail and SHALL report the counterexample input.
5. THE shadow feature SHALL provide a two-client end-to-end test in which two Messaging instances sharing one Master_Secret independently derive `threadId` values that are equal byte-for-byte, exchange at least 10 surface messages and at least 10 shadow messages with at least one surface message and at least one shadow message sent in each direction, and assert that each client's Surface_Chat and Shadow_Thread states contain only their own messages with sequence ranges that share no common sequence value.
6. THE two-client end-to-end test SHALL capture every frame placed on the transport and SHALL assert that no `threadId` and no plaintext ever appear on the wire and that a shadow Ciphertext_Envelope and a surface Ciphertext_Envelope expose an identical field-name set and identical field count, such that no single per-frame attribute classifies a frame as surface or shadow.
7. WHILE the two-client end-to-end test has not passed, THE shadow feature SHALL prevent any UI work, comprising search-bar alias interception and chat-list, notification, and preview exclusion, from beginning.

> Aligns with cross-cutting C3 (verifiable) and C2 (shared core), the design's "core-first" sequencing and end-to-end test as the explicit gate, and Correctness Properties 1, 1b, 11, and 12.

### Requirement 11: Create a Shadow Chat from a Long-Press Menu

**User Story:** As an at-risk user, I want to create a new shadow chat for a contact from a long-press menu, so that I can start a hidden conversation without anything in the surface chat changing and without leaving a visible trace.

#### Acceptance Criteria

1. WHEN a user performs a press-and-hold (long-press) gesture on a chat-list row or on a contact / new-chat row, THE Client_App SHALL open the Long_Press_Menu for that row.
2. WHILE the Client_App is in App_Mode `real`, THE Long_Press_Menu SHALL include a "Shadow chat" action.
3. WHILE the Client_App is in any App_Mode other than `real`, THE Long_Press_Menu SHALL NOT include the "Shadow chat" action and SHALL present only the ordinary row actions.
4. WHEN the user selects the "Shadow chat" action in App_Mode `real`, THE Client_App SHALL open the Shadow_Chat_Creation_Sheet containing an Alias input field and an optional per-chat PIN input field, where the per-chat PIN field is blank by default.
5. THE Shadow_Chat_Creation_Sheet SHALL accept the entered Alias only when, after normalisation through the same normalisation used by the Alias_Resolver, the Alias begins with `/` and is a grammatically valid normalised Alias; otherwise THE Shadow_Chat_Creation_Sheet SHALL reject the Alias and SHALL NOT create a Shadow_Thread.
6. WHEN the user confirms the Shadow_Chat_Creation_Sheet in App_Mode `real` with a grammatically valid normalised Alias, THE Client_App SHALL derive a new alias-discriminated `threadId` for that contact from the Thread_Id_Deriver using the entered Alias as the discriminator and SHALL persist a hash-only Alias_Entry binding that Alias to the new Shadow_Thread through the Shadow_Secret_Store.
7. WHEN a Shadow_Thread is created through the Shadow_Chat_Creation_Sheet, THE Client_App SHALL NOT disturb the contact's Surface_Chat, meaning it SHALL send no message, SHALL advance no surface sequence number, and SHALL mutate no Surface_Chat Conversation_State.
8. THE Client_App SHALL render the Long_Press_Menu as a top-level overlay (a modal portal) drawn above all other chat-list and conversation content, such that the menu and any shadow-chat content it leads to are never drawn behind other user-interface elements.
9. WHEN a Shadow_Thread has been created through the Shadow_Chat_Creation_Sheet, THE Client_App SHALL keep that Shadow_Thread fully hidden from the default chat list, notifications, and previews, and SHALL make it re-enterable only by entering its bound `/alias` through the Alias_Resolver.
10. IF the user attempts to create a Shadow_Thread while the Client_App is in any App_Mode other than `real`, THEN THE Client_App SHALL perform no binding, SHALL persist nothing, and SHALL leave all existing state unchanged.

> Aligns with design Correctness Property 13 (creation-flow inertness under decoy/locked mode), Correctness Property 1b (alias-discriminated derivation), and parent Requirement 8.1 / 8.2.

### Requirement 12: Optional Per-Chat PIN Lock

**User Story:** As an at-risk user, I want each shadow chat to optionally carry its own PIN that I can set at creation or add later, so that I can add a second lock to especially sensitive threads while keeping it entirely my choice.

#### Acceptance Criteria

1. THE Client_App SHALL treat the per-chat PIN as optional, defaulting to no per-chat PIN, and SHALL NOT require a per-chat PIN to create or open any Shadow_Thread.
2. WHEN a user enters the bound `/alias` of a Shadow_Thread whose Alias_Entry has no `pinVerifier` set, THE Client_App SHALL open that Shadow_Thread directly without prompting for a per-chat PIN.
3. WHEN a user enters the bound `/alias` of a Shadow_Thread whose Alias_Entry has a `pinVerifier` set, THE Client_App SHALL prompt for the per-chat PIN and SHALL open the Shadow_Thread only when `verifySecret` confirms the entered per-chat PIN against the stored `pinVerifier`.
4. IF the entered per-chat PIN does not verify against the stored `pinVerifier`, THEN THE Client_App SHALL present a generic failure with no shadow-specific signal and SHALL NOT open the Shadow_Thread.
5. WHEN the user is in App_Mode `real`, THE Client_App SHALL allow the per-chat PIN of a Shadow_Thread to be set at creation through the Shadow_Chat_Creation_Sheet and, on an already-created Shadow_Thread, to be added, changed, or removed through a chat settings or options action, treating both paths as first-class.
6. THE Client_App SHALL store the per-chat PIN only as the hash-only `pinVerifier` produced by the Secret_Hasher (PBKDF2 via `secret-hash.ts`) on the Alias_Entry, and SHALL NOT persist the plaintext per-chat PIN and SHALL NOT transmit the per-chat PIN to any network endpoint, whether the per-chat PIN is set at creation or set, changed, or removed later.
7. WHEN the Client_App verifies a per-chat PIN or performs a later set, change, or removal of a per-chat PIN, THE Client_App SHALL run the PBKDF2 work on the Pbkdf2_Provider off the user-interface thread and SHALL display a progress indicator while the operation is in flight, such that the user interface does not freeze.
8. WHILE the Client_App is in App_Mode `decoy` or `null`, THE Client_App SHALL NOT present any per-chat PIN settings entry point, and any per-chat PIN set, change, or removal operation SHALL be inert, performing no operation and persisting nothing.

> Aligns with design Correctness Property 11 (per-chat PIN gating including later set/change/remove, hash-only and off-thread) and parent Requirement 8.1 (no shadow-specific signal on failure).
