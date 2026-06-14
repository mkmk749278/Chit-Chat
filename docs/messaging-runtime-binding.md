# Messaging — runtime binding decision (the last mile to a usable client)

This is the one remaining gap between "encryption proven" and "users can send an
encrypted message." It is written for the owner/CTO to make the call, with the tradeoffs
and effort spelled out.

## What is already done and CI‑proven

The whole encrypted‑messaging stack **above the runtime crypto binding** is implemented
and verified by automated tests (Node, real `@signalapp/libsignal-client`):

- **Engine** (`createLibsignalEngine`) — X3DH session establishment, encrypt/decrypt,
  one‑time‑prekey consumption, libsignal↔wire type mapping. (`session-e2e.test.ts`)
- **SignalProtocolStore** — pure‑JS in‑memory store (web reference; mobile uses SQLCipher).
- **Messaging orchestrator** end‑to‑end between two clients over an in‑process relay that
  mirrors the gateway: send → relay → decrypt → ack → `sent`, bidirectional exchange, and
  tampered‑ciphertext → `delivery-error` with **no plaintext on the wire**.
  (`messaging-e2e.test.ts`)
- **Backend** (deployed) — device registration, prekey claim, relay + ack, all live at
  `api.luminchat.app` / `ws.luminchat.app`.
- **Clients** — web + mobile UIs, real Firebase phone auth, transports (`wss`/`https`
  adapters) all written behind the shared ports.

So the only unimplemented seam is: **run libsignal inside the actual client runtime.**

## The constraint (confirmed)

`@signalapp/libsignal-client@0.47` ships **only native Node `.node` prebuilds** — no
`browser` field, no `.wasm`. It runs in Node (backend, our tests) but **cannot load in a
web browser or in React Native** as‑is. Each client needs its own binding of the
`LibsignalEngine` port:

| Client | Needs | Options |
| --- | --- | --- |
| **Web (browser)** | a WASM/JS Signal implementation | (W1) `@signalapp/libsignal-client` compiled to WASM (build from the Rust source; not published to npm), or (W2) a pure‑TS protocol lib such as `@privacyresearch/libsignal-protocol-typescript` |
| **Mobile (RN/Hermes)** | a JSI native module exposing libsignal | (M1) a community RN binding / custom JSI wrapper over the native libsignal `.so`/`.a`, or (M2) the same pure‑TS lib as web (no native module) |

**Compatibility rule:** both peers in a conversation must use the *same* protocol
implementation family — a `@signalapp` (Rust) client and a `@privacyresearch` (TS) client
produce incompatible ciphertext. So the choice is global, not per‑platform.

## Recommendation

**Adopt the pure‑TS engine (`@privacyresearch/libsignal-protocol-typescript`) for BOTH
web and mobile**, bound to the existing `LibsignalEngine` port.

Why:
- It runs in the browser and in Hermes (RN) with only crypto polyfills
  (`react-native-get-random-values`), **no native module to build/sign per‑platform** —
  which removes the biggest APK/build risk and the WASM toolchain dependency.
- One implementation for all clients → guaranteed wire compatibility.
- It slots behind the port we already designed and tested; the orchestrator, store, UI,
  transports, and backend need **no changes**.

Tradeoff: it is not the audited Rust libsignal. For a v1 it is an acceptable, well‑scoped
risk; a later migration to a WASM build of the official library is possible behind the same
port if/when a published artifact exists. (If audited‑Rust is a hard requirement for v1,
the path is W1+M1 — building/bundling official libsignal as WASM and a JSI module — which
is materially more native engineering and needs a device + toolchain to verify.)

## Execution plan (pure‑TS engine path)

1. Add `@privacyresearch/libsignal-protocol-typescript` (+ `react-native-get-random-values`
   on mobile, imported first at app entry).
2. Implement `createWebLibsignalEngine()` / RN engine binding the `LibsignalEngine` port
   (mirror `libsignal-engine.node.ts`: `processPreKeyBundle` / `encrypt` / `decrypt` over
   the injected `SignalProtocolStore`). Reuse the in‑memory store on web; back the mobile
   store with SQLCipher (`op-sqlite` with `encryptionKey`, or `expo-sqlite` SQLCipher).
3. Wire `IdentityManager` key‑gen to the same library (replace the Node‑only
   `createLibsignalKeyGen`).
4. Replace the demo/honest‑fail controller `send()` with `createMessaging(...)` wired to
   the real `RealtimeClient` (`wss://ws.luminchat.app`) + `HttpClient`
   (`https://api.luminchat.app`) + the engine + store.
5. Verify: the existing `messaging-e2e.test.ts` already covers the orchestration; add a
   parity test that runs it against the chosen engine, then device/browser smoke‑test
   against the live backend.

Most of steps 2–5 are verifiable in CI (Node/jsdom); the device smoke test needs a phone
or emulator.

## Mobile persistent storage (shipped)

The mobile store is no longer in‑memory. `apps/mobile/src/crypto/persistent-store.ts`
implements the `KeyStore` and `SignalProtocolStore` over a single encrypted document:

- The document (identity, server‑issued `deviceId`, sequence counters, message rows, and
  the accumulating libsignal session/identity/prekey state) is serialized to JSON and
  encrypted with **AES‑256‑CBC + HMAC‑SHA256** (encrypt‑then‑MAC, `crypto-box.ts`) — the
  same primitives the Double Ratchet already drives through the polyfilled WebCrypto.
- The 64‑byte data‑encryption key lives in the **hardware‑backed Android Keystore** via
  `expo-secure-store`; the ciphertext blob lives in `@react-native-async-storage/async-storage`
  (`native-vault.ts`). Plaintext key material never touches AsyncStorage (Requirement 10.2).

Because identity and `deviceId` now survive a relaunch, the device **registers once** and
reuses it (the `IdentityManager`/`DeviceRegistrar` idempotence at Requirements 2.6/3.7),
eliminating the device churn that caused encrypted messages to be delivered to a stale
device and never decrypted ("sent ✓✓ but not received"). Sign‑out wipes the blob and key
(Requirement 7.4). Binding the key additionally to the user's PIN (10.2) is the remaining
follow‑up; the hardware‑backed key is in place now.

The persistence logic is platform‑agnostic (storage + crypto injected as ports) and is
covered by `persistent-store.test.ts` (round‑trip across a simulated relaunch, encrypted‑at‑rest
assertion, prekey‑consumption persistence, TOFU identity change, wipe, and tamper rejection),
run under Node WebCrypto via `npm test --workspace=@chat-app/mobile`.
