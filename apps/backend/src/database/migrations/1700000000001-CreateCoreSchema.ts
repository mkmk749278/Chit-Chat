import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 2 — create the durable Phase 0 schema.
 *
 * Creates `users`, `devices`, `signed_prekeys`, and `one_time_prekeys` exactly as
 * specified by the design's PostgreSQL schema:
 *
 * - UUID primary keys defaulted by `gen_random_uuid()`.
 * - snake_case columns; `timestamptz` timestamps defaulting to `now()`.
 * - PUBLIC key material stored as `bytea` only — no private-key column exists
 *   anywhere in the schema (Requirement 13.4).
 * - UNIQUE constraints on `users.firebase_uid`, `devices(user_id, registration_id)`,
 *   and `(device_id, key_id)` for both prekey tables (Requirement 6.2, 6.3).
 * - `ON DELETE CASCADE` foreign keys so deleting a user removes its devices and
 *   deleting a device removes its prekeys (Requirement 6.3, 6.8).
 *
 * Tables are created in dependency order (parents before children) and dropped in
 * the reverse order in {@link down}. TypeORM runs each migration in its own
 * transaction, so any failure here rolls back every statement of this migration,
 * leaving the schema in its pre-migration state and surfacing an error that names
 * this migration (Requirement 6.6).
 */
export class CreateCoreSchema1700000000001 implements MigrationInterface {
  name = 'CreateCoreSchema1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // USERS — one row per Firebase-authenticated account; firebase_uid is canonical.
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "firebase_uid" TEXT NOT NULL,
        "phone_number" TEXT,
        "email"        TEXT,
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_users_firebase_uid" UNIQUE ("firebase_uid")
      )
    `);

    // DEVICES — each linked device for a user (one identity key + registration id).
    await queryRunner.query(`
      CREATE TABLE "devices" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"         UUID NOT NULL,
        "registration_id" INTEGER NOT NULL,
        "identity_key"    BYTEA NOT NULL,
        "device_name"     TEXT,
        "last_seen_at"    TIMESTAMPTZ,
        "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_devices_user_registration" UNIQUE ("user_id", "registration_id"),
        CONSTRAINT "FK_devices_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);

    // SIGNED PREKEYS — one active signed prekey per device, rotated periodically.
    await queryRunner.query(`
      CREATE TABLE "signed_prekeys" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "device_id"  UUID NOT NULL,
        "key_id"     INTEGER NOT NULL,
        "public_key" BYTEA NOT NULL,
        "signature"  BYTEA NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_signed_prekeys_device_key" UNIQUE ("device_id", "key_id"),
        CONSTRAINT "FK_signed_prekeys_device" FOREIGN KEY ("device_id")
          REFERENCES "devices" ("id") ON DELETE CASCADE
      )
    `);

    // ONE-TIME PREKEYS — consumed one per session by senders (Phase 1). Public only.
    await queryRunner.query(`
      CREATE TABLE "one_time_prekeys" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "device_id"   UUID NOT NULL,
        "key_id"      INTEGER NOT NULL,
        "public_key"  BYTEA NOT NULL,
        "consumed_at" TIMESTAMPTZ,
        "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_one_time_prekeys_device_key" UNIQUE ("device_id", "key_id"),
        CONSTRAINT "FK_one_time_prekeys_device" FOREIGN KEY ("device_id")
          REFERENCES "devices" ("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop children before parents so cascading FKs never block the rollback.
    await queryRunner.query(`DROP TABLE IF EXISTS "one_time_prekeys"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "signed_prekeys"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "devices"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
