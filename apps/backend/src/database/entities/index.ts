/**
 * Barrel export for the Phase 0 TypeORM entities mirroring the durable PostgreSQL
 * schema (users, devices, signed_prekeys, one_time_prekeys).
 *
 * The DatabaseModule (task 3.2) registers these with the TypeORM DataSource and the
 * migrations (task 3.3) create the corresponding tables, indexes, and constraints.
 */
export { UserEntity } from './user.entity';
export { DeviceEntity } from './device.entity';
export { SignedPreKeyEntity } from './signed-prekey.entity';
export { OneTimePreKeyEntity } from './one-time-prekey.entity';

/** Convenience array for `TypeOrmModule.forFeature` / DataSource `entities`. */
import { UserEntity } from './user.entity';
import { DeviceEntity } from './device.entity';
import { SignedPreKeyEntity } from './signed-prekey.entity';
import { OneTimePreKeyEntity } from './one-time-prekey.entity';

export const ENTITIES = [
  UserEntity,
  DeviceEntity,
  SignedPreKeyEntity,
  OneTimePreKeyEntity,
] as const;
