# Firebase Authentication — Backend Integration

This document describes how the backend integrates Firebase Authentication in Phase 0. It is the
backend-facing companion to Section 15 of the product source of truth
(`private-chat-app-requirements.md`) and to Requirement 8 of the Phase 0 spec
(`.kiro/specs/phase0-foundation/requirements.md`).

> Scope note: Phase 0 covers the **server-side** Firebase integration only — Admin SDK credential
> wiring, server-side ID-token verification, the Redis-cached verification path, and the use of the
> Firebase UID as the canonical backend identifier. The client-side sign-in UI (the screens that
> actually run phone OTP, email/password, and Google Sign-In flows) is **out of scope for Phase 0**
> and is delivered in a later phase. The enabled sign-in methods are recorded here only as
> backend-relevant context, because they determine the shape of the verified identity the backend
> receives.

## 1. Admin SDK credential wiring (`FIREBASE_*`)

The backend wraps the Firebase Admin SDK in `FirebaseAdminService`. The SDK is initialized **exactly
once at service startup, before any token-verification request is processed**, using service-account
credentials read from three environment variables (GitHub Secrets Category B):

| Environment variable    | What it is                                    | Notes |
|-------------------------|-----------------------------------------------|-------|
| `FIREBASE_PROJECT_ID`   | The Firebase project identifier.              | Identifies the project whose tokens are trusted. |
| `FIREBASE_CLIENT_EMAIL` | The service-account client email.             | Service-account identity used to sign Admin API calls. |
| `FIREBASE_PRIVATE_KEY`  | The service-account private key (PEM).        | Sensitive. Sourced from GitHub Secrets and injected as an env var at deploy time; never committed. |

Initialization wiring (illustrative):

```typescript
import { credential } from 'firebase-admin';
import { initializeApp } from 'firebase-admin/app';

initializeApp({
  credential: credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Secret managers commonly store the PEM with literal "\n"; normalize to real newlines.
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
```

Operational rules:

- **Single initialization.** The Admin SDK app is created once; subsequent verification calls reuse
  the initialized app. (Requirement 8.1)
- **Fail fast on missing/invalid credentials.** If any of `FIREBASE_PROJECT_ID`,
  `FIREBASE_CLIENT_EMAIL`, or `FIREBASE_PRIVATE_KEY` is missing or invalid at startup,
  `FirebaseAdminService` fails initialization and the backend does not accept token-verification
  requests. This is consistent with the ConfigModule fail-fast contract (Requirement 1.4) and with
  Requirement 8.7.
- **`FIREBASE_PRIVATE_KEY` handling.** The private key is a secret. It is sourced exclusively from
  GitHub Secrets, injected as an environment variable at deploy time, masked in CI/CD log output,
  and never written to logs, error reports, or Redis keys/values.

## 2. Firebase UID as the canonical backend identifier

The **Firebase UID is the single canonical user identifier across all backend services**
(Requirement 8.4, Section 15.2). Every backend component keys user identity off the Firebase UID:

- The `users` table enforces a unique constraint on `firebase_uid`; there is exactly one row per UID.
- Device registration upserts the user by `firebase_uid`, so a returning user reuses their row.
- The WebSocket connection registry and presence entries are keyed by UID (`presence:{uid}`).
- Authenticated structured log entries include the Firebase UID for request correlation.

The verified identity attached to a request after token verification is the `AuthContext`:

```typescript
interface AuthContext {
  uid: string;          // Firebase UID — canonical user id across all backend services
  email?: string;       // present for email/password and Google sign-ins
  phoneNumber?: string; // present for phone-OTP sign-ins
  tokenExp: number;     // unix seconds — drives the Redis cache TTL
}
```

`email` and `phoneNumber` are optional claims that vary by sign-in method (see Section 4). Backend
services must treat `uid` — never the email or phone number — as the identity key.

## 3. Token verification and Redis caching flow (high level)

Both the REST guard (`FirebaseAuthGuard`) and the WebSocket handshake share one verification path
(`TokenVerificationService`) so the security and caching semantics are identical:

1. Extract the Bearer ID token from the request (`Authorization: Bearer <token>` for REST, or the
   handshake subprotocol/query for WebSocket).
2. Compute `cacheKey = "fbtoken:" + sha256(token)`. The raw token is **never** used as a key or
   value — only its SHA-256 hash (Requirement 13.2).
3. **Cache hit:** if Redis has an entry for `cacheKey`, return the cached `AuthContext` without
   calling Firebase. A present entry is necessarily unexpired because its TTL was set to the token's
   remaining lifetime.
4. **Cache miss:** verify the token with the Firebase Admin SDK. Verification validates the token
   **signature** and **expiration** and performs **revocation checking** against the Firebase Admin
   API (Requirement 8.2).
5. On successful verification, cache the resulting `AuthContext` with `SETEX cacheKey ttl`, where
   `ttl = max(1, exp - now)`. The cache entry can therefore never outlive the token, and no entry is
   created when the remaining lifetime is ≤ 0 (Requirement 2.2).
6. On any verification failure, raise a domain `UnauthorizedError` (HTTP 401 / WebSocket close 4401)
   and exclude Firebase SDK internals from the client-facing response (Requirement 8.3).

Resilience and failure handling:

- **Redis degradation fallback.** If a Redis token-cache read/write fails or does not complete within
  50 ms, the service falls back to direct Firebase verification so authentication is not rejected
  solely because of a Redis problem (Requirement 7.4).
- **Firebase unreachable on a cache miss.** If the Firebase Admin API does not respond within 5 s or
  the connection fails on a miss, the backend responds with HTTP 503 (REST) or WebSocket close code
  4503 and captures the error in Sentry (Requirement 8.5).

```
Incoming request / WS handshake
        │  extract Bearer token (missing/malformed → 401 / close 4401)
        ▼
  cacheKey = fbtoken:sha256(token)
        │
   Redis GET cacheKey ──hit──▶ return cached AuthContext (no Firebase call)
        │ miss
        ▼
  Firebase Admin verifyIdToken  ──invalid/expired/revoked──▶ 401 / close 4401
        │ valid
        ▼
  Redis SETEX cacheKey ttl=max(1, exp-now)  →  return AuthContext{uid,...}
```

The Redis cache key model for the token cache:

| Key pattern                | Type                       | Purpose                              | TTL          |
|----------------------------|----------------------------|--------------------------------------|--------------|
| `fbtoken:{sha256(token)}`  | string (JSON `AuthContext`)| Cached Firebase verification result  | `max(1, exp - now)` |

## 4. Enabled sign-in methods (backend-relevant context)

The Firebase project has **three sign-in methods enabled** (Section 15.1). These are listed here
because they determine which optional claims appear in the verified `AuthContext`; the **client-side
sign-in UI for these methods is out of scope for Phase 0**.

| Sign-in method        | Description                                                        | Backend-visible claim |
|-----------------------|--------------------------------------------------------------------|-----------------------|
| Phone OTP (primary)   | Firebase sends an SMS OTP; an ID token is issued on verification.  | `phoneNumber` populated. |
| Email / password      | Email/password sign-in with email verification.                   | `email` populated. |
| Google Sign-In        | Google OAuth via Firebase.                                         | `email` populated. |

Regardless of which method produced the token, the backend trusts only the Firebase-issued ID token,
verifies it through the shared path above, and treats the Firebase UID as the canonical identity.
The SMS used by phone OTP is sent by Firebase itself; the backend never requests the Android SMS or
Call Log permissions (Section 16.4, Requirement 13.3).

## 5. Device registration flow (backend-relevant context)

Token verification exists so authenticated clients can register a device and publish their **public**
libsignal prekey bundle. The end-to-end flow from Section 15.3 is recorded here as context; the
backend owns steps 4–5, while steps 1–3 run on the client and are out of scope for Phase 0.

1. **Client authenticates with Firebase** using one of the three enabled sign-in methods (Section 4)
   and receives a Firebase ID token.
2. **Client generates its libsignal identity key pair and registration ID locally.** Private key
   material never leaves the device.
3. **Client calls `POST /api/devices/register`** with `Authorization: Bearer <id token>` and a body
   carrying only public material — public identity key, signed prekey bundle (public key +
   signature), one-time prekey public keys, and the `registrationId`.
4. **Backend verifies the token** through the shared verification path (Section 3), then upserts the
   user keyed by **Firebase UID** (creating the `users` row if new) and persists the device's public
   prekey bundle. The whole write runs in a single transaction and stores public keys only
   (Requirement 8.4, and Requirement 2.3/13.4 for public-key-only persistence).
5. **Backend responds with HTTP 201 and the server-issued `deviceId`**, which the client later uses
   for WebSocket identification.

Backend boundaries reinforced by this flow:

- The Firebase UID resolved in step 4 is the join key between the verified identity and the persisted
  device — the same canonical identifier described in Section 2.
- The backend accepts and stores **no private key material**; there is no request field or schema path
  through which a private key could be supplied (Requirement 13.4, 13.7).
- The detailed DTO validation, signed-prekey signature check, and transactional upsert that implement
  step 4 are specified by Requirement 2 and built in the DevicesModule tasks (6.1–6.4), not here.

## Requirement traceability

- **Requirement 8.1** — Admin SDK initialized once at startup from `FIREBASE_PROJECT_ID`,
  `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (Section 1).
- **Requirement 8.4** — Firebase UID is the canonical user identifier across all backend services
  (Section 2), and is the join key for device registration (Section 5).
- Supporting context: Requirements 8.2, 8.3, 8.5, 8.7, 2.2, 7.4, 13.2 (Section 3); Requirement 2.3,
  13.4, 13.7 for public-key-only device registration (Section 5); and Section 15 of the product
  source of truth.
