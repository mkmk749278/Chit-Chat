import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 3 — create the Phase 0 lookup indexes.
 *
 * Creates the three indexes the design mandates for Phase 0 (Requirement 6.4):
 *
 * - `idx_prekeys_user_device` on `devices(user_id, id)` — supports prekey-bundle
 *   lookup for E2E key exchange.
 * - `idx_onetime_prekeys_device_unconsumed` on `one_time_prekeys(device_id)`,
 *   PARTIAL on `consumed_at IS NULL` — narrows scans to unconsumed one-time
 *   prekeys when a sender claims one.
 * - `idx_signed_prekeys_device` on `signed_prekeys(device_id)`.
 *
 * The Phase 1 `messages` indexes are intentionally NOT created here; they ship with
 * the `messages` table in Phase 1.
 *
 * Plain (non-`CONCURRENTLY`) `CREATE INDEX` is used so the whole migration stays
 * inside TypeORM's per-migration transaction; a failure rolls back every statement
 * and leaves the schema in its pre-migration state with an error naming this
 * migration (Requirement 6.6).
 */
export class CreatePhase0Indexes1700000000002 implements MigrationInterface {
  name = 'CreatePhase0Indexes1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_prekeys_user_device" ON "devices" ("user_id", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_onetime_prekeys_device_unconsumed" ` +
        `ON "one_time_prekeys" ("device_id") WHERE "consumed_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_signed_prekeys_device" ON "signed_prekeys" ("device_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_signed_prekeys_device"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_onetime_prekeys_device_unconsumed"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_prekeys_user_device"`);
  }
}
