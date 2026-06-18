import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 5 — add `devices.push_token`.
 *
 * Platform push token (e.g. FCM) used to wake a device with a content-free data push when a
 * message is queued for it while offline (Phase 2 Req 6.1/6.2). Nullable (a device may never
 * register one, or revoke it — Req 6.4). Additive and reversible.
 */
export class AddDevicePushToken1700000000005 implements MigrationInterface {
  name = 'AddDevicePushToken1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "push_token" TEXT`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "push_token"`);
  }
}
