/**
 * KeysController — design Backend Component A (Phase 1, Requirements 5.1, 13.1).
 *
 * Exposes `GET /api/keys/:uid`, the single authenticated REST surface a sender uses to
 * claim a recipient's PUBLIC prekey bundle so a libsignal session can be established to
 * the recipient's device. The controller is the orchestration layer only — it owns no
 * business logic, delegating the transactional claim to {@link PreKeyClaimService}.
 *
 * Request lifecycle for a single claim (each stage rejects before the next runs):
 *   1. {@link FirebaseAuthGuard} (`@UseGuards`) turns the `Authorization: Bearer <idToken>`
 *      header into a verified `AuthContext` on the request, or rejects an unauthenticated
 *      caller with HTTP 401 — performing no database access (Requirements 2.1, 13.1).
 *   2. The handler reads the verified caller identity via the {@link Auth} decorator and
 *      the recipient UID from the route, then delegates to
 *      {@link PreKeyClaimService.claimForUser}.
 *   3. On success it responds with the {@link PreKeyBundleResponse}. When the recipient
 *      has no registered device the service throws {@link NotFoundException}, surfaced as
 *      HTTP 404 (Requirement 5.1).
 */

import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import type { AuthContext, PreKeyBundleResponse } from '@chat-app/types';

import { Auth, FirebaseAuthGuard } from '../auth';
import { RateLimiterService } from '../redis';
import { PreKeyClaimService } from './pre-key-claim.service';

/**
 * Per-caller cap on prekey-bundle claims. Every claim CONSUMES one of the recipient's one-time
 * prekeys, so an unbounded claim loop by any signed-in account could exhaust a victim's supply
 * and silently degrade their new sessions to signed-prekey-only (weaker forward secrecy for the
 * first message). A client claims once per new session, so 30/min is far above real use.
 */
export const KEY_CLAIM_RATE_LIMIT = 30;
export const KEY_CLAIM_RATE_WINDOW_SECONDS = 60;
export const KEY_CLAIM_RATE_LIMIT_SCOPE = 'key-claim';

/** Firebase UIDs are at most 128 characters; anything longer cannot name a user. */
const MAX_UID_LENGTH = 128;

@Controller('api/keys')
export class KeysController {
  private readonly logger = new Logger(KeysController.name);

  constructor(
    private readonly preKeyClaim: PreKeyClaimService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  /**
   * Claims and returns the recipient's PUBLIC prekey bundle for the authenticated caller.
   *
   * @param _auth - the verified identity populated by {@link FirebaseAuthGuard} and read
   *   via the {@link Auth} decorator. Its presence enforces that only an authenticated
   *   sender can claim a bundle; the claim itself is keyed by the route `uid`.
   * @param uid - the recipient's canonical Firebase UID, taken from the route.
   * @returns the recipient device's identity key + active signed prekey, plus one claimed
   *   one-time prekey (or `oneTimePreKey: null` when exhausted).
   * @throws NotFoundException (HTTP 404) when the recipient has no registered device.
   */
  @Get(':uid')
  @UseGuards(FirebaseAuthGuard)
  async claim(
    @Auth() auth: AuthContext,
    @Param('uid') uid: string,
  ): Promise<PreKeyBundleResponse> {
    if (uid.length === 0 || uid.length > MAX_UID_LENGTH) {
      throw new NotFoundException('Recipient has no registered device');
    }
    let allowed = true;
    try {
      const result = await this.rateLimiter.hit(
        `${KEY_CLAIM_RATE_LIMIT_SCOPE}:${auth.uid}`,
        KEY_CLAIM_RATE_LIMIT,
        KEY_CLAIM_RATE_WINDOW_SECONDS,
      );
      allowed = result.allowed;
    } catch {
      this.logger.warn('Key-claim rate-limit check failed; allowing request');
    }
    if (!allowed) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.preKeyClaim.claimForUser(uid);
  }
}
