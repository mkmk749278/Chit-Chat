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

import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { AuthContext, PreKeyBundleResponse } from '@chat-app/types';

import { Auth, FirebaseAuthGuard } from '../auth';
import { PreKeyClaimService } from './pre-key-claim.service';

@Controller('api/keys')
export class KeysController {
  constructor(private readonly preKeyClaim: PreKeyClaimService) {}

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
    @Auth() _auth: AuthContext,
    @Param('uid') uid: string,
  ): Promise<PreKeyBundleResponse> {
    return this.preKeyClaim.claimForUser(uid);
  }
}
