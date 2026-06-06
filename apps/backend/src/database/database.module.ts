/**
 * DatabaseModule — the TypeORM + PgBouncer persistence layer (design Component "Database_Module",
 * Requirements 4.4 and 6.5).
 *
 * Responsibilities:
 *
 * 1. **Connect through PgBouncer, not Postgres directly** (Requirement 6.5). The
 *    DataSource is built from {@link buildTypeOrmOptions}, which uses
 *    `AppConfigService.pgbouncerUrl` as the connection target and configures the
 *    `pg` driver for transaction-pooling compatibility (no server-side prepared
 *    statements, no schema auto-sync, migrations own the schema).
 * 2. **Register the Phase 0 entities** (`users`, `devices`, `signed_prekeys`,
 *    `one_time_prekeys`) with the DataSource so repositories and the transaction
 *    helper can operate on them.
 * 3. **Expose a single-connection transaction helper** via {@link TransactionService}
 *    so multi-row writes run every statement on one pooled connection (Requirement
 *    4.4).
 *
 * Marked `@Global` so feature modules (e.g. DevicesModule) can inject the
 * {@link TransactionService} and TypeORM repositories without re-importing this
 * module. The async factory ensures `AppConfigService` (and therefore the validated
 * configuration) is available before the connection is built.
 */

import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppConfigService, ConfigModule } from '../config';
import { ENTITIES } from './entities';
import { TransactionService } from './transaction.service';
import { buildTypeOrmOptions } from './typeorm.config';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      // Build the options as a pure function of the validated config so the
      // PgBouncer wiring is unit-testable in isolation (see typeorm.config.ts).
      useFactory: (config: AppConfigService) => buildTypeOrmOptions(config),
    }),
    // Register the Phase 0 entities for repository injection across the app.
    TypeOrmModule.forFeature([...ENTITIES]),
  ],
  providers: [TransactionService],
  // Re-export TypeOrmModule so `@InjectRepository(...)` resolves in importing modules,
  // and export the transaction helper for multi-row writes.
  exports: [TransactionService, TypeOrmModule],
})
export class DatabaseModule {}
