/**
 * TransactionService — the single-connection transaction helper for multi-row writes
 * (Requirement 4.4).
 *
 * Every multi-row write that spans the `users`, `devices`, `signed_prekeys`, and
 * `one_time_prekeys` tables must run as one atomic unit (Requirements 4.1–4.3). When
 * the backend talks to PostgreSQL **through PgBouncer in transaction-pooling mode**,
 * a pooled backend connection is only leased to the client for the lifetime of a
 * single transaction. Issuing statements through the shared `DataSource` (or its
 * default `EntityManager`) gives no guarantee that successive statements land on the
 * same leased connection, which would scatter a logical transaction across several
 * PgBouncer-pooled connections and break atomicity.
 *
 * {@link runInTransaction} sidesteps that by acquiring **one** `QueryRunner` — which
 * holds exactly one connection for its whole lifetime — beginning a transaction on
 * it, and handing the caller that runner's `EntityManager`. Because every statement
 * the caller issues goes through that one manager, every statement of the transaction
 * executes on the same pooled connection (Requirement 4.4). The runner is always
 * released back to the pool, even on failure.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Runs `work` inside a single database transaction on one pooled connection.
   *
   * The supplied {@link EntityManager} is bound to a dedicated `QueryRunner`, so all
   * statements issued through it execute on the same PgBouncer-leased connection
   * (Requirement 4.4). The transaction commits iff `work` resolves; if `work` throws,
   * the transaction is rolled back fully so no partial rows remain (Requirement 4.2),
   * and the original error is re-thrown to the caller.
   *
   * @typeParam T - The value produced by the unit of work.
   * @param work - Callback that performs the writes using the transaction-bound
   *   `EntityManager`. It must use only the provided manager; using the global
   *   `DataSource` instead would run statements on a different connection.
   * @returns The value returned by `work` after the transaction commits.
   * @throws Re-throws whatever `work` throws, after rolling the transaction back.
   */
  async runInTransaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    // One QueryRunner == one connection held for the whole transaction. This is the
    // mechanism that keeps every statement on a single pooled connection.
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await work(queryRunner.manager);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      // Any failure aborts the whole transaction: discard every write made within it
      // so no partial state survives (Requirement 4.2).
      await this.safeRollback(queryRunner);
      throw error;
    } finally {
      // Always return the connection to the pool, success or failure.
      await queryRunner.release();
    }
  }

  /**
   * Rolls the transaction back, swallowing any rollback error so it can never mask
   * the original failure that triggered the rollback. A failed rollback is logged
   * and the connection is still released by the caller's `finally` block.
   */
  private async safeRollback(queryRunner: {
    rollbackTransaction: () => Promise<void>;
  }): Promise<void> {
    try {
      await queryRunner.rollbackTransaction();
    } catch (rollbackError) {
      const message =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      this.logger.error(`Failed to roll back transaction: ${message}`);
    }
  }
}
