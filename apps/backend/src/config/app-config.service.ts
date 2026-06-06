/**
 * Typed configuration accessor.
 *
 * Wraps `@nestjs/config`'s `ConfigService` so the rest of the backend reads validated
 * configuration through strongly-typed getters rather than reaching into
 * `process.env` directly. Because validation already ran at startup (see
 * `env.validation.ts`), every required value is guaranteed present here.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from './env.validation';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** Postgres connection string (direct). */
  get databaseUrl(): string {
    return this.get('DATABASE_URL');
  }

  /** PgBouncer connection string — the backend connects through this, not Postgres directly. */
  get pgbouncerUrl(): string {
    return this.get('PGBOUNCER_URL');
  }

  /** Redis connection string used for cache, presence, pub/sub, and rate limiting. */
  get redisUrl(): string {
    return this.get('REDIS_URL');
  }

  /** Firebase project id (Admin SDK credential). */
  get firebaseProjectId(): string {
    return this.get('FIREBASE_PROJECT_ID');
  }

  /** Firebase service-account client email (Admin SDK credential). */
  get firebaseClientEmail(): string {
    return this.get('FIREBASE_CLIENT_EMAIL');
  }

  /** Firebase service-account private key (Admin SDK credential). */
  get firebasePrivateKey(): string {
    return this.get('FIREBASE_PRIVATE_KEY');
  }

  /** Sentry DSN for backend error reporting. */
  get sentryDsnBackend(): string {
    return this.get('SENTRY_DSN_BACKEND');
  }

  /** Application JWT secret. */
  get jwtSecret(): string {
    return this.get('JWT_SECRET');
  }

  /** Application encryption key. */
  get encryptionKey(): string {
    return this.get('ENCRYPTION_KEY');
  }

  /** Resolved REST/HTTP listen port (defaults to 3000). */
  get port(): number {
    return this.get('PORT');
  }

  /** Resolved WebSocket listen port (defaults to 3001). */
  get wsPort(): number {
    return this.get('WS_PORT');
  }

  /**
   * Raw monitoring-network CIDR allowlist for the Prometheus `/metrics` endpoint
   * (comma/whitespace-separated). Empty when unset — callers parse this through
   * `parseMonitoringCidrs`, which substitutes the private/loopback defaults so the
   * endpoint is always locked down (Requirement 12.7, 13.6).
   */
  get monitoringCidrs(): string {
    return this.get('MONITORING_CIDRS');
  }

  /**
   * Strongly-typed passthrough to the underlying `ConfigService`. `infer: true` makes
   * the return type non-optional, reflecting that validation guarantees presence.
   */
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config.get(key, { infer: true });
  }
}
