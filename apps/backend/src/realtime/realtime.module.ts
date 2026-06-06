/**
 * RealtimeModule — design Component 5 (Requirements 3.x).
 *
 * Hosts the `ws`-based {@link RealtimeGateway}. Task 7.1 wires the authenticated
 * handshake; tasks 7.2 (connection registry + pub/sub) and 7.3 (heartbeat + cleanup)
 * extend the same gateway.
 *
 * The gateway depends on {@link TokenVerificationService} from {@link AuthModule}, so
 * AuthModule is imported here. The `presence:{uid}` registry helper
 * (`PresenceRegistryService`), the `RateLimiterService`, and the dedicated pub/sub
 * subscriber client all live in the `@Global` RedisModule, so the gateway injects them
 * directly without an explicit import here.
 *
 * Phase 1 (task 4.7) wires the message relay into the gateway, so {@link MessagingModule}
 * is imported here to provide the {@link MessageRelayService} and the
 * `LOCAL_SOCKET_REGISTRY` the gateway injects for its `send`-frame handler, ACKs, local
 * delivery, and the `node:{nodeId}` subscription callback.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { MessagingModule } from '../messaging';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [AuthModule, MessagingModule],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
