/**
 * HealthModule — wires the unauthenticated `/health` endpoint (design Component 7, Requirement 11).
 *
 * Declares the {@link HealthController} and its {@link HealthService}. The dependencies the service
 * probes — the TypeORM {@link DataSource} (PgBouncer) and the Redis command client — are provided
 * by the `@Global` DatabaseModule and RedisModule, so this module needs no further imports.
 */

import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
