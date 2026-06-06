/**
 * DevicesController — design Component 4 (Requirements 2.1, 2.6, 2.9, 5.2, 13.1).
 *
 * Exposes `POST /api/devices/register` (Section 15.3), the single authenticated REST
 * surface a client uses to register (or re-register) a device and publish its PUBLIC
 * libsignal prekey bundle. The controller is the orchestration layer only — it owns no
 * business logic, delegating the transactional write to {@link DevicesService}.
 *
 * Request lifecycle for a single registration (each stage rejects before the next runs):
 *   1. {@link FirebaseAuthGuard} (`@UseGuards`) turns the `Authorization: Bearer <idToken>`
 *      header into a verified `AuthContext` on the request, or rejects an unauthenticated
 *      caller with HTTP 401 — performing no database write (Requirements 2.1, 13.1).
 *   2. The global ValidationPipe enforces the {@link RegisterDeviceDto} class-validator
 *      rules (base64 key fields, bounded one-time-prekey batch, etc.), rejecting a
 *      structurally invalid body with HTTP 400 (Requirements 2.7, 2.8, 13.4).
 *   3. The {@link SignedPreKeyVerificationPipe} (applied on the body) verifies the signed
 *      prekey signature against the supplied PUBLIC identity key and rejects a bad
 *      signature with HTTP 400 — before any database access (Requirement 2.9).
 *   4. The handler applies the {@link RateLimiterService} to the per-uid registration
 *      surface (`register:{uid}`) and rejects with HTTP 429 once the configured
 *      fixed-window limit is exceeded, before the transactional write executes
 *      (Requirement 5.2). A limiter failure (e.g. Redis unavailable) fails open so a
 *      transient cache outage cannot block legitimate registrations — mirroring the
 *      WebSocket handshake limiter.
 *   5. On success it calls {@link DevicesService.registerDevice} and responds HTTP 201
 *      with the server-issued `{ deviceId }` (Requirement 2.6).
 */

import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AuthContext, RegisterDeviceResponse } from '@chat-app/types';

import { Auth, FirebaseAuthGuard } from '../auth';
import { RateLimiterService } from '../redis';
import {
  REGISTER_RATE_LIMIT,
  REGISTER_RATE_LIMIT_SCOPE,
  REGISTER_RATE_WINDOW_SECONDS,
} from './devices.constants';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto';
import { SignedPreKeyVerificationPipe } from './signed-prekey-verification.pipe';

@Controller('api/devices')
export class DevicesController {
  private readonly logger = new Logger(DevicesController.name);

  constructor(
    private readonly devices: DevicesService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  /**
   * Registers (or re-registers) the authenticated caller's device and publishes its
   * PUBLIC prekey bundle.
   *
   * @param auth - the verified identity populated by {@link FirebaseAuthGuard} and read
   *   via the {@link Auth} decorator; only `auth.uid` is trusted as the device owner.
   * @param dto - the validated registration payload. The global ValidationPipe has
   *   enforced its structural rules and {@link SignedPreKeyVerificationPipe} has verified
   *   the signed prekey signature before this body is bound.
   * @returns HTTP 201 with the server-issued `{ deviceId }` (Requirement 2.6).
   * @throws HttpException 429 when the per-uid registration rate limit is exceeded
   *   (Requirement 5.2), raised before any database write.
   */
  @Post('register')
  @UseGuards(FirebaseAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Auth() auth: AuthContext,
    @Body(SignedPreKeyVerificationPipe) dto: RegisterDeviceDto,
  ): Promise<RegisterDeviceResponse> {
    // Rate-limit the per-uid registration surface BEFORE the transactional write runs
    // (Requirement 5.2). A limiter failure must not wedge registration, so it fails open.
    let allowed = true;
    try {
      const result = await this.rateLimiter.hit(
        `${REGISTER_RATE_LIMIT_SCOPE}:${auth.uid}`,
        REGISTER_RATE_LIMIT,
        REGISTER_RATE_WINDOW_SECONDS,
      );
      allowed = result.allowed;
    } catch {
      this.logger.warn('Device-registration rate-limit check failed; allowing request');
    }
    if (!allowed) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    return this.devices.registerDevice(auth.uid, dto);
  }
}
