import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { User } from '@chat-app/types';
import { DeviceEntity } from './device.entity';

/**
 * `users` — one row per Firebase-authenticated account.
 *
 * `firebase_uid` is the canonical identifier across all backend services (§15.2)
 * and carries a UNIQUE constraint (Requirement 6.2). The primary key is a UUID
 * defaulted by PostgreSQL's `gen_random_uuid()` to match the design schema exactly.
 *
 * Implements the `User` entity-as-type shape from `@chat-app/types`.
 */
@Entity('users')
export class UserEntity implements User {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id: string;

  /** Canonical Firebase UID — UNIQUE (Requirement 6.2). */
  @Index({ unique: true })
  @Column({ type: 'text', name: 'firebase_uid' })
  firebaseUid: string;

  /** Nullable; never the discovery surface (hashed elsewhere). */
  @Column({ type: 'text', name: 'phone_number', nullable: true })
  phoneNumber?: string;

  @Column({ type: 'text', nullable: true })
  email?: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  /** Linked devices. Deleting a user cascades to its devices (Requirement 6.3, 6.8). */
  @OneToMany(() => DeviceEntity, (device) => device.user)
  devices: DeviceEntity[];
}
