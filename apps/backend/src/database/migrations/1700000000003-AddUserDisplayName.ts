import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 3 — add `users.display_name`.
 *
 * The human-readable name a user chooses at onboarding, shown to peers instead of a raw
 * Firebase UID. Nullable (set via `POST /api/directory/profile` after sign-in) and returned
 * by the directory resolve + `/me` surfaces. Additive and reversible.
 */
export class AddUserDisplayName1700000000003 implements MigrationInterface {
  name = 'AddUserDisplayName1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_name" TEXT`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "display_name"`);
  }
}
