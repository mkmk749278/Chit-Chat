/**
 * AccountModule — account lifecycle endpoints (currently: permanent deletion).
 *
 * Imports {@link AuthModule} for the guard and the Firebase Admin wrapper; the rate limiter,
 * token cache, Redis client, and TransactionService come from the `@Global` Redis/Database modules.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({
  imports: [AuthModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
