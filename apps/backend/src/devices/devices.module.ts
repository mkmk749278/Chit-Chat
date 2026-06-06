/**
 * DevicesModule — design Component 4 (Requirements 2.x, 4.x, 5.2, 6.x, 13.x).
 *
 * Phase 0 device-registration surface for `POST /api/devices/register`. This task (6.1)
 * establishes the module skeleton and the request DTOs ({@link RegisterDeviceDto} and its
 * nested {@link SignedPreKeyDto} / {@link OneTimePreKeyDto}) whose class-validator rules the
 * global ValidationPipe enforces before any handler runs (Requirements 2.7, 2.8, 13.4, 13.7).
 *
 * Task 6.2 adds the {@link SignedPreKeyVerificationPipe}, which verifies the signed prekey
 * signature against the supplied public identity key (via `@chat-app/crypto`) and rejects a
 * bad signature with HTTP 400 before any database access (Requirement 2.9). It is provided
 * and exported here so task 6.4's `DevicesController` can apply it on the request body.
 *
 * Task 6.4 adds the {@link DevicesController} — the guarded, rate-limited
 * `POST /api/devices/register` surface. It is protected by {@link FirebaseAuthGuard}
 * (provided by {@link AuthModule}, imported here so Nest can resolve the guard's own
 * dependencies) and applies the {@link RateLimiterService} (injected from the `@Global`
 * RedisModule) to the per-uid registration surface, so an over-limit caller is rejected
 * with HTTP 429 before the transactional write runs (Requirements 2.1, 2.6, 5.2, 13.1).
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { SignedPreKeyVerificationPipe } from './signed-prekey-verification.pipe';

@Module({
  imports: [AuthModule],
  controllers: [DevicesController],
  providers: [DevicesService, SignedPreKeyVerificationPipe],
  exports: [DevicesService, SignedPreKeyVerificationPipe],
})
export class DevicesModule {}
