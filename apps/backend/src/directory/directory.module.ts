/**
 * DirectoryModule — phone→UID contact discovery (`POST /api/directory/resolve`).
 *
 * Houses the guarded, rate-limited directory surface that lets a client turn a recipient's
 * phone number into a Firebase UID so it can then claim a prekey bundle and start a chat.
 *
 * {@link AuthModule} is imported so Nest can resolve the {@link FirebaseAuthGuard}'s own
 * dependencies (mirroring DevicesModule / KeysModule). The {@link DirectoryService} depends
 * only on the `@Global` DatabaseModule's {@link TransactionService}, and the controller pulls
 * the {@link RateLimiterService} from the `@Global` RedisModule. The service is exported so
 * other callers can reuse the resolution logic.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { DirectoryController } from './directory.controller';
import { DirectoryService } from './directory.service';

@Module({
  imports: [AuthModule],
  controllers: [DirectoryController],
  providers: [DirectoryService],
  exports: [DirectoryService],
})
export class DirectoryModule {}
