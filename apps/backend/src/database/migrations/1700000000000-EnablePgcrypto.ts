import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 1 — enable the `pgcrypto` extension.
 *
 * The schema's UUID primary keys default to `gen_random_uuid()` (see
 * {@link CreateCoreSchema1700000000001}). That function is provided by the
 * `pgcrypto` extension on PostgreSQL versions before 13 and is built into core
 * from 13 onward; enabling the extension here is idempotent (`IF NOT EXISTS`) and
 * guarantees the default is resolvable regardless of server version
 * (Requirement 6.1).
 *
 * This migration is the lowest-versioned one so it always runs first in ascending
 * order. TypeORM wraps each migration in its own transaction, so if this step
 * fails the run halts and the schema is left in its pre-migration state with an
 * error naming this migration (Requirement 6.6).
 */
export class EnablePgcrypto1700000000000 implements MigrationInterface {
  name = 'EnablePgcrypto1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP EXTENSION IF EXISTS "pgcrypto"`);
  }
}
