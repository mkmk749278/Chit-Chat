import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 4 — add `users.presence_enabled`.
 *
 * Opt-in flag for presence/last-seen (Phase 2 Req 5.1). Defaults to FALSE so existing users'
 * online state and last-seen stay private until they explicitly opt in via
 * `POST /api/directory/presence`. Additive, non-null with a default, and reversible.
 */
export class AddUserPresenceEnabled1700000000004 implements MigrationInterface {
  name = 'AddUserPresenceEnabled1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "presence_enabled" BOOLEAN NOT NULL DEFAULT FALSE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "presence_enabled"`);
  }
}
