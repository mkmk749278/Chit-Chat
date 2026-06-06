/**
 * AuthModule — design Component 1/2/3 (Requirements 8.x, 2.1, 2.2, 7.4, 7.5, 13.1).
 *
 * Phase 0 auth layer. Task 5.1 wired the {@link FirebaseAdminService} — the single,
 * exactly-once Firebase Admin SDK entry point. Task 5.2 added the Redis-cached
 * {@link TokenVerificationService}, the shared verification path used by both the
 * REST guard (task 5.3) and the WebSocket gateway (task 7.1). Task 5.3 adds the
 * {@link FirebaseAuthGuard} (and its companion {@link Auth} param decorator), the
 * single REST entry point that turns an `Authorization: Bearer <idToken>` header
 * into a verified `AuthContext` on the request and rejects unauthenticated callers
 * with 401 (Requirements 2.1, 13.1, 13.5). The
 * {@link FirebaseUnavailableError} it raises on an unreachable-Firebase miss is
 * translated by those callers into HTTP 503 / WS close 4503 (Requirement 8.5).
 *
 * The {@link TokenCacheService} is provided process-wide by the `@Global` RedisModule,
 * so it is injected without importing RedisModule here. Likewise `AppConfigService`
 * is available because ConfigModule is `@Global`.
 *
 * The Sentry capture seam ({@link ERROR_REPORTER}) is bound here to the default
 * {@link LoggingErrorReporter}; task 9.3 can rebind it to a Sentry-backed reporter
 * with no change to the service.
 */

import { Module } from '@nestjs/common';

import { ERROR_REPORTER, LoggingErrorReporter } from './error-reporter';
import { FirebaseAdminService } from './firebase-admin.service';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { TokenVerificationService } from './token-verification.service';

@Module({
  providers: [
    FirebaseAdminService,
    TokenVerificationService,
    FirebaseAuthGuard,
    { provide: ERROR_REPORTER, useClass: LoggingErrorReporter },
  ],
  exports: [FirebaseAdminService, TokenVerificationService, FirebaseAuthGuard],
})
export class AuthModule {}
