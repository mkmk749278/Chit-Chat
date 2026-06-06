import { Module } from '@nestjs/common';

import { AuthModule } from './auth';
import { ConfigModule } from './config';
import { DatabaseModule } from './database';
import { DevicesModule } from './devices';
import { HealthModule } from './health';
import { KeysModule } from './keys';
import { ObservabilityModule } from './observability';
import { RealtimeModule } from './realtime';
import { RedisModule } from './redis';

/**
 * Root application module.
 *
 * Per Requirement 1.3, the Phase 0 AppModule composes exactly eight modules:
 * ConfigModule, HealthModule, AuthModule, DevicesModule, RealtimeModule,
 * RedisModule, DatabaseModule, and ObservabilityModule. Several of these
 * (e.g. RedisModule, DatabaseModule) are `@Global`, but each is still imported
 * explicitly here so the composition is exactly — and visibly — these eight.
 *
 * Phase 1 adds the KeysModule (`GET /api/keys/:uid` prekey-bundle claim), imported
 * explicitly alongside the Phase 0 modules.
 *
 * ConfigModule is imported first so its fail-fast environment validation runs
 * during application bootstrap, before any request is accepted (Requirement 1.6).
 * A successful readiness response from `/health` therefore indicates that env
 * validation passed and the app is accepting requests.
 *
 * Security posture (Requirement 13.1): every endpoint requires authentication
 * except `/health` and `/metrics`. This is enforced per-route — protected
 * controllers apply `FirebaseAuthGuard`, `/health` is intentionally
 * unauthenticated, and `/metrics` is gated by the monitoring-network guard.
 * AppModule deliberately registers no global guard/override that would weaken
 * or bypass that posture.
 */
@Module({
  imports: [
    ConfigModule,
    HealthModule,
    AuthModule,
    DevicesModule,
    RealtimeModule,
    RedisModule,
    DatabaseModule,
    ObservabilityModule,
    KeysModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
