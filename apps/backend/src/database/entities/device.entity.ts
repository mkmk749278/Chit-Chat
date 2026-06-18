import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import type { Device } from '@chat-app/types';
import { UserEntity } from './user.entity';
import { SignedPreKeyEntity } from './signed-prekey.entity';
import { OneTimePreKeyEntity } from './one-time-prekey.entity';

/**
 * `devices` — each linked device for a user.
 *
 * Enforces a UNIQUE constraint on `(user_id, registration_id)` (Requirement 6.3)
 * and an `ON DELETE CASCADE` foreign key to `users` so deleting a user removes its
 * devices (Requirement 6.3, 6.8). `identity_key` holds PUBLIC key material only
 * (Requirement 13.4) — private keys never leave the device.
 *
 * Implements the `Device` entity-as-type shape from `@chat-app/types`.
 */
@Entity('devices')
@Unique(['user', 'registrationId'])
export class DeviceEntity implements Device {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id: string;

  /** Owning user (FK → users.id, ON DELETE CASCADE). */
  @ManyToOne(() => UserEntity, (user) => user.devices, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  /** Denormalized owning user id, mapped to the `user_id` FK column. */
  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  /** libsignal registration id; unique per `(userId, registrationId)`. */
  @Column({ type: 'int', name: 'registration_id' })
  registrationId: number;

  /** PUBLIC identity key only (`bytea`). */
  @Column({ type: 'bytea', name: 'identity_key' })
  identityKey: Buffer;

  @Column({ type: 'text', name: 'device_name', nullable: true })
  deviceName?: string;

  /**
   * Platform push token (e.g. FCM registration token) used to wake this device with a
   * content-free data push when a message is queued while it is offline (Phase 2 Req 6.1/6.2).
   * Nullable; `null` means the device receives no pushes (never registered, or revoked — 6.4).
   * PUBLIC routing material only — never message content.
   */
  @Column({ type: 'text', name: 'push_token', nullable: true })
  pushToken?: string | null;

  @Column({ type: 'timestamptz', name: 'last_seen_at', nullable: true })
  lastSeenAt?: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  /** Active signed prekeys. Deleting a device cascades to its signed prekeys. */
  @OneToMany(() => SignedPreKeyEntity, (prekey) => prekey.device)
  signedPreKeys: SignedPreKeyEntity[];

  /** One-time prekeys. Deleting a device cascades to its one-time prekeys. */
  @OneToMany(() => OneTimePreKeyEntity, (prekey) => prekey.device)
  oneTimePreKeys: OneTimePreKeyEntity[];
}
