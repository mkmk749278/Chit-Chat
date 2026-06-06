/**
 * Public surface of the DatabaseModule (TypeORM + PgBouncer persistence layer).
 *
 * Feature modules import {@link DatabaseModule} (transitively, via the global module)
 * and inject {@link TransactionService} to run multi-row writes on a single pooled
 * connection:
 *
 * ```ts
 * await this.transactions.runInTransaction(async (manager) => {
 *   // every statement here runs on one PgBouncer-leased connection (Requirement 4.4)
 * });
 * ```
 */
export { DatabaseModule } from './database.module';
export { TransactionService } from './transaction.service';
export { buildTypeOrmOptions, DATABASE_POOL_SIZE } from './typeorm.config';
export { ENTITIES } from './entities';
export {
  UserEntity,
  DeviceEntity,
  SignedPreKeyEntity,
  OneTimePreKeyEntity,
} from './entities';
