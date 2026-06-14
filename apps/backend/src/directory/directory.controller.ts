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
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AuthContext, ResolvePhoneResponse, WhoAmIResponse } from '@chat-app/types';

import { Auth, FirebaseAuthGuard } from '../auth';
import { RateLimiterService } from '../redis';
import {
  DIRECTORY_RATE_LIMIT,
  DIRECTORY_RATE_LIMIT_SCOPE,
  DIRECTORY_RATE_WINDOW_SECONDS,
} from './directory.constants';
import { DirectoryService } from './directory.service';
import { ResolvePhoneDto, SetProfileDto } from './dto';

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

  /**
   * Diagnostic: report the caller's own discovery state — the phone the TOKEN carries
   * (`tokenPhone`, read from the verified {@link AuthContext}), the phone STORED on their
   * user row (`storedPhone`), and their registered `deviceCount`. Comparing the three
   * pinpoints a discovery miss: `tokenPhone === null` ⇒ the Firebase token has no phone
   * claim; `tokenPhone` set but `storedPhone === null` ⇒ a storage problem; both set ⇒ the
   * lookup/format. Returns only the caller's own data.
   */
  @Get('me')
  @UseGuards(FirebaseAuthGuard)
  async me(@Auth() auth: AuthContext): Promise<WhoAmIResponse> {
    const record = await this.directory.whoAmI(auth.uid);
    return {
      uid: auth.uid,
      displayName: record.displayName,
      tokenPhone: auth.phoneNumber ?? null,
      storedPhone: record.storedPhone,
      deviceCount: record.deviceCount,
      selfLookup: record.selfLookup,
    };
  }

  /**
   * Set the signed-in user's display name (shown to peers instead of their UID). Called once
   * after onboarding; idempotent, so it can be re-sent on a name change.
   */
  @Post('profile')
  @UseGuards(FirebaseAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async setProfile(@Auth() auth: AuthContext, @Body() dto: SetProfileDto): Promise<void> {
    await this.directory.setDisplayName(auth.uid, dto.displayName);
  }
}
