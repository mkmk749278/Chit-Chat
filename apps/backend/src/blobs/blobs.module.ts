/**
 * BlobsModule — ciphertext-only attachment blob store (Phase 2, Requirement 7.1).
 *
 * Exposes the guarded, rate-limited `POST /api/blobs` + `GET /api/blobs/:id` surface backed by
 * {@link BlobService}. {@link AuthModule} is imported so Nest can resolve {@link FirebaseAuthGuard}'s
 * dependencies; the service uses the `@Global` RedisModule's command client, and the controller
 * pulls {@link RateLimiterService} from the `@Global` RedisModule.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { BlobsController } from './blobs.controller';
import { BlobService } from './blobs.service';

@Module({
  imports: [AuthModule],
  controllers: [BlobsController],
  providers: [BlobService],
  exports: [BlobService],
})
export class BlobsModule {}
