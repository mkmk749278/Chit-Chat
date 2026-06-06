/**
 * KeysModule — design Backend Component A (Phase 1, Requirement 5.1).
 *
 * Houses the prekey-claim surface that lets a sender fetch a recipient's PUBLIC prekey
 * bundle so a libsignal session can be established. This task (4.1) provides the
 * {@link PreKeyClaimService} (the transactional claim logic); task 4.2 adds the guarded
 * `KeysController` (`GET /api/keys/:uid`) to this module and wires it into the AppModule.
 *
 * The service depends only on the `@Global` DatabaseModule's {@link TransactionService}
 * and the Phase 0 entities. The guarded {@link KeysController} (`GET /api/keys/:uid`,
 * task 4.2) is registered here and protected by {@link FirebaseAuthGuard}, so
 * {@link AuthModule} is imported to let Nest resolve the guard's own dependencies
 * (mirroring the DevicesModule wiring). The service is exported so the controller (and
 * any other caller) can inject it.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { KeysController } from './keys.controller';
import { PreKeyClaimService } from './pre-key-claim.service';

@Module({
  imports: [AuthModule],
  controllers: [KeysController],
  providers: [PreKeyClaimService],
  exports: [PreKeyClaimService],
})
export class KeysModule {}
