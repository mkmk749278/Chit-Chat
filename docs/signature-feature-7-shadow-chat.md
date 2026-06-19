# Signature Feature 7 — Dual-Layer Shadow Chat with `/alias` Command System

> Design + threat model. Source of truth: `private-chat-app-requirements.md` §9.
> Status: **cryptographic core shipped + tested** (`packages/crypto/src/shadow-chat.ts`); the
> dual-thread *messaging* is a gated follow-up (see §5 — it needs server envelope thread-id routing
> and a security review, per the Wave-3 gate).

## 1. Problem

Even a hidden chat (§3) leaves the *contact* visible — anyone can open contacts, find the person,
and see (or infer) the conversation. A shadow chat solves the contact layer: each contact can have a
completely independent, invisible parallel thread — separate history, separate keys, separate server
thread id — reachable only by typing a private `/alias` in the search bar (§9.1, §9.2).

## 2. Cryptographic core (this PR, pure + tested)

`packages/crypto/src/shadow-chat.ts`:

- **Server-opaque thread id** (§9.4) — both parties derive it identically, client-side, with no
  server involvement, so the relay only ever sees "two conversations between the same users":

  ```
  shadow_thread_id = HMAC-SHA256(key = shadow_master_secret,
                                 data = canonical_sort(uidA, uidB) + "shadow")
  ```

  `canonicalSortUids` joins with a separator so distinct uid pairs can't collide by concatenation.

- **`/alias` grammar** (§9.3) — `isAliasInput` (the `/`-prefix interception trigger) and
  `normalizeAlias` (must start with `/`, case-insensitive, ASCII-alphanumeric only, no spaces).

- **Local-only alias storage** (§9.3) — `hashAlias` stores aliases as an HMAC hash under a
  device-local key, never plaintext; `matchAlias` resolves a typed input to its shadow chat and
  returns the matched entry only. A wrong alias and a non-existent alias yield the identical `null`,
  so the app never confirms an alias exists (§9.3 "what an observer sees" table). Knowing one alias
  reveals nothing about others (independent hashes → compartmentalisation).

All functions are pure WebCrypto, shipped byte-for-byte to web + mobile (Requirement C2); the master
secret and alias key are device-local and never reach the server (§9.3, §9.4). Covered by
`shadow-chat.test.ts` (symmetry, master/pair sensitivity, grammar, case-insensitivity, indistinguishable
miss, compartmentalisation).

## 3. Threat model (§9.5)

| Surface | Handling |
|---|---|
| Server learns a thread is shadow | No — thread id is a client-side HMAC; the server sees two ordinary conversations (§9.4). |
| DB / device dump reveals aliases | Aliases stored only as HMAC hashes; plaintext never persisted (§9.3). |
| Observer probing the search bar | Wrong-alias and no-alias are identical (`null`); no confirmation of existence (§9.3). |
| One alias compromised | Independent per-alias hashes; reveals nothing about other shadow chats. |
| Chat list / contacts / notifications / presence | Shadow activity must not surface anywhere — covered by the messaging milestone below + the silent-push / FLAG_SECURE / backup-exclusion work shared with §3. |

## 4. Mobile entry point

The chat-list search bar already intercepts submit for hidden-chat reveal (§3.3); the same hook routes
a `/`-prefixed input through `matchAlias` against the local alias store, so the surface UI exposes no
"aliases exist" affordance (§9.3 "alias list never shown"). Setup (long-press chat header → set alias
+ shadow secret, §9.7) and the private unread indicator (§9.6) attach to this hook.

## 5. Dual-thread messaging — the gated implementation milestone

Shipping truly separate shadow *threads* (separate history + keys + server thread id) requires changes
beyond the client crypto core, which is why it is staged behind this design (Wave-3 "design + security
review required"):

1. **Envelope thread-id routing** — the relay currently keys delivery by `recipientUid`; the
   `CiphertextEnvelope` + offline-queue + reducer keying must carry an opaque `threadId` so surface
   and shadow messages to the same uid stay separate end-to-end (server stays blind to which is which).
2. **Separate shadow E2E session** — bootstrap a shadow session over the existing surface channel,
   then run it independently (§9.7 step 4–6); both parties must set up before it activates.
3. **Isolated on-device storage** — shadow rows/sessions in a separate, secret-gated vault partition,
   excluded from search, list, presence, notifications, and backups (§9.5).
4. **Private unread indicator** (§9.6) and decoy-mode suppression (shadow chats never appear in decoy
   state, ties to §6).

These land as a follow-up PR with its own security review; this PR establishes and verifies the
cryptographic foundation they build on.
