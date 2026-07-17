# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chit-Chat — a privacy-focused, end-to-end-encrypted chat application (Signal protocol). npm-workspaces monorepo, TypeScript strict everywhere (`tsconfig.base.json`), Node >= 20. The server never sees plaintext: it stores public prekey bundles, relays ciphertext envelopes, and stores ciphertext-only blobs. Production runs on a single VPS behind Caddy (`api.luminchat.app` REST, `ws.luminchat.app` WebSocket).

## Commands

```bash
npm ci                      # install (run at repo root)
npm run build:packages      # build shared packages FIRST — apps depend on their dist/ output
npm run build               # build:packages + all workspaces
npm run typecheck           # tsc across all workspaces
npm run lint                # ESLint (only apps/web has a lint script)
npm run test                # all workspace test suites
```

**Always run `npm run build:packages` after editing `packages/types`, `packages/crypto`, or `packages/ui`** — apps resolve them via compiled `dist/`, not source, so stale builds cause confusing typecheck/test failures.

CI (`.github/workflows/pr.yml`) runs on every PR to `main`: `npm ci` → `build:packages` → `lint` → `typecheck` → `test` → `build`. All must pass. Pushes to `main` touching `apps/backend/**` or `apps/web/**` auto-deploy to the VPS (`backend.yml`, `web.yml` via `infra/scripts/deploy.sh`).

### Running tests per workspace / single tests

Each workspace uses a different test runner:

- **backend** (Jest): `npm test --workspace=@chat-app/backend`. Single file: `npx jest src/messaging/message-relay.service.test.ts` from `apps/backend/`.
- **crypto** (node:test on compiled output): `npm test --workspace=@chat-app/crypto` runs `tsc` then `node --test dist/*.test.js`. Single file: from `packages/crypto/`, `npx tsc -p tsconfig.json && node --test dist/messaging-e2e.test.js`.
- **web** (Vitest): `npm test --workspace=@chat-app/web`. Single file: `npx vitest run app/lib/shadow-search.test.ts` from `apps/web/`.
- **mobile** (node:test on compiled output): `npm test --workspace=@chat-app/mobile` compiles `tsconfig.test.json` then runs `node --test` over `dist/**/*.test.js`.

Tests are a mix of example tests and `fast-check` property tests (`*.property.test.ts`). The crypto e2e tests run the real `@signalapp/libsignal-client` native library in Node.

### Database migrations (backend, TypeORM)

```bash
npm run migration:run --workspace=@chat-app/backend
npm run migration:generate --workspace=@chat-app/backend   # writes to src/database/migrations/
npm run migration:revert --workspace=@chat-app/backend
```

## Layout

- `apps/backend` — NestJS. REST on :3000, WebSocket on :3001 (raw `ws` adapter — **not** Socket.IO). Postgres/TypeORM + Redis, Firebase Admin auth.
- `apps/web` — Next.js 14 app router, dev on :3002.
- `apps/mobile` — Expo / React Native 0.74.
- `packages/crypto` — **the heart of the codebase.** Despite the name, this is the entire platform-agnostic client messaging core: libsignal session management, envelope codec, messaging orchestrator, conversation reducer/registry, offline retry/backoff, safety numbers, app lock / decoy PIN, shadow-chat derivation, disappearing messages. Most business logic and tests live here.
- `packages/types` — shared DTOs, entities-as-types, wire types.
- `packages/ui` — placeholder.
- `infra/` — Docker Compose stack (backend, web, Postgres+PgBouncer, Redis, Caddy, Prometheus, Grafana), deploy/migration/health-check scripts.
- `.kiro/specs/<phase>/{requirements,design,tasks}.md` — **source of truth for scope and behavior.** Development is spec-driven; code comments cite requirement numbers ("Req 3.2", "design §14.5") that resolve into these files.
- `docs/roadmap.md` — live feature status; `docs/phase1-handoff.md` and `docs/messaging-runtime-binding.md` — key architectural decisions and remaining platform-gated work.

## Architecture essentials

### The libsignal port boundary (most important constraint)

`packages/crypto` never statically imports a concrete libsignal implementation. Session/cipher operations and key generation are injected behind two ports: `LibsignalEngine` (`session-manager.ts`) and `LibsignalKeyGen` (`identity-manager.ts`). This exists because `@signalapp/libsignal-client` is a Node native addon that cannot load in a browser (it would break `next build`) — so each platform binds its own engine:

- Node/tests: `libsignal-engine.node.ts`, `libsignal-keygen.node.ts` (real Rust libsignal).
- Web/mobile clients: pure-TS engine (`@privacyresearch/libsignal-protocol-typescript`, see `libsignal-puretsignal.ts`).

**Do not add a concrete engine import to shared crypto code.** Also note both peers in a conversation must use the same protocol implementation family — `@signalapp` and `@privacyresearch` ciphertext are incompatible, so engine choice is global, not per-platform. `libsignal-roundtrip.test.ts` is the reference for correct engine behavior.

The same ports-and-adapters pattern applies throughout: clients supply `RealtimeClient` transport, `HttpClient`, `KeyStore`/`SignalProtocolStore` adapters (`apps/web/app/lib/`, `apps/mobile/src/transport|crypto/`), while orchestration stays in `packages/crypto`.

### Backend

- `app.module.ts` composes all modules explicitly and documents the security posture: every endpoint requires `FirebaseAuthGuard` except `/health` and `/metrics` (monitoring-network-guarded). Never register a global guard override.
- Auth: Firebase ID tokens, verified via Redis-cached `TokenVerificationService` shared by the REST guard and the WS handshake.
- Realtime/messaging flow: WS gateway (`realtime/`) authenticates and registers connections in Redis (`presence:{uid}` → node id); `MessageRelayService` (`messaging/`) delivers locally or publishes to the owning node via Redis pub/sub (`node:{nodeId}`); offline recipients get envelopes queued in Redis (`offline-queue.service.ts`) plus an FCM push. Everything relayed is opaque ciphertext.
- Redis also backs rate limiting and token caching (`redis/`). Postgres stores users/devices/prekeys only.
- Config validation is fail-fast at bootstrap (`config/`); a healthy `/health` implies env validation passed.

### Cross-cutting conventions

- React is pinned to 18.2.0 via root `overrides`; workspace deps reference each other as `*`/`0.0.0`.
- Strict DTO validation everywhere: the global `ValidationPipe` uses `whitelist` + `forbidNonWhitelisted` — new endpoint payload fields must be declared on the DTO class or requests 400.
- Secrets are never committed; services read `.env.{service}` files written at deploy time from GitHub Secrets (`infra/scripts/lib.sh` pattern: never echo secret values).
- When adding features, check `.kiro/specs/` for an existing spec and `docs/roadmap.md` for status before designing from scratch; keep requirement-number citations in comments accurate.
