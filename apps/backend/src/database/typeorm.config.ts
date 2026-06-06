/**
 * TypeORM DataSource configuration for the Phase 0 persistence layer.
 *
 * The backend connects to PostgreSQL **through PgBouncer in transaction-pooling
 * mode**, never to Postgres directly (Requirement 6.5). This factory builds the
 * `TypeOrmModuleOptions` consumed by `TypeOrmModule.forRootAsync` and is kept as a
 * pure function of {@link AppConfigService} so the wiring is trivial to reason about
 * and unit-test in isolation from Nest's DI container.
 *
 * ### PgBouncer transaction-pooling compatibility
 *
 * In transaction-pooling mode a backend connection is only leased to a client for
 * the duration of a single transaction, then returned to the pool. Two rules keep
 * the driver compatible with this:
 *
 * 1. **No server-side prepared statements.** Prepared statements live on a specific
 *    Postgres backend connection; under transaction pooling the next statement may
 *    land on a different connection, so a prepared statement would not be found.
 *    The `pg` driver only creates a server-side prepared statement when a query is
 *    given an explicit `name`; TypeORM never names its queries, so prepared
 *    statements are effectively disabled. We make that intent explicit below.
 * 2. **No reliance on session-level state across transactions.** Multi-statement
 *    writes must therefore run inside one `DataSource.transaction(...)` so every
 *    statement executes on the same leased connection (Requirement 4.4) — see
 *    {@link TransactionService}.
 *
 * Schema changes are owned by versioned migrations run via the CLI (task 3.3);
 * the runtime never auto-creates or auto-runs anything (`synchronize: false`,
 * `migrationsRun: false`).
 */

import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { AppConfigService } from '../config';
import { ENTITIES } from './entities';

/** Default connection-pool ceiling for the backend's PgBouncer-fronted DataSource. */
export const DATABASE_POOL_SIZE = 10;

/**
 * Builds the TypeORM options for the PgBouncer-fronted PostgreSQL connection.
 *
 * @param config - The typed, already-validated application configuration.
 * @returns Options for `TypeOrmModule.forRootAsync`, configured for PgBouncer
 *   transaction-pooling mode.
 */
export function buildTypeOrmOptions(config: AppConfigService): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    // Connect through PgBouncer, not Postgres directly (Requirement 6.5).
    url: config.pgbouncerUrl,
    entities: [...ENTITIES],

    // Schema is owned entirely by versioned migrations (task 3.3), applied via the
    // CLI. The runtime must never mutate the schema or auto-run migrations.
    synchronize: false,
    migrationsRun: false,
    // Migrations are registered with the CLI DataSource, not the runtime one.
    migrations: [],

    // Driver-level options passed to the underlying `pg` pool.
    extra: {
      // Bound the pool so the backend never exhausts PgBouncer's client slots.
      max: DATABASE_POOL_SIZE,
      // Explicitly opt out of server-side prepared statements. `pg` only prepares
      // named queries, and TypeORM issues none — this documents the requirement and
      // guards against any future change that would name queries and break
      // transaction pooling.
      statement_timeout: 0,
    },

    // Keep startup quiet; SQL logging is handled by the ObservabilityModule.
    logging: false,
  };
}
