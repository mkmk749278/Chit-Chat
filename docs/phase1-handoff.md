# Phase 1 — Engineering Hand‑off (remaining work)

This document hands off the **environment‑gated** parts of Phase 1 (Client Messaging) — the
work that needs a platform toolchain (Expo/React‑Native), a browser‑WASM crypto build, or
live services (Firebase, Postgres, Redis) that CI cannot provide. It records exactly what is
done, what remains, and the concrete technical decisions/gotchas discovered while building the
verifiable parts so the next engineer doesn't re‑derive them.

> Source of truth for scope remains `.kiro/specs/phase1-client-messaging/{requirements,design,tasks}.md`.
> This doc is the practical "how to finish it" companion.

---

## 1. Current state (done & CI‑verified)

| Area | Status |
| --- | --- |
| Shared types (`packages/types`) | ✅ complete |
| Shared crypto core (`packages/crypto`) | ✅ all modules implemented; **116 tests** (example + `fast-check` property + a **real libsignal round‑trip**) |
| Backend Phase‑1 additions (`apps/backend`) | ✅ `PreKeyClaimService`, `KeysController`, `MessageRelayService`, gateway `send`→relay→ACK + node pub/sub; **40 Jest tests** |
| Web client (`apps/web`) | ✅ Sign‑In + Conversation screens (on the shared reducer); all four adapters (Firebase auth, in‑memory KeyStore, WebSocketTransport, HttpClient); static checks |
| CI quality gate (`.github/workflows/pr.yml`) | ✅ green: `npm ci` → `build:packages` → `lint` → `typecheck` → `test` → `build` |

What is **NOT** done is listed in §3. The single biggest blocker is the **real libsignal engine
binding**, which is platform‑specific (see §2).

---

## 2. The critical architectural finding: the libsignal engine is platform‑specific

`packages/crypto` deliberately keeps libsignal behind two injected ports — `LibsignalEngine`
(session/cipher, in `session-manager.ts`) and `LibsignalKeyGen` (key generation, in
`identity-manager.ts`). The shared core never statically imports the native library, so it
type‑checks and runs on every platform. **Do not** add a shared concrete engine to
`packages/crypto`, because:

- **`@signalapp/libsignal-client` is a Node native addon.** It works in **Node** (backend) and
  **React Native** (which can load native addons), but **not in a browser**.
- The **web** needs a **WASM** build of libsignal (a different artifact/package), or another
  WASM Signal implementation. A Node‑addon engine in shared code would break `next build`.

Therefore the engine binding is delivered **per platform adapter**:
- **mobile** → bind `@signalapp/libsignal-client` (native addon).
- **web** → bind a WASM libsignal build.

The cross‑platform, verifiable proof that the protocol/wire wiring is correct already exists:
`packages/crypto/src/libsignal-roundtrip.test.ts` exercises the real native library end‑to‑end
(establish from a bundle, type‑3 then type‑1 messages both directions over persisted state,
one‑time prekey consumed once, routed through the shared `EnvelopeCodec`). Use it as the
reference for what a correct engine must do.

### 2.1 Engine contract the adapters must implement

`LibsignalEngine` (see `packages/crypto/src/session-manager.ts`):

```ts
processPreKeyBundle(address: SignalAddress, bundle: ClaimedPreKeyBundle, store: SignalProtocolStore): Promise<void>;
encrypt(address: SignalAddress, plaintext: Uint8Array, store: SignalProtocolStore): Promise<EncryptedMessage>; // {type:1|3, ciphertext:Uint8Array}
decrypt(address: SignalAddress, message: EncryptedMessage, store: SignalProtocolStore): Promise<Uint8Array>;
```

It is driven by `DefaultSessionManager`, which resolves `recipientUid → SignalAddress` from a
learned `uid → deviceId` map (`establishSession` and `decrypt` populate it).

### 2.2 Gotchas discovered (apply to BOTH platform engines)

1. **Message‑type mapping (important).** libsignal's `CiphertextMessage.type()` returns
   **2** for a whisper `SignalMessage` and **3** for a `PreKeySignalMessage`. The Phase‑1 wire
   format (`CiphertextBody.type`, design "Data Models") uses **1 = SignalMessage**,
   **3 = PreKeySignalMessage**. The engine MUST map on encrypt:
   `const wireType = ct.type() === 3 ? 3 : 1;` and on decrypt branch on the **wire** type
   (`3` → `PreKeySignalMessage` + `signalDecryptPreKey`, else → `SignalMessage` + `signalDecrypt`).
2. **Single device per user (Phase 1).** Map every `SignalAddress` to a libsignal
   `ProtocolAddress.new(uid, 1)` (device id `1`). The server‑issued `deviceId` string lives in
   the shared `SignalAddress`; bind your libsignal store adapters to the call's `SignalAddress`
   so the numeric‑1 `ProtocolAddress` maps back to the right shared‑store key.
3. **Kyber/PQXDH is out of scope.** Build classic `PreKeyBundle.new(...)` with **no** kyber
   params; provide a `KyberPreKeyStore` whose getters throw and whose save/markUsed are no‑ops
   (it is never consulted for a non‑kyber bundle). `signalDecryptPreKey` still requires the
   argument to be passed.
4. **`signalDecryptPreKey` signature** (v0.47):
   `(message, address, sessionStore, identityStore, preKeyStore, signedPreKeyStore, kyberPreKeyStore)`.
5. **Record formats.** libsignal stores want `SessionRecord` / `PreKeyRecord` /
   `SignedPreKeyRecord` objects, not raw bytes. The shared `SignalProtocolStore` is a
   byte‑blob interface; the concrete adapter (§3.1) serializes/deserializes between the two via
   `Record.serialize()` / `Record.deserialize(buf)`.
6. **Local identity key.** `IdentityKeyStore.getIdentityKey()` must return a libsignal
   `PrivateKey`. `IdentityManager`'s `createLibsignalKeyGen` stores the identity private half as
   `PrivateKey.serialize()` bytes, so `PrivateKey.deserialize(privBytes)` reconstructs it.

### 2.3 libsignal store → shared `SignalProtocolStore` mapping table

| libsignal abstract method | back it with `SignalProtocolStore` |
| --- | --- |
| `SessionStore.getSession/saveSession` | `loadSession(addr)` / `storeSession(addr, bytes)` |
| `IdentityKeyStore.getIdentityKey` | `getIdentityKeyPair()` → `PrivateKey.deserialize(privateKey)` |
| `IdentityKeyStore.getLocalRegistrationId` | `getLocalRegistrationId()` |
| `IdentityKeyStore.saveIdentity/getIdentity/isTrustedIdentity` | `saveIdentity` / `loadIdentityKey` / `isTrustedIdentity` (bound addr) |
| `PreKeyStore.getPreKey/removePreKey` | `loadPreKey(id)` / `removePreKey(id)` |
| `PreKeyStore.savePreKey` | no‑op (prekey lifecycle owned by `IdentityManager`) |
| `SignedPreKeyStore.getSignedPreKey` | `loadSignedPreKey(id)` |
| `SignedPreKeyStore.saveSignedPreKey` | no‑op |
| `KyberPreKeyStore.*` | throw on get; no‑op on save/markUsed (unused in Phase 1) |

---

## 3. Remaining work, with concrete instructions

### 3.1 Web (`apps/web`) — the last verifiable‑in‑CI piece once WASM is chosen

- **Concrete `SignalProtocolStore`** over the existing in‑memory `KeyStore`
  (`apps/web/app/lib/in-memory-key-store.ts`). Translate the byte‑blob `KeyStore` surface to the
  libsignal‑facing `SignalProtocolStore` (record (de)serialization per §2.3). This is also what
  the mobile SQLCipher store needs (consider a shared, store‑agnostic bridge that takes a
  `KeyStore` and a record (de)serializer).
- **Web `LibsignalEngine` (WASM).** Pick a browser WASM libsignal build, implement the
  `LibsignalEngine` contract (§2.1) honoring the §2.2 gotchas, and a `LibsignalKeyGen` WASM
  variant for `IdentityManager`.
- **Bootstrap (task 7.8)** — replace the demo controller in `apps/web/app/lib/chat-controller.ts`
  with the real one: wire `FirebaseAuthAdapter` → `AuthService` → `IdentityManager` →
  `DeviceRegistrar` → `RealtimeClient` → `Messaging`, feeding `Messaging`'s `ConversationEvent`s
  into the reducer the page already consumes. The screens (`SignInScreen`, `ConversationScreen`)
  need **no change** — they're already prop/reducer driven.
- **Runtime config** (Firebase Web, public client values, embedded by Next at build):
  `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`
  (`NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` optional) —
  read by `firebaseConfigFromEnv()` in `apps/web/app/lib/firebase-auth.adapter.ts`. Also add a
  `<div id="recaptcha-container" />` to the layout for the invisible reCAPTCHA, and enable
  **Phone** sign‑in in the Firebase console.
- **Web property test (task 7.3)** — session‑end wipe (Property 19): assert `destroy()` (and the
  `pagehide`/`beforeunload` wiring in `registerSessionEndWipe`) leaves no key material
  retrievable. Needs a DOM test env (jsdom) — `apps/web` has no test runner yet; add Vitest or
  Jest+jsdom.

### 3.2 Mobile (`apps/mobile`, Section 6) — needs the Expo/RN toolchain

- **6.1 FirebaseAuthAdapter** already exists (`apps/mobile/src/auth/firebase-auth.adapter.ts`).
- **6.2 SQLCipher `KeyStore`** (`react-native-sqlcipher-storage`) implementing the `KeyStore`
  surface; on open/decrypt failure write nothing unencrypted and surface a secure‑storage error
  (7.6). Reuse the §3.1 `SignalProtocolStore` bridge.
- **Native `LibsignalEngine` + `LibsignalKeyGen`** binding `@signalapp/libsignal-client`
  (`createLibsignalKeyGen()` in `identity-manager.ts` is already the real native key‑gen;
  implement the matching engine per §2).
- **6.4/6.5** RN `WebSocketTransport` + `HttpClient` adapters (mirror the web ones in
  `apps/web/app/lib/web-*.ts`: TLS‑only, token on the `['bearer', token]` subprotocol, never the URL).
- **6.6/6.7** `Sign_In_Screen` + `Conversation_Screen` (RN) consuming the shared
  `ConversationReducer` (mirror the web components).
- **6.8 Android manifest** — declare **none** of SMS, Call Log, Accessibility Service, or
  `QUERY_ALL_PACKAGES` (check `apps/mobile/app.json` / the generated manifest).
- **6.9 bootstrap** — same wiring as 7.8, RN side.

### 3.3 Backend tests needing infra (`apps/backend`)

- **4.4 / 4.8** (`KeysController` 404/401; ACK on accepted relay) — use `@nestjs/testing`
  (`Test.createTestingModule`) with stubbed providers; Jest is already wired. The env‑validation
  side‑effect is handled by `apps/backend/jest.setup.js` (placeholder env).
- **4.3 / 4.6** property tests (prekey claim consumes exactly one — Property 22; relay binds
  sender — Property 23). The relay (4.6) can be tested with stubbed Redis/registry (see
  `message-relay.service.test.ts`). The claim (4.3) needs a **Postgres** with the Phase‑0 schema
  (`SELECT ... FOR UPDATE SKIP LOCKED` on `one_time_prekeys`); run via
  `infra/docker/docker-compose.yml` and point `DATABASE_URL` at it. Add `fast-check` to the
  backend dev deps for the property cases.

### 3.4 Integration / e2e (Section 8) — needs live services

- **8.1** Firebase OTP via the **Firebase Auth emulator**.
- **8.2** WebSocket handshake against the real Phase‑0 gateway (`['bearer', idToken]`; `4401` on
  bad token; ping/pong; presence registry entry appears/clears).
- **8.3** prekey‑claim consume‑once against Postgres.
- **8.4** end‑to‑end two‑client exchange (register → connect → claim → exchange one message;
  recipient renders plaintext, sender sees `sent`, relay carries ciphertext only).
- **8.5** Android manifest smoke/static check; **8.6** shared‑package consumption smoke check
  (both apps import `@chat-app/crypto`/`@chat-app/types`). 8.6 is doable in CI now.
- Services: `infra/docker/docker-compose.yml` provides Postgres + Redis; add the Firebase
  emulator. Backend required env (fail‑fast in `apps/backend/src/config/env.validation.ts`):
  `DATABASE_URL, PGBOUNCER_URL, REDIS_URL, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY, SENTRY_DSN_BACKEND, JWT_SECRET, ENCRYPTION_KEY`.

### 3.5 Remaining pure property/unit tests (verifiable in CI now, optional)

These restate behaviors already covered by example tests, in the spec's formal `fast-check`
form: **2.10, 2.11, 2.12, 2.13** (identity properties 7/8/9/4), **2.16** (decrypt‑failure /
Property 15), **2.19** (no secrets in logs / Property 20), **2.20, 2.23** (Auth/Registrar example
units), **2.22** (registration idempotence / Property 10), **2.26** (connection status /
Property 14), **2.28, 2.29** (pending‑flush / ack‑timeout / Properties 16, 17), **2.33** (web
ephemerality gate / Property 18). Add to `packages/crypto/src/*.property.test.ts`.

---

## 4. Conventions established this phase (follow these)

- **Test runners:** `packages/crypto` uses Node's built‑in `node:test` (`node --test dist/*.test.js`
  — the glob is **unquoted** so the shell expands it; Node 20's `--test` does not expand globs).
  `apps/backend` uses **Jest** (`ts-jest`, config in `jest.config.js`, env in `jest.setup.js`).
  `apps/web` is validated by `next lint` + `tsc --noEmit` + `next build` (no unit runner yet).
- **Property tests:** `fast-check`, ≥ 100 runs, tagged
  `// Feature: phase1-client-messaging, Property {n}: {text}`.
- **Single React:** root `package.json` `overrides` pin `react`/`react-dom` to `18.2.0` (mobile's
  RN peer vs web's Next). Keep web on 18.2.0 to avoid a dual‑React `next build` crash.
- **Lockfile is committed** (CI uses `npm ci`).
- **Branch/merge hygiene:** PRs are **squash‑merged**. A squash makes the feature branch's
  individual commits diverge from `main`; after each merge, run `git merge origin/main` into the
  feature branch (do **not** rely on resetting to the pre‑squash tip) to avoid add/add conflicts
  on `package-lock.json` / `tasks.md` on the next PR.
- **CI is the gate, not deploy:** `pr.yml` only lints/typechecks/tests/builds; no secrets, no deploy.

---

## 5. Quick start for the next engineer

```bash
npm ci
npm run build:packages
npm run lint --workspaces --if-present
npm run typecheck --workspaces --if-present
npm run test --workspaces --if-present   # crypto (node:test) + backend (jest)
npm run build --workspaces --if-present   # includes next build
# infra for backend/e2e:
docker compose -f infra/docker/docker-compose.yml up -d   # Postgres + Redis
```

Reference implementation to copy from:
- Wire/crypto round‑trip: `packages/crypto/src/libsignal-roundtrip.test.ts`
- Web adapters: `apps/web/app/lib/{firebase-auth.adapter,web-websocket-transport,web-http-client,in-memory-key-store}.ts`
- Shared orchestration: `packages/crypto/src/{messaging,session-manager,device-registrar,realtime-client,auth-service}.ts`
- UI on the shared reducer: `apps/web/app/components/{SignInScreen,ConversationScreen}.tsx` + `apps/web/app/page.tsx`
