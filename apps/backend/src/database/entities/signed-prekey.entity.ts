import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import type { SignedPreKey } from '@chat-app/types';
import { DeviceEntity } from './device.entity';

/**
 * `signed_prekeys` — the active signed prekey for a device, rotated periodically.
 *
 * Enforces a UNIQUE constraint on `(device_id, key_id)` (Requirement 6.3) and an
 * `ON DELETE CASCADE` foreign key to `devices` (Requirement 6.3, 6.8). `public_key`
 * and `signature` are PUBLIC `bytea` material only (Requirement 13.4).
 *
 * Implements the `SignedPreKey` entity-as-type shape from `@chat-app/types`.
 */
@Entity('signed_prekeys')
@Unique(['device', 'keyId'])
export class SignedPreKeyEntity implements SignedPreKey {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id: string;

  /** Owning device (FK → devices.id, ON DELETE CASCADE). */
  @ManyToOne(() => DeviceEntity, (device) => device.signedPreKeys, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'device_id' })
  device: DeviceEntity;

  /** Denormalized owning device id, mapped to the `device_id` FK column. */
  @Column({ type: 'uuid', name: 'device_id' })
  deviceId: string;

  /** libsignal signed prekey id; unique per `(deviceId, keyId)`. */
  @Column({ type: 'int', name: 'key_id' })
  keyId: number;

  /** PUBLIC signed prekey (`bytea`). */
  @Column({ type: 'bytea', name: 'public_key' })
  publicKey: Buffer;

  /** Signature over `public_key` by the identity key (`bytea`). */
  @Column({ type: 'bytea', name: 'signature' })
  signature: Buffer;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
