import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import type { OneTimePreKey } from '@chat-app/types';
import { DeviceEntity } from './device.entity';

/**
 * `one_time_prekeys` — prekeys consumed one-per-session by senders (Phase 1).
 *
 * Enforces a UNIQUE constraint on `(device_id, key_id)` (Requirement 6.3) and an
 * `ON DELETE CASCADE` foreign key to `devices` (Requirement 6.3, 6.8). `public_key`
 * is PUBLIC `bytea` material only (Requirement 13.4). `consumed_at` is nullable and
 * stays null until a sender claims the key.
 *
 * Implements the `OneTimePreKey` entity-as-type shape from `@chat-app/types`.
 */
@Entity('one_time_prekeys')
@Unique(['device', 'keyId'])
export class OneTimePreKeyEntity implements OneTimePreKey {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id: string;

  /** Owning device (FK → devices.id, ON DELETE CASCADE). */
  @ManyToOne(() => DeviceEntity, (device) => device.oneTimePreKeys, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'device_id' })
  device: DeviceEntity;

  /** Denormalized owning device id, mapped to the `device_id` FK column. */
  @Column({ type: 'uuid', name: 'device_id' })
  deviceId: string;

  /** libsignal one-time prekey id; unique per `(deviceId, keyId)`. */
  @Column({ type: 'int', name: 'key_id' })
  keyId: number;

  /** PUBLIC one-time prekey (`bytea`). */
  @Column({ type: 'bytea', name: 'public_key' })
  publicKey: Buffer;

  /** Null until claimed by a sender (Phase 1). */
  @Column({ type: 'timestamptz', name: 'consumed_at', nullable: true })
  consumedAt?: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
