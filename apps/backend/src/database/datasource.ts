/**
 * Standalone TypeORM {@link DataSource} for the migration CLI (task 3.3).
 *
 * This DataSource is consumed exclusively by the TypeORM CLI via the
 * `migration:run` / `migration:revert` / `migration:generate` npm scripts
 * (`typeorm-ts-node-commonjs -d src/database/datasource.ts`). It is intentionally
 * separate from the runtime `TypeOrmModule` configuration in `typeorm.config.ts`:
 *
 *   - The **runtime** connects through PgBouncer in transaction-pooling mode and
 *     never mutates the schema (`synchronize: false`, `migrationsRun: false`).
 *   - **Migrations** (DDL) run here against PostgreSQL **directly** via
 *     `DATABASE_URL`, because schema changes should not flow through a
 *     transaction-pooling proxy. `MIGRATION_DATABASE_URL` may override the target.
 *
 * Migrations are applied in ascending version order (filename timestamp prefix),
 * each wrapped in its own transaction (`migrationsTransactionMode: 'each'`). If a
 * migration fails, its transaction rolls back, the run halts, and the CLI surfaces
 * an error naming the failed migration — leaving the schema in its pre-migration
 * state (Requirement 6.1, 6.6).
 */

import 'reflect-metadata';
import { DataSource } from 'typeorm';

import { ENTITIES } from './entities';

/**
 * Resolves the connection string used for migrations. Prefers an explicit
 * `MIGRATION_DATABASE_URL` (so operators can point the CLI at a direct Postgres
 * connection) and falls back to `DATABASE_URL` (the direct Postgres URL, not the
 * PgBouncer URL used at runtime).
 *
 * @throws {Error} when neither variable is set, so the CLI fails fast with a clear
 *   message instead of attempting an undefined connection.
 */
function resolveMigrationUrl(): string {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (url === undefined || url.trim().length === 0) {
    throw new Error(
      'Cannot run migrations: set DATABASE_URL (or MIGRATION_DATABASE_URL) to a ' +
        'direct PostgreSQL connection string before invoking the TypeORM CLI.',
    );
  }
  return url.trim();
}

/**
 * The migration CLI DataSource. Registers the Phase 0 entities and the versioned
 * migrations under `migrations/`, applied in ascending order.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: resolveMigrationUrl(),
  entities: [...ENTITIES],
  // Glob covers both `.ts` (ts-node CLI) and compiled `.js` (production deploy).
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  migrationsTableName: 'migrations',
  // Each migration runs in its own transaction: a failure rolls that migration back
  // and halts the run, leaving the schema in its pre-migration state (Req 6.6).
  migrationsTransactionMode: 'each',
  // The CLI owns the schema; never auto-synchronize or auto-run on connect.
  synchronize: false,
  migrationsRun: false,
  logging: ['error', 'migration', 'schema'],
});

export default AppDataSource;
