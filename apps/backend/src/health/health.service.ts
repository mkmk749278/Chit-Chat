/**
 * HealthService — the dependency-probing logic behind `GET /health` (design Component 7,
 * Requirement 11).
 *
 * Pings Postgres (through PgBouncer, via the TypeORM {@link DataSource}) and Redis (via the
 * command client) concurrently, each bounded by {@link HEALTH_PING_TIMEOUT_MS} (Requirements
 * 11.1, 11.4). A dependency that does not answer within that window — or answers with an error —
 * is reported `down`. The overall {@link HealthReport.status} is `ok` iff every dependency is
 * `up`, otherwise `degraded`.
 *
 * Both probes always settle to `up`/`down` (never reject), so {@link check} returns within roughly
 * the ping budget regardless of dependency state, comfortably inside the contractual
 * {@link HEALTH_RESPONSE_BUDGET_MS} ceiling (Requirement 11.5). The returned report carries only
 * status, per-dependency reachability, uptime, and a build version — never user data, credentials,
 * secret values, or connection strings (Requirement 11.3).
 */

import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { REDIS_COMMAND_CLIENT } from '../redis';
import { HEALTH_PING_TIMEOUT_MS } from './health.constants';
import type { DependencyStatus, HealthReport } from './health.types';

/**
 * Resolve the non-sensitive build/version identifier surfaced in the health report. Sourced from
 * the environment so a deploy can stamp the running version; falls back to a neutral default.
 * Intentionally never a secret or connection string (Requirement 11.3).
 */
function resolveVersion(): string {
  return process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.0.0';
}

/**
 * Resolve `probe` to its value or reject once `ms` elapses, whichever comes first, always clearing
 * the timer so no handle is leaked. Used to bound each dependency ping to the health ping budget.
 */
function withTimeout<T>(probe: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('health ping timed out')), ms);
    probe.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_COMMAND_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Probe both dependencies concurrently and assemble the report. Each probe self-contains its
   * failure handling, so this never rejects (Requirement 11.5).
   */
  async check(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([this.pingPostgres(), this.pingRedis()]);

    const status = postgres === 'up' && redis === 'up' ? 'ok' : 'degraded';

    return {
      status,
      checks: { postgres, redis },
      uptimeSeconds: Math.floor(process.uptime()),
      version: resolveVersion(),
    };
  }

  /**
   * `SELECT 1` through the PgBouncer-backed DataSource, bounded by the ping budget. Any timeout or
   * driver error maps to `down` so a stalled or unreachable database never hangs the endpoint
   * (Requirements 11.1, 11.4, 11.5).
   */
  private async pingPostgres(): Promise<DependencyStatus> {
    try {
      await withTimeout(this.dataSource.query('SELECT 1'), HEALTH_PING_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }

  /**
   * `PING` against the Redis command client, bounded by the ping budget. Any timeout or connection
   * error maps to `down` (Requirements 11.1, 11.4, 11.5).
   */
  private async pingRedis(): Promise<DependencyStatus> {
    try {
      await withTimeout(this.redis.ping(), HEALTH_PING_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }
}
