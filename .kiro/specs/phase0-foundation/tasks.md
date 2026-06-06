# Implementation Plan: Phase 0 — Infrastructure, CI/CD & Auth Foundation

## Overview

This plan converts the Phase 0 design into incremental, test-driven coding steps. Each task builds on the
previous ones and ends by wiring its component into the NestJS application, so no code is left orphaned. The
build order is: monorepo + shared types → backend bootstrap + ConfigModule → DatabaseModule → RedisModule →
AuthModule → DevicesModule → RealtimeModule → HealthModule → ObservabilityModule → root wiring + integration
tests → infrastructure → CI/CD → Firebase/provisioning docs.

All code is TypeScript, matching the confirmed stack (NestJS, TypeORM + PgBouncer, ioredis, `ws`,
`firebase-admin`, `class-validator`). Property-based tests use `fast-check` with Jest and encode the design's
ten Correctness Properties. Out-of-scope items (E2E messaging, the seven signature features, group messaging,
media pipeline, client UI screens) are intentionally excluded.

## Tasks

- [x] 1. Monorepo scaffolding and shared packages
  - [x] 1.1 Initialize npm-workspaces monorepo and directory structure
    - Create root `package.json` declaring npm workspaces and the directories `apps/mobile`, `apps/web`,
      `apps/backend`, `packages/crypto`, `packages/types`, `packages/ui`, `infra/caddy`, `infra/docker`,
      `infra/prometheus`, `infra/scripts`, and `.github/workflows`
    - Add skeleton `apps/mobile` (Expo) and `apps/web` (Next.js) packages so the workspace resolves
    - _Requirements: 1.1, 1.2_

  - [x] 1.2 Define shared TypeScript types in `packages/types`
    - Implement `AuthContext`, `DecodedFirebaseToken`, the DTO shapes (`RegisterDeviceDto`,
      `SignedPreKeyDto`, `OneTimePreKeyDto`) as types, `RegisterDeviceResponse`, and entity-as-type
      definitions for User/Device/SignedPreKey/OneTimePreKey
    - Export a package entry so `apps/*` import the in-repo path, not an external registry
    - _Requirements: 1.2_

  - [x] 1.3 Scaffold `packages/crypto` signature-verification stub and `packages/ui` placeholder
    - Add a `verifySignedPreKeySignature(identityKey, publicKey, signature)` function signature in
      `packages/crypto` (libsignal wrapper) used later by device registration
    - Add a placeholder export in `packages/ui` so the workspace builds
    - _Requirements: 1.2, 2.9_

  - [x] 1.4 Configure workspace-wide build and typecheck
    - Add root `tsconfig.base.json`, per-package tsconfigs, and a workspace build/typecheck script that
      compiles every workspace with zero errors
    - _Requirements: 1.5_

- [x] 2. Backend bootstrap and ConfigModule
  - [x] 2.1 Scaffold the NestJS backend application and bootstrap
    - Create `apps/backend` NestJS app with `main.ts` (REST :3000, ws :3001), an initially minimal
      `AppModule`, and a global `ValidationPipe`
    - _Requirements: 1.3_

  - [x] 2.2 Implement ConfigModule with fail-fast environment validation
    - Define the required configuration set and validate it at startup; on any missing variable, terminate
      before the app accepts requests and emit an error listing every missing variable name
    - _Requirements: 1.4_

  - [ ]* 2.3 Write unit tests for ConfigModule env validation
    - Assert startup fails and lists all missing variables; assert success when all are present
    - _Requirements: 1.4_

- [x] 3. DatabaseModule (TypeORM + PgBouncer, entities, migrations)
  - [x] 3.1 Define TypeORM entities
    - Implement `UserEntity`, `DeviceEntity`, `SignedPreKeyEntity`, `OneTimePreKeyEntity` with the unique
      constraints (`firebase_uid`, `(user_id, registration_id)`, `(device_id, key_id)`) and
      `ON DELETE CASCADE` relations; identity/prekey columns are `bytea` public material only
    - _Requirements: 6.2, 6.3, 13.4_

  - [x] 3.2 Implement DatabaseModule over PgBouncer in transaction-pooling mode
    - Wire TypeORM `DataSource` to connect through PgBouncer (not Postgres directly) and expose a
      transaction helper that runs all statements of a multi-row write on a single pooled connection
    - _Requirements: 4.4, 6.5_

  - [x] 3.3 Create versioned migrations for the schema and Phase 0 indexes
    - Author ascending versioned migrations creating `users`, `devices`, `signed_prekeys`,
      `one_time_prekeys` and the indexes `idx_prekeys_user_device`,
      `idx_onetime_prekeys_device_unconsumed` (partial, `consumed_at IS NULL`), `idx_signed_prekeys_device`
    - On migration failure, halt the run and leave the schema in its pre-migration state with an error
      identifying the failed migration
    - _Requirements: 6.1, 6.4, 6.6_

  - [ ]* 3.4 Write integration tests for migrations and constraints
    - Verify tables/indexes exist after migration; verify unique-constraint conflicts are rejected and the
      existing row is unchanged; verify `ON DELETE CASCADE` removes child rows
    - _Requirements: 6.7, 6.8_

- [x] 4. RedisModule (clients, helpers, rate limiter)
  - [x] 4.1 Implement RedisModule with command, subscriber, and publisher clients
    - Construct three distinct ioredis connections from `REDIS_URL` with exponential backoff starting at
      500 ms, capped at 30 s, with jitter; fail initialization if `REDIS_URL` is absent or unparseable
    - _Requirements: 7.1, 7.2, 7.6_

  - [x] 4.2 Implement token-cache and presence-registry helpers
    - Provide the `fbtoken:{sha256(token)}` cache helper (SETEX/GET) and the `presence:{uid}` registry
      helper (HSET/HDEL/lookup); never store raw tokens as keys or values
    - _Requirements: 7.3, 7.5, 13.2_

  - [x] 4.3 Implement the fixed-window RateLimiter with config validation
    - Implement `hit(key, limit, windowSeconds)` as a Redis fixed-window counter under
      `ratelimit:{scope}:{id}` with TTL = window; reset on TTL expiry; refuse to start when window is
      outside 1..86400 or limit outside 1..1000000
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 5.6_

  - [ ]* 4.4 Write property test for rate-limit monotonicity
    - **Property 9: Rate-limit monotonicity**
    - **Validates: Requirements 5.3**

  - [ ]* 4.5 Write unit tests for RedisModule helpers
    - Test three distinct connections, backoff config, token-cache round trip, and window reset behavior
    - _Requirements: 7.1, 7.3, 5.5_

- [x] 5. AuthModule (Firebase Admin, cached verification, guard)
  - [x] 5.1 Implement FirebaseAdminService
    - Initialize the Admin SDK exactly once from `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
      `FIREBASE_PRIVATE_KEY`; verify signature, expiration, and revocation; translate failures into a domain
      `UnauthorizedError` without leaking SDK internals; fail init if credentials are missing/invalid
    - _Requirements: 8.1, 8.2, 8.3, 8.6, 8.7_

  - [x] 5.2 Implement Redis-cached TokenVerificationService
    - On cache hit return `AuthContext` without calling Firebase; on miss verify and `SETEX` with
      TTL = `max(1, exp - now)` (never create an entry when remaining lifetime ≤ 0); on Redis read/write
      failure or >50 ms, fall back to direct Firebase verification; on Firebase unreachable on a miss,
      surface 503/4503 and capture in Sentry
    - _Requirements: 2.2, 7.4, 7.5, 8.5, 13.2_

  - [x] 5.3 Implement FirebaseAuthGuard
    - Extract the Bearer token, delegate to TokenVerificationService, attach `AuthContext` to the request,
      reject with 401 on missing/invalid token and perform no database write
    - _Requirements: 2.1, 13.1, 13.5_

  - [ ]* 5.4 Write property test for cache TTL never outliving the token
    - **Property 3: Cache never outlives the token**
    - **Validates: Requirements 2.2**

  - [ ]* 5.5 Write property test for cache fidelity
    - **Property 4: Cache fidelity**
    - **Validates: Requirements 2.2**

  - [ ]* 5.6 Write unit tests for FirebaseAdminService, guard, and Redis-failure fallback
    - Test 401 on missing/invalid token, `AuthContext` attachment, no SDK leakage, and fallback-to-Firebase
      when Redis errors
    - _Requirements: 8.3, 7.4, 8.5_

- [x] 6. DevicesModule (DTO, signature check, transactional registration, controller)
  - [x] 6.1 Implement RegisterDeviceDto with class-validator rules
    - Enforce base64 key fields, `registrationId` ≥ 1, signed prekey shape, one-time prekey array size
      1..200, optional `deviceName` ≤ 64; reject missing required fields and out-of-range arrays with HTTP
      400 before any DB access, identifying the offending field; expose no field path that accepts a private
      key
    - _Requirements: 2.7, 2.8, 13.4, 13.7_

  - [x] 6.2 Implement signed-prekey signature verification
    - Use `packages/crypto` to verify the signed prekey signature against the supplied public identity key;
      reject with HTTP 400 and an "invalid signed prekey signature" indication before any DB access
    - _Requirements: 2.9_

  - [x] 6.3 Implement DevicesService transactional registration
    - Upsert the user by `firebase_uid` and the device by `(user, registrationId)`; replace the signed
      prekey and insert one-time prekeys; persist only public key material; run the whole write in a single
      transaction that rolls back fully on any failure; maintain exactly one user row per UID and one device
      row per `(user, registrationId)`
    - _Requirements: 2.3, 2.4, 2.5, 4.1, 4.2, 4.3, 6.7_

  - [x] 6.4 Implement DevicesController `POST /api/devices/register`
    - Guard with FirebaseAuthGuard, apply the RateLimiter to the surface, call DevicesService, and respond
      with HTTP 201 and the server-issued `deviceId`
    - _Requirements: 2.1, 2.6, 5.2, 13.1_

  - [ ]* 6.5 Write property test for public-keys-only persistence
    - **Property 2: Server stores public keys only**
    - **Validates: Requirements 2.3, 13.4**

  - [ ]* 6.6 Write property test for registration idempotency
    - **Property 5: Registration idempotency**
    - **Validates: Requirements 2.4**

  - [ ]* 6.7 Write property test for registration atomicity
    - **Property 6: Registration atomicity**
    - **Validates: Requirements 2.5, 4.1**

  - [ ]* 6.8 Write property test for auth-required on the registration endpoint
    - **Property 1: Auth required on protected surfaces (REST)**
    - **Validates: Requirements 2.1**

  - [ ]* 6.9 Write unit tests for DTO validation and signature rejection
    - Test 400 on non-base64 keys, empty/oversized prekey array, missing fields, and invalid signed prekey
      signature, with no DB write
    - _Requirements: 2.7, 2.8, 2.9_

- [x] 7. RealtimeModule (ws gateway, registry, heartbeat, pub/sub)
  - [x] 7.1 Implement the authenticated WebSocket handshake
    - Build the `ws`-based RealtimeGateway; verify the Firebase token from the handshake (subprotocol/query)
      via TokenVerificationService; close with 4401 on invalid token and 4503 when verification is
      unavailable or exceeds 5 s, creating no registry/`presence` entry
    - _Requirements: 3.1, 3.4, 3.8, 8.5_

  - [x] 7.2 Implement the connection registry and pub/sub subscription
    - On a valid handshake register `{uid, connId} -> nodeId` in `presence:{uid}`, mark online, apply the
      RateLimiter to the handshake surface, and subscribe the node to its `node:{nodeId}` channel; relay no
      chat-message payload
    - _Requirements: 3.4, 3.5, 3.7, 5.2_

  - [x] 7.3 Implement heartbeat liveness and disconnect cleanup
    - Ping every registered connection every 25 s; terminate any connection that missed the prior pong
      within the next interval; remove the `{uid, connId}` entry on close and the `presence:{uid}` entry
      when no connection remains for the uid (within 5 s)
    - _Requirements: 3.2, 3.3, 3.6_

  - [ ]* 7.4 Write property test for auth-required on the handshake
    - **Property 1: Auth required on protected surfaces (WebSocket)**
    - **Validates: Requirements 3.1**

  - [ ]* 7.5 Write property test for connection registry consistency
    - **Property 7: Connection registry consistency**
    - **Validates: Requirements 3.3**

  - [ ]* 7.6 Write property test for heartbeat liveness
    - **Property 8: Heartbeat liveness**
    - **Validates: Requirements 3.2**

  - [ ]* 7.7 Write unit tests for handshake rejection and no-message-routing
    - Test close 4401/4503 paths and that no message handler relays payloads in Phase 0
    - _Requirements: 3.1, 3.5_

- [x] 8. HealthModule
  - [x] 8.1 Implement the HealthController
    - Ping Postgres (via PgBouncer) and Redis with a 2 s budget; return `status: ok`/200 iff both respond,
      else `status: degraded`/503 identifying each unreachable dependency; require no auth; return within
      5 s regardless of dependency state; expose no user data, secrets, or connection strings
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [ ]* 8.2 Write property test for health truthfulness
    - **Property 10: Health truthfulness**
    - **Validates: Requirements 11.1**

  - [ ]* 8.3 Write unit tests for ok/degraded and timeout behavior
    - Test degraded/503 when a dependency is down and the 5 s response bound
    - _Requirements: 11.4, 11.5_

- [x] 9. ObservabilityModule
  - [x] 9.1 Implement structured JSON request logging
    - Emit one JSON entry per completed request with request id, route, HTTP status, and latency ms; include
      the Firebase UID when authenticated; exclude token and secret values
    - _Requirements: 12.1, 12.2, 12.6, 13.2_

  - [x] 9.2 Implement the Prometheus `/metrics` endpoint restricted to the monitoring network
    - Publish HTTP request count and latency metrics; reject and return no data for requests originating
      outside the monitoring network
    - _Requirements: 12.3, 12.7, 13.6_

  - [x] 9.3 Initialize Sentry with secret/token scrubbing
    - Initialize the Sentry SDK from `SENTRY_DSN_BACKEND` at startup and report unhandled errors with token
      and secret values excluded
    - _Requirements: 12.4, 12.5, 8.5_

  - [ ]* 9.4 Write unit tests for log scrubbing and metrics access control
    - Test that tokens/secrets never appear in logs or Sentry payloads and that `/metrics` is network-gated
    - _Requirements: 12.2, 12.7_

- [x] 10. Application wiring and integration
  - [x] 10.1 Compose the root AppModule from all eight modules
    - Wire AppModule to import exactly ConfigModule, HealthModule, AuthModule, DevicesModule,
      RealtimeModule, RedisModule, DatabaseModule, and ObservabilityModule; confirm a successful readiness
      response indicates the app is accepting requests; require auth on every endpoint except `/health` and
      `/metrics`
    - _Requirements: 1.3, 1.6, 13.1_

  - [ ]* 10.2 Write integration tests for device registration end-to-end
    - Run migrations against test Postgres/PgBouncer/Redis; exercise `POST /api/devices/register` with a
      stubbed Firebase verifier asserting 401 without token and 201 with a valid token
    - _Requirements: 2.1, 2.6, 4.1_

  - [ ]* 10.3 Write integration tests for the WebSocket handshake and presence lifecycle
    - Assert close 4401 without a token, accept with a stub token, and that the `presence:{uid}` entry
      appears on connect and is removed on disconnect
    - _Requirements: 3.1, 3.4, 3.7_

  - [ ]* 10.4 Write integration tests for the health endpoint
    - Assert `ok`/200 against live containers and `degraded`/503 when Redis is stopped
    - _Requirements: 11.1, 11.4_

- [ ] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Infrastructure (Docker Compose, Caddy, Prometheus)
  - [x] 12.1 Author the Docker Compose stack
    - Define `backend`, `web`, `postgres`, `pgbouncer`, `redis`, `caddy`, `prometheus`, `grafana` with
      restart-on-failure/daemon-restart policies and `depends_on` startup ordering; configure `redis` with
      `appendfsync everysec`
    - _Requirements: 9.1, 9.2_

  - [x] 12.2 Author the Caddyfile
    - Reverse-proxy `api.` → :3000, `ws.` → :3001 with frame compression off, web domain → :3002, and
      IP-restrict `grafana.` (403 outside the admin range); automatic Let's Encrypt issuance/renewal with
      fallback to the last valid cert; gateway error on unreachable upstream; HTTP → HTTPS redirect
    - _Requirements: 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

  - [x] 12.3 Author the Prometheus scrape configuration
    - Add `infra/prometheus/prometheus.yml` scraping the backend `/metrics` endpoint over the monitoring
      network
    - _Requirements: 12.3_

- [x] 13. CI/CD pipelines and secrets
  - [x] 13.1 Author `backend.yml` and `web.yml` deploy pipelines
    - Run lint → tests → `tsc`/build in sequence, deploy to the VPS only on success, run migrations, then
      verify `/health` retrying up to 5 times at 10 s intervals; abort without deploying on any failed step
      and leave the running deployment unchanged
    - _Requirements: 10.1, 10.2, 10.7, 10.8, 10.9_

  - [x] 13.2 Author `android.yml`, `pr.yml`, and `backup.yml`
    - `pr.yml`: lint + typecheck + unit tests + build check on PRs to `main` (no deploy), failing the status
      check on any failure; `android.yml` and `backup.yml` scoped by path/schedule
    - _Requirements: 10.1, 10.6_

  - [x] 13.3 Author deploy/migrate scripts and secret masking
    - Add `infra/scripts` deploy + `migration:run` scripts invoked by the pipelines; source every secret
      from GitHub Secrets as env vars at deploy time and mask all secret values in log output
    - _Requirements: 10.3, 10.4, 10.7_

  - [x] 13.4 Author the GitHub Secrets classification document
    - Document secret categories A, B, E, F, G, H, I (and note C/D for later) defined before any pipeline
      runs
    - _Requirements: 10.5_

- [x] 14. Firebase Auth backend integration and provisioning
  - [x] 14.1 Author Firebase Auth backend integration config and notes
    - Document the Admin SDK credential wiring (`FIREBASE_*`) and the Firebase UID as the canonical backend
      identifier; record the three enabled sign-in methods as backend-relevant context
    - _Requirements: 8.1, 8.4_

  - [x] 14.2 Author the one-time VPS provisioning checklist
    - Provide a documented manual checklist for Section 14.4 VPS provisioning (non-executable)
    - _Requirements: 9.1_

- [ ] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation
  tasks are never optional.
- Each task references specific requirement acceptance criteria for traceability.
- Property-based tests (`fast-check` + Jest) encode the design's ten Correctness Properties; each property is
  its own sub-task placed close to the implementation it validates.
- Unit and integration tests are complementary to the property tests and validate edge cases and end-to-end
  wiring.
- Checkpoints ensure incremental validation at natural breaks.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2", "3.1", "4.1", "9.1", "12.1", "13.4", "14.1", "14.2"] },
    { "id": 4, "tasks": ["2.3", "3.2", "4.2", "5.1", "9.2", "12.2", "13.1"] },
    { "id": 5, "tasks": ["3.3", "4.3", "5.2", "9.3", "12.3", "13.2"] },
    { "id": 6, "tasks": ["3.4", "4.4", "4.5", "5.3", "8.1", "13.3"] },
    { "id": 7, "tasks": ["5.4", "5.5", "5.6", "6.1", "7.1", "8.2", "8.3", "9.4"] },
    { "id": 8, "tasks": ["6.2", "7.2"] },
    { "id": 9, "tasks": ["6.3", "7.3"] },
    { "id": 10, "tasks": ["6.4", "7.4", "7.5", "7.6", "7.7"] },
    { "id": 11, "tasks": ["6.5", "6.6", "6.7", "6.8", "6.9"] },
    { "id": 12, "tasks": ["10.1"] },
    { "id": 13, "tasks": ["10.2", "10.3", "10.4"] }
  ]
}
```
