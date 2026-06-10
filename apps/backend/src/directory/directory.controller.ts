/**
 * DirectoryController — phone→UID contact discovery (`POST /api/directory/resolve`).
 *
 * The single authenticated REST surface a client uses to turn a recipient's phone number
 * into a Firebase UID so it can then claim a prekey bundle (`GET /api/keys/:uid`) and start
 * an encrypted chat. The controller is orchestration only — it delegates the lookup to
 * {@link DirectoryService}.
 *
 * Request lifecycle (each stage rejects before the next runs):
 *   1. {@link FirebaseAuthGuard} turns the `Authorization: Bearer <idToken>` header into a
 *      verified `AuthContext`, or rejects an unauthenticated caller with HTTP 401.
 *   2. The global ValidationPipe enforces {@link ResolvePhoneDto} (E.164 phone), rejecting a
 *      malformed body with HTTP 400 before any database access.
 *   3. The handler applies the per-uid {@link RateLimiterService} limit to blunt phone
 *      enumeration, rejecting an over-limit caller with HTTP 429 (fails open on limiter
 *      error so a transient cache outage cannot wedge discovery).
 *   4. On success it returns the {@link ResolvePhoneResponse} `{ uid }`; when no registered
 *      user owns the number the service throws {@link NotFoundException} → HTTP 404.
 *
 * The phone number rides the request BODY, never the URL, so it is not captured in proxy /
 * access logs.
 */

import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AuthContext, ResolvePhoneResponse } from '@chat-app/types';

import { Auth, FirebaseAuthGuard } from '../auth';
import { RateLimiterService } from '../redis';
import {
  DIRECTORY_RATE_LIMIT,
  DIRECTORY_RATE_LIMIT_SCOPE,
  DIRECTORY_RATE_WINDOW_SECONDS,
} from './directory.constants';
import { DirectoryService } from './directory.service';
import { ResolvePhoneDto } from './dto';

@Controller('api/directory')
export class DirectoryController {
  private readonly logger = new Logger(DirectoryController.name);

  constructor(
    private readonly directory: DirectoryService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  /**
   * Resolve a phone number to a registered user's Firebase UID for the authenticated caller.
   *
   * @param auth - the verified identity populated by {@link FirebaseAuthGuard}; its presence
   *   enforces that only an authenticated caller can resolve numbers, and its `uid` keys the
   *   rate limit.
   * @param dto - the validated request body carrying the E.164 phone number.
   * @returns `{ uid }` of the user registered with that number.
   * @throws HttpException 429 when the per-uid lookup rate limit is exceeded.
   * @throws NotFoundException (404) when no registered user owns the number (from the service).
   */
  @Post('resolve')
  @UseGuards(FirebaseAuthGuard)
  async resolve(
    @Auth() auth: AuthContext,
    @Body() dto: ResolvePhoneDto,
  ): Promise<ResolvePhoneResponse> {
    let allowed = true;
    try {
      const result = await this.rateLimiter.hit(
        `${DIRECTORY_RATE_LIMIT_SCOPE}:${auth.uid}`,
        DIRECTORY_RATE_LIMIT,
        DIRECTORY_RATE_WINDOW_SECONDS,
      );
      allowed = result.allowed;
    } catch {
      this.logger.warn('Directory rate-limit check failed; allowing request');
    }
    if (!allowed) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    return this.directory.resolvePhone(dto.phoneNumber);
  }
}
