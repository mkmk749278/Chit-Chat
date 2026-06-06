/**
 * ConfigModule — loads and validates environment configuration at startup
 * (Requirement 1.3, 1.4).
 *
 * Built on `@nestjs/config`. The `validate` hook runs `validateEnv` once during
 * module initialization; if any required variable is absent it throws an error
 * listing every missing name, which aborts `NestFactory.create(...)` before the
 * application binds a port or accepts any request — the fail-fast guarantee.
 *
 * Marked `@Global` so the typed `AppConfigService` is injectable everywhere without
 * each feature module re-importing this module.
 */

import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { AppConfigService } from './app-config.service';
import { validateEnv } from './env.validation';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // Fail-fast validation: throws (and lists every missing variable) before the
      // app accepts requests.
      validate: validateEnv,
      // The required secrets are injected as real environment variables at deploy
      // time (design.md §14.3); no committed .env file is read.
      ignoreEnvFile: true,
      cache: true,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class ConfigModule {}
