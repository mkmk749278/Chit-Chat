/**
 * AccountController — `POST /api/account/delete`, permanent account deletion for the
 * authenticated caller (see {@link AccountService}).
 *
 * POST (not DELETE) because the shared client `HttpClient` port only speaks GET/POST. The caller
 * can only ever delete THEIR OWN account: the uid comes from the verified token, never the body.
 * Rate-limited per uid so a stolen token cannot be used to hammer Firebase Admin.
 */

import {
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { AuthContext } from '@chat-app/types';

import { Auth, FirebaseAuthGuard } from '../auth';
import { RateLimiterService, TokenCacheService } from '../redis';
import { AccountService } from './account.service';

/** Deletion attempts allowed per uid per window (retries after a transient failure). */
export const ACCOUNT_DELETE_RATE_LIMIT = 5;
export const ACCOUNT_DELETE_RATE_WINDOW_SECONDS = 60 * 60;
export const ACCOUNT_DELETE_RATE_LIMIT_SCOPE = 'account-delete';

@Controller('api/account')
export class AccountController {
  private readonly logger = new Logger(AccountController.name);

  constructor(
    private readonly accounts: AccountService,
    private readonly rateLimiter: RateLimiterService,
    private readonly tokenCache: TokenCacheService,
  ) {}

  /**
   * Permanently delete the caller's account. Responds 204 once everything is gone; 503 when a
   * dependency (Firebase) failed part-way — the client should retry, which is safe.
   */
  @Post('delete')
  @UseGuards(FirebaseAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAccount(
    @Auth() auth: AuthContext,
    @Headers('authorization') authorization?: string,
  ): Promise<void> {
    let allowed = true;
    try {
      const result = await this.rateLimiter.hit(
        `${ACCOUNT_DELETE_RATE_LIMIT_SCOPE}:${auth.uid}`,
        ACCOUNT_DELETE_RATE_LIMIT,
        ACCOUNT_DELETE_RATE_WINDOW_SECONDS,
      );
      allowed = result.allowed;
    } catch {
      this.logger.warn('Account-deletion rate-limit check failed; allowing request');
    }
    if (!allowed) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    try {
      await this.accounts.deleteAccount(auth.uid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Account deletion incomplete, client should retry: ${message}`);
      throw new ServiceUnavailableException('Account deletion could not be completed; try again');
    }

    // The deleted identity's token must not keep passing the guard from the verification cache.
    const token = typeof authorization === 'string' ? authorization.replace(/^bearer\s+/i, '').trim() : '';
    if (token.length > 0) {
      await this.tokenCache.delete(token).catch(() => undefined);
    }
  }
}
