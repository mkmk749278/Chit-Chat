# Signature Features 1 & 4 — Hidden Chats + Decoy PIN / Duress App State

> Design + threat model. Source of truth: `private-chat-app-requirements.md` §3 (hidden chats) and
> §6 (decoy PIN). Status: **crypto core + encrypted-vault persistence + mobile lock gate + hidden
> reveal/hide shipped**; the items in _Limitations_ are tracked follow-ups.

## 1. Why both, together

They defend different threat models and compose (§9.8):

- **Hidden chat (§3)** — defeats *someone browsing your chat list*: a hidden chat disappears from
  the list and is reachable only by typing its secret in the search bar.
- **Decoy PIN (§6)** — defeats *someone forcing you to unlock*: a second PIN opens a sanitised app
  state with no hidden/shadow chats, visually indistinguishable from the real app.

## 2. Cryptographic core (pure, in `@chat-app/crypto`)

| Module | Role |
|---|---|
| `secret-hash.ts` | Salted **PBKDF2-HMAC-SHA256** verifiers for hidden-chat secrets and app PINs. Self-describing format `pbkdf2$sha256$<iters>$<salt>$<hash>`; constant-time verify. Secrets/PINs are never stored in plaintext (§3.1, §6.2 / D8). |
| `lockout-policy.ts` | Pure, clock-injected rate-limit: **5 failures / 10 min → 30 min lockout** (`DEFAULT_LOCKOUT_POLICY`), sliding window, self-expiring. Drives timing-only feedback with no attempt counter (§3.1). |
| `app-lock.ts` | `resolveAppMode(pin, verifiers)` → `real | decoy | null`. Real-PIN-first, reveals nothing beyond the mode (§6.2). |

All three are dependency-free WebCrypto and fully unit-tested (incl. salt uniqueness, lockout
timing, decoy resolution). PBKDF2 is used in place of the spec's bcrypt because the shared crypto
package is intentionally native-addon-free; the encoded format lets the work factor rise later, and
migrating to argon2/bcrypt behind the same interface is an open option.

## 3. On-device integration (mobile)

- **Encrypted storage** — verifiers + the failed-attempt log live in the AES-256-CBC+HMAC vault
  (`VaultDoc.appPins`, `VaultDoc.hiddenChats`, `VaultDoc.unlockFailures`), so even the *existence* of
  a hidden chat is not in plaintext storage. `secure-gate.ts` binds the crypto core to the vault and
  exposes `hasRealPin / setPin / unlock / hideChat / unhideChat / listHiddenPeers / revealHiddenChat`.
- **App lock** — `AppLockScreen` gates the shell when a real PIN is set; `unlock` resolves real vs
  decoy and applies the shared lockout. Onboarding's PIN is now persisted as a real verifier.
- **Decoy mode** — opening with the decoy PIN runs the app in `decoy` mode: hidden chats stay hidden
  and hiding/revealing is disabled, yielding a sanitised, plausible state with no indicator of which
  mode is active (§6.1).
- **Hidden reveal** — the chat-list search bar's submit feeds `revealHiddenChat`; a matching secret
  opens that one chat (filtered from the list, opened by id), a non-match is indistinguishable from a
  failed search (§3.2). Hiding/unhiding is a per-chat header affordance.
- **Auto-rehide / relock** — backgrounding the app drops to the lock screen and closes any revealed
  hidden chat (§3.1 auto-rehide on background/lock).

## 4. Threat model

| Surface (§3.2) | Handling in this PR | Follow-up |
|---|---|---|
| Chat list / contacts | Hidden peers filtered out of both (§3.1). | — |
| Search history / suggestions | Reveal happens on submit and the field is cleared; nothing persisted by us. | OS-level search-suggestion suppression / lowest-layer input interception. |
| Coerced unlock | Decoy PIN opens a sanitised state, indistinguishable, no "which is real" tell (§6.1/6.2). | Optional duress alert on decoy login (ties to Feature 2). |
| Guessing | Shared 5/10min→30min lockout, timing-only feedback (§3.1). | — |
| At-rest secrets | Salted PBKDF2 verifiers in the AES-encrypted vault; no plaintext (§3.1/D8). | — |
| Notifications / recent-apps / backups / media gallery | Out of scope of this PR. | FLAG_SECURE app-wide (§10.1), silent FCM, backup exclusion, MediaStore exclusion. |

## 5. Limitations / follow-ups

- **Decoy = separate key bundle (§6.2).** v1 decoy mode is a sanitised *view* of the real account
  (hidden/shadow chats suppressed), not a fully separate E2E identity with pre-populated decoy
  contacts. A separate decoy key bundle + curated decoy data is a larger follow-up.
- **Per-secret lockout.** The lockout log is shared across PIN + hidden-chat attempts; per-target
  lockouts are a refinement.
- **OS leak surfaces** (FLAG_SECURE, backups, MediaStore, notification history) are app/native-config
  work tracked in the roadmap (§10.1, §3.2) — not addressed here.
- **Secret change from within the revealed chat** (§3.3) reuses the hide sheet; an explicit
  change-secret + re-auth flow is a small follow-up.
