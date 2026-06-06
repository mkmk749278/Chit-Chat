# Requirements Document

## Introduction

This document specifies the requirements for **Phase 0 — Infrastructure, CI/CD & Auth Foundation** of the
privacy chat application. The requirements are derived from the approved Phase 0 Technical Design
(`design.md`) and traced back to the product source of truth (`private-chat-app-requirements.md`, v0.4).

Phase 0 delivers the production-grade foundation only: the TypeScript monorepo, the NestJS backend skeleton,
Redis-cached Firebase ID-token verification, an authenticated device-registration endpoint that stores
public libsignal prekey bundles, a WebSocket gateway that authenticates and tracks connections (heartbeat +
connection registry + Redis pub/sub backbone, **no message routing yet**), the durable PostgreSQL schema for
users/devices/prekeys with the critical indexes, the Redis speed-layer wiring, the self-hosted
infrastructure (Docker Compose + Caddy), the GitHub Actions pipelines with classified GitHub Secrets, the
Firebase Auth backend integration, and observability (Prometheus, Grafana, Sentry, structured JSON logging).

Requirement numbering is intentionally aligned so the design's `Validates: Requirements X.Y` references
resolve: device registration & cached auth is Requirement 2, the WebSocket gateway is Requirement 3,
transactional integrity is Requirement 4, rate limiting is Requirement 5, and the health endpoint is
Requirement 11.

**Explicitly out of scope** (no requirements here): end-to-end message send/receive, the seven signature
features, group messaging, the media pipeline, and client UI screens. These are deferred to Phases 1–3.

## Glossary

- **Monorepo**: The single npm-workspaces repository containing `apps/`, `packages/`, `infra/`, and
  `.github/workflows/`.
- **Backend_API**: The NestJS application exposing REST endpoints on port 3000 and the WebSocket server on
  port 3001.
- **ConfigModule**: The NestJS module that loads and validates environment configuration at startup.
- **Firebase_Admin_Service**: The component wrapping the Firebase Admin SDK that verifies ID tokens.
- **Token_Verification_Service**: The Redis-cached verification path shared by the REST guard and the
  WebSocket gateway.
- **Firebase_Auth_Guard**: The NestJS guard that protects REST routes using the Token_Verification_Service.
- **Devices_Service**: The component that upserts the user and persists the device's public prekey bundle.
- **Realtime_Gateway**: The `ws`-based WebSocket gateway that authenticates, registers, and heart-beats
  connections.
- **Connection_Registry**: The Redis-backed record of which node holds which user's connection
  (`presence:{uid}`).
- **Rate_Limiter**: The Redis fixed-window counter component.
- **Database_Module**: The TypeORM + PgBouncer persistence layer over PostgreSQL.
- **Redis_Module**: The component providing the command, subscriber, and publisher Redis clients.
- **Health_Controller**: The unauthenticated liveness/readiness endpoint (`/health`).
- **Observability_Module**: The component wiring structured logging, Prometheus metrics, and Sentry.
- **Caddy_Proxy**: The edge reverse proxy providing automatic TLS.
- **Docker_Compose_Stack**: The set of containers run on the VPS via Docker Compose.
- **CI_Pipelines**: The GitHub Actions workflows (`backend.yml`, `web.yml`, `android.yml`, `pr.yml`,
  `backup.yml`).
- **Deploy_Pipeline**: The `backend.yml`/`web.yml` deployment portion of the CI_Pipelines.
- **Repository**: The GitHub repository holding source and classified GitHub Secrets.
- **AuthContext**: The verified identity `{ uid, email?, phoneNumber?, tokenExp }` attached after token
  verification.
- **Firebase UID**: The canonical user identifier issued by Firebase and used across all backend services.
- **Prekey bundle**: The public libsignal key material — public identity key, signed prekey (public key +
  signature), and one-time prekey public keys.

## Requirements

### Requirement 1: Monorepo Structure and Backend Module Skeleton

**User Story:** As a backend engineer, I want a TypeScript monorepo with a modular NestJS backend skeleton,
so that all apps and shared packages build from one repository without re-architecting in later phases.

#### Acceptance Criteria

1. THE Monorepo SHALL contain the following workspace directories, each present at the repository root:
   `apps/mobile`, `apps/web`, `apps/backend`, `packages/crypto`, `packages/types`, `packages/ui`,
   `infra/caddy`, `infra/docker`, `infra/prometheus`, `infra/scripts`, and `.github/workflows`.
2. THE Monorepo SHALL configure npm workspaces such that imports of `packages/types` and `packages/crypto`
   from within `apps/backend`, `apps/web`, and `apps/mobile` resolve to the in-repository package directories
   rather than to any external registry.
3. THE Backend_API SHALL compose its root application module from exactly the following modules: ConfigModule,
   HealthModule, AuthModule, DevicesModule, RealtimeModule, RedisModule, DatabaseModule, and
   ObservabilityModule.
4. IF one or more environment variables in the required configuration set are absent WHEN the Backend_API
   starts, THEN THE ConfigModule SHALL terminate startup before the Backend_API accepts any request and SHALL
   emit an error message listing the name of every missing environment variable.
5. WHEN a workspace-wide build is executed, THE Monorepo SHALL build every workspace (`apps/mobile`,
   `apps/web`, `apps/backend`, `packages/crypto`, `packages/types`, and `packages/ui`) to completion with
   zero compilation errors and zero type errors.
6. WHEN the Backend_API starts AND every environment variable in the required configuration set is present,
   THE Backend_API SHALL initialize all eight composed modules and SHALL begin accepting API requests, as
   indicated by the HealthModule returning a successful readiness response.

### Requirement 2: Device Registration with Cached Firebase Authentication

**User Story:** As an authenticated user, I want to register my device and publish my public prekey bundle
through an authenticated endpoint, so that the server can establish end-to-end encrypted sessions to my
device while storing no private key material.

#### Acceptance Criteria

1. IF a request to `POST /api/devices/register` does not carry a valid, unexpired, unrevoked Firebase ID
   token (missing, malformed, expired, revoked, or failing signature verification), THEN THE Backend_API
   SHALL reject the request with HTTP 401, perform no database write, and return an error indication.
2. WHEN the Token_Verification_Service returns an AuthContext for a valid token, THE
   Token_Verification_Service SHALL return the same Firebase UID whether the result is served from the Redis
   cache or from a fresh Firebase verification, SHALL set any cache entry's time-to-live to no greater than
   the token expiry minus the current time, and SHALL create no cache entry when the remaining token lifetime
   is zero or negative.
3. WHEN the Devices_Service persists a device registration, THE Devices_Service SHALL store only the public
   prekey bundle supplied by the client (public identity key, signed prekey public key and signature, and
   one-time prekey public keys) and SHALL store no private key material.
4. WHEN a registration request is received for a `(Firebase UID, registrationId)` pair that already exists,
   THE Devices_Service SHALL update the existing device record by replacing its stored prekey bundle and SHALL
   maintain exactly one `users` row per Firebase UID and exactly one `devices` row per `(user, registrationId)`.
5. IF any step of persisting a device and its prekey bundle fails, THEN THE Devices_Service SHALL roll back
   the entire transaction so that the database contains either the complete device and prekey bundle or none
   of it, and THE Backend_API SHALL return an error indication to the client.
6. WHEN a device registration succeeds, THE Backend_API SHALL respond with HTTP 201 and the server-issued
   `deviceId`.
7. IF a registration payload contains a non-base64 key value, an empty one-time prekey array, or a one-time
   prekey batch larger than 200 entries, THEN THE Backend_API SHALL reject the request with HTTP 400 before
   any database access and SHALL identify the invalid field.
8. IF a registration payload omits any required field (`registrationId`, public identity key, signed prekey
   public key, signed prekey signature, or the one-time prekey array), THEN THE Backend_API SHALL reject the
   request with HTTP 400 before any database access, SHALL perform no database write, and SHALL identify the
   missing field.
9. IF the signed prekey signature in a registration payload fails verification against the supplied public
   identity key, THEN THE Backend_API SHALL reject the request with HTTP 400 before any database access, SHALL
   perform no database write, and SHALL return an error indication that the signed prekey signature is invalid.

### Requirement 3: WebSocket Gateway (Authentication, Heartbeat, Registry, Pub/Sub Backbone)

**User Story:** As a connected client, I want an authenticated, heart-beated WebSocket connection that the
server tracks in a shared registry, so that real-time delivery can be added in Phase 1 without
re-establishing connection infrastructure.

#### Acceptance Criteria

1. IF a WebSocket handshake does not carry a valid, unexpired, unrevoked Firebase ID token, THEN THE
   Realtime_Gateway SHALL close the connection with code 4401 and SHALL NOT create any Connection_Registry or
   `presence:{uid}` entry for that handshake.
2. IF a registered connection does not return a pong within the 25-second interval following a heartbeat
   ping, THEN THE Realtime_Gateway SHALL terminate that connection within the next 25-second heartbeat
   interval and treat the termination as a connection close.
3. WHEN a connection closes, whether cleanly or by missed heartbeat, AND no other registered connection
   remains for that connection's uid, THE Realtime_Gateway SHALL remove the corresponding `presence:{uid}`
   entry from the Connection_Registry within 5 seconds.
4. WHEN a WebSocket handshake presents a valid, unexpired, unrevoked Firebase ID token, THE Realtime_Gateway
   SHALL register the connection as `{uid, connId} -> nodeId` in the Connection_Registry, set the
   `presence:{uid}` entry to online, and subscribe the node to its `node:{nodeId}` Redis pub/sub channel.
5. THE Realtime_Gateway SHALL limit Phase 0 behavior to authentication, connection registration, presence
   tracking, heartbeat, and pub/sub subscription, and SHALL NOT relay, forward, deliver, or persist any
   chat-message payload, deferring all chat-message relaying to Phase 1.
6. WHILE a connection is registered in the Connection_Registry, THE Realtime_Gateway SHALL send a heartbeat
   ping to that connection every 25 seconds.
7. WHEN a connection closes, whether cleanly or by missed heartbeat, THE Realtime_Gateway SHALL remove that
   connection's `{uid, connId} -> nodeId` entry from the Connection_Registry within 5 seconds.
8. IF the Realtime_Gateway cannot verify a presented Firebase ID token because the verification dependency is
   unavailable or does not respond within 5 seconds, THEN THE Realtime_Gateway SHALL close the connection and
   SHALL NOT create any Connection_Registry or `presence:{uid}` entry for that handshake.

### Requirement 4: Transactional Integrity

**User Story:** As a backend engineer, I want all multi-row writes wrapped in database transactions, so that
the persistence layer never holds partial or inconsistent state.

#### Acceptance Criteria

1. WHEN the Backend_API performs a multi-row write spanning the `users`, `devices`, `signed_prekeys`, and
   `one_time_prekeys` tables, THE Database_Module SHALL execute the write inside a single transaction that
   either commits fully or rolls back fully.
2. IF any statement within a multi-row write transaction fails, THEN THE Database_Module SHALL abort the
   transaction, discard every write made within it so that no partial rows remain in any of the affected
   tables, and return an error to the calling service indicating the write did not persist.
3. WHILE a multi-row write transaction is in progress, THE Database_Module SHALL ensure that every concurrent
   transaction observes either the committed state before the write or the committed state after the write,
   and never any intermediate or partially written state.
4. WHEN the Database_Module executes a multi-row write transaction through PgBouncer in transaction-pooling
   mode, THE Database_Module SHALL run all statements of that transaction on a single pooled connection so
   that no statement of the transaction executes on a separate connection.

### Requirement 5: Rate Limiting

**User Story:** As an operator, I want fixed-window rate limiting on the authentication and registration
surfaces, so that abuse and brute-force attempts are bounded without touching PostgreSQL.

#### Acceptance Criteria

1. THE Rate_Limiter SHALL maintain a fixed-window counter in Redis under the key `ratelimit:{scope}:{id}`
   with a time-to-live equal to the configured window in seconds.
2. WHEN a request reaches the device-registration endpoint or the WebSocket handshake, THE Rate_Limiter SHALL
   increment the counter for that surface and evaluate the count against the configured limit before the
   protected work executes.
3. WHILE a rate-limit window is active for a key, THE Rate_Limiter SHALL return at most `limit` results with
   `allowed=true` and SHALL return `allowed=false` for every additional hit within that window.
4. IF an incoming request's incremented counter value exceeds the configured limit for its key within the
   active window, THEN THE Rate_Limiter SHALL return `allowed=false`, prevent the protected work from
   executing, and return a rejection response indicating that the rate limit has been exceeded, while
   retaining the counter value and its remaining time-to-live unchanged.
5. WHEN the configured window elapses and the counter key's time-to-live expires, THE Rate_Limiter SHALL
   reset the count for that key to zero so that requests in the next window are again evaluated with
   `allowed=true` up to the configured limit.
6. THE Rate_Limiter SHALL accept a configured window in the range of 1 to 86,400 seconds (inclusive) and a
   configured limit in the range of 1 to 1,000,000 requests (inclusive), and SHALL refuse to start with a
   configuration error indication if either value falls outside its range.

### Requirement 6: PostgreSQL Persistence Schema and Indexes

**User Story:** As a backend engineer, I want the durable schema for users, devices, and prekeys with the
critical lookup indexes created from day one, so that the public prekey store is ready and performant for
Phase 1 key exchange.

#### Acceptance Criteria

1. THE Database_Module SHALL create the `users`, `devices`, `signed_prekeys`, and `one_time_prekeys` tables
   by applying versioned TypeORM migrations in ascending version order.
2. THE `users` table SHALL enforce a unique constraint on `firebase_uid`.
3. THE `devices` table SHALL enforce a unique constraint on `(user_id, registration_id)`, and the `devices`,
   `signed_prekeys`, and `one_time_prekeys` tables SHALL define foreign keys with `ON DELETE CASCADE` to
   their parent records.
4. THE Database_Module SHALL create the indexes `idx_prekeys_user_device` on `devices(user_id, id)`,
   `idx_onetime_prekeys_device_unconsumed` on `one_time_prekeys(device_id) WHERE consumed_at IS NULL`, and
   `idx_signed_prekeys_device` on `signed_prekeys(device_id)` during Phase 0.
5. THE Backend_API SHALL connect to PostgreSQL through PgBouncer in transaction-pooling mode rather than
   connecting to PostgreSQL directly.
6. IF a TypeORM migration fails during execution, THEN THE Database_Module SHALL halt the migration run,
   leave the schema in its pre-migration state, and surface an error indicating which migration failed.
7. IF a write violates the unique constraint on `users.firebase_uid` or on `devices(user_id, registration_id)`,
   THEN THE Database_Module SHALL reject the write, leave the conflicting existing row unchanged, and return
   an error indicating the constraint conflict.
8. WHEN a `users` or `devices` row is deleted, THE Database_Module SHALL delete all `devices`,
   `signed_prekeys`, and `one_time_prekeys` rows that reference the deleted record through their
   `ON DELETE CASCADE` foreign keys.

### Requirement 7: Redis Speed Layer Wiring

**User Story:** As a backend engineer, I want configured Redis clients for caching, presence, pub/sub, and
rate limiting, so that every hot path uses the in-memory speed layer.

#### Acceptance Criteria

1. THE Redis_Module SHALL provide three distinct ioredis connections — one command client, one dedicated
   subscriber, and one dedicated publisher — each established as a separate connection to the Redis server.
2. WHEN the Redis_Module initializes, THE Redis_Module SHALL construct its command, subscriber, and publisher
   clients from the `REDIS_URL` environment variable, applying exponential reconnection backoff that starts
   at 500 milliseconds, is capped at 30 seconds, and includes randomised jitter.
3. THE Redis_Module SHALL expose helper interfaces for the token cache, the presence registry, and the
   rate-limit counters.
4. IF a Redis token-cache read or write fails or does not complete within 50 milliseconds, THEN THE
   Token_Verification_Service SHALL fall back to direct Firebase token verification so that authentication
   continues without rejecting the request solely because the Redis operation failed.
5. WHEN a Firebase token is successfully verified, THE Redis_Module SHALL cache the verification result for
   the remaining lifetime of that token so that subsequent verifications within the token lifetime are served
   from Redis rather than Firebase.
6. IF the `REDIS_URL` environment variable is absent or cannot be parsed into a valid connection target, THEN
   THE Redis_Module SHALL fail initialization at startup and surface an error indicating the missing or
   invalid configuration, without serving any cache, presence, pub/sub, or rate-limit request.

### Requirement 8: Firebase Authentication Backend Integration

**User Story:** As a backend engineer, I want the Firebase Admin SDK wired for server-side token
verification with the Firebase UID as the canonical identifier, so that all backend services share one
identity source.

#### Acceptance Criteria

1. THE Firebase_Admin_Service SHALL initialize the Firebase Admin SDK exactly once at service startup, before
   processing any token verification request, using credentials read from `FIREBASE_PROJECT_ID`,
   `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`.
2. WHEN the Firebase_Admin_Service verifies an ID token, THE Firebase_Admin_Service SHALL validate the token
   signature and expiration and SHALL perform revocation checking against the Firebase Admin API.
3. IF token verification fails for any reason, THEN THE Firebase_Admin_Service SHALL raise a domain
   `UnauthorizedError` and SHALL exclude Firebase SDK internals from the client-facing response.
4. THE Backend_API SHALL use the Firebase UID as the canonical user identifier across all backend services.
5. IF the Firebase Admin API is unreachable on a cache miss (no response within 5 seconds or connection
   failure), THEN THE Backend_API SHALL respond with HTTP 503 (REST) or WebSocket close code 4503 and SHALL
   capture the error in Sentry.
6. WHEN token verification succeeds, THE Firebase_Admin_Service SHALL return the verified identity containing
   the Firebase UID.
7. IF any of `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, or `FIREBASE_PRIVATE_KEY` is missing or invalid
   at startup, THEN THE Firebase_Admin_Service SHALL fail initialization and SHALL prevent the Backend_API
   from accepting token verification requests.

### Requirement 9: Containerized Infrastructure and Edge Routing

**User Story:** As an operator, I want all services orchestrated via Docker Compose behind Caddy with
automatic TLS, so that the single-VPS deployment is reproducible and secure.

#### Acceptance Criteria

1. THE Docker_Compose_Stack SHALL define the `backend`, `web`, `postgres`, `pgbouncer`, `redis`, `caddy`,
   `prometheus`, and `grafana` services, each configured to automatically restart on failure and when the
   Docker daemon restarts, with startup dependency ordering such that each service starts only after the
   services it depends on have reached running state.
2. THE `redis` service SHALL run with append-only-file persistence configured to `appendfsync everysec`.
3. THE Caddy_Proxy SHALL terminate TLS for the `api.`, `ws.`, and web subdomains using automatically obtained
   and automatically renewed Let's Encrypt certificates.
4. THE Caddy_Proxy SHALL reverse-proxy the `api.` subdomain to REST port 3000, the `ws.` subdomain to
   WebSocket port 3001 with frame compression disabled, and the web domain to port 3002.
5. IF a request to the `grafana.` subdomain originates from an IP address outside the configured
   administrative IP range, THEN THE Caddy_Proxy SHALL reject the request with an access-denied response and
   SHALL NOT forward it to the `grafana` service.
6. IF automatic Let's Encrypt certificate issuance or renewal for the `api.`, `ws.`, or web subdomain fails,
   THEN THE Caddy_Proxy SHALL continue serving the most recent valid certificate when one exists and SHALL
   retry issuance.
7. IF the upstream target for the `api.`, `ws.`, or web route is unreachable, THEN THE Caddy_Proxy SHALL
   return a gateway error response to the client indicating that the upstream service is unavailable.
8. WHEN a client connects to the `api.`, `ws.`, web, or `grafana.` subdomain over plain HTTP, THE Caddy_Proxy
   SHALL redirect the client to the equivalent HTTPS URL.

### Requirement 10: CI/CD Pipelines and Secrets Management

**User Story:** As a developer, I want all builds, tests, and deployments automated through GitHub Actions
with every secret sourced from GitHub Secrets, so that no PC and no plaintext secret is ever required.

#### Acceptance Criteria

1. THE CI_Pipelines SHALL provide the five workflows `backend.yml`, `web.yml`, `android.yml`, `pr.yml`, and
   `backup.yml`, each scoped by its path trigger or schedule.
2. WHEN the backend pipeline runs on a push to the deployment branch, THE Deploy_Pipeline SHALL execute lint,
   automated tests, and TypeScript build in sequence, and SHALL proceed to deployment on the VPS only after
   all three steps complete successfully.
3. THE CI_Pipelines SHALL source every secret from GitHub Secrets and inject each secret as an environment
   variable at deploy time.
4. THE CI_Pipelines SHALL exclude all secret values from build and deploy log output by masking each secret
   value wherever it would otherwise appear.
5. THE Repository SHALL define the classified secret categories A (VPS access), B (Firebase), E (database),
   F (storage), G (monitoring), H (backup encryption), and I (application security) before any pipeline runs.
6. WHEN a pull request targets `main`, THE CI_Pipelines SHALL run lint, typecheck, unit tests, and a build
   check without deploying, and SHALL report a failed status check if any of these steps fails.
7. WHEN deployment to the VPS completes, THE Deploy_Pipeline SHALL run database migrations and then verify
   the `/health` endpoint, retrying up to 5 times at 10-second intervals until the endpoint reports a healthy
   response or the 5 attempts are exhausted.
8. IF lint, automated tests, or the TypeScript build fails, THEN THE Deploy_Pipeline SHALL abort the pipeline
   without deploying to the VPS, mark the workflow run as failed, and leave the currently running deployment
   unchanged.
9. IF the `/health` endpoint does not report a healthy response within the 5 verification attempts, THEN THE
   Deploy_Pipeline SHALL mark the deployment as failed and report the failure in the workflow run.

### Requirement 11: Health and Readiness Endpoint

**User Story:** As an operator and as the deploy pipeline, I want an unauthenticated health endpoint that
truthfully reflects dependency reachability, so that deployments fail fast and container orchestration can
probe liveness.

#### Acceptance Criteria

1. WHEN `/health` is called, THE Health_Controller SHALL return a response body with `status: ok` and HTTP
   status 200 if and only if both PostgreSQL and Redis each respond successfully to a ping within 2 seconds.
2. THE Health_Controller SHALL serve `/health` without requiring any authentication credential, and SHALL
   return an identical response whether or not authentication credentials are supplied in the request.
3. THE Health_Controller SHALL restrict its `/health` response content to the overall health status and
   per-dependency reachability indicators, excluding all user data, credentials, secret values, and
   dependency connection strings.
4. IF either PostgreSQL or Redis fails to respond successfully to a ping within 2 seconds when `/health` is
   called, THEN THE Health_Controller SHALL return a response body with `status: degraded`, HTTP status 503,
   and an indication identifying each dependency that was unreachable.
5. WHEN `/health` is called, THE Health_Controller SHALL return a response within 5 seconds regardless of
   whether PostgreSQL or Redis are reachable.

### Requirement 12: Observability

**User Story:** As an operator, I want structured logging, Prometheus metrics, and Sentry error tracking
from day one, so that the system is measurable and debuggable against the performance targets.

#### Acceptance Criteria

1. WHEN an HTTP request completes, THE Observability_Module SHALL emit one structured JSON log entry
   containing the request id, the route, the HTTP status, and the request latency in milliseconds.
2. THE Observability_Module SHALL exclude token values and secret values from all log output.
3. THE Observability_Module SHALL expose a Prometheus-format `/metrics` endpoint, reachable only from the
   monitoring network, that publishes HTTP request count and HTTP request latency metrics.
4. WHEN the Backend_API starts, THE Observability_Module SHALL initialize the Sentry SDK using the
   `SENTRY_DSN_BACKEND` value.
5. WHEN an unhandled error occurs, THE Observability_Module SHALL report the error to Sentry with token
   values and secret values excluded from the report.
6. IF a completed request was authenticated, THEN THE Observability_Module SHALL include the Firebase UID in
   that request's structured JSON log entry.
7. IF a request to the `/metrics` endpoint originates from outside the monitoring network, THEN THE
   Observability_Module SHALL reject the request and return no metrics data.

### Requirement 13: Security and Compliance Constraints

**User Story:** As a security and compliance owner, I want the foundation to enforce the project's hard
security and Google Play constraints, so that the build stays end-to-end-encryption-safe and policy
compliant from day one.

#### Acceptance Criteria

1. THE Backend_API SHALL require a valid, unexpired, unrevoked Firebase ID token on every endpoint except
   `/health` and `/metrics`, and SHALL restrict the `/metrics` endpoint to the monitoring network.
2. THE Backend_API SHALL use only the SHA-256 hash of a Firebase ID token as the token cache key and SHALL
   exclude raw token values from all log output and from all Redis key names.
3. THE Backend_API SHALL operate without requesting or depending on Android SMS, Call Log, Accessibility
   Service, or `QUERY_ALL_PACKAGES` permissions (Section 16.4).
4. THE Backend_API SHALL store public key material only and SHALL provide no request field, parameter, or
   schema path by which a private key can be accepted or persisted.
5. IF a request to any endpoint other than `/health` or `/metrics` does not carry a valid, unexpired,
   unrevoked Firebase ID token, THEN THE Backend_API SHALL reject the request without performing any
   privileged action or database write.
6. IF a request to the `/metrics` endpoint originates from outside the monitoring network, THEN THE
   Backend_API SHALL deny the request and return no metrics data.
7. IF a registration payload contains any field carrying private key material, THEN THE Backend_API SHALL
   reject the request with an error indication and SHALL persist none of the payload.
