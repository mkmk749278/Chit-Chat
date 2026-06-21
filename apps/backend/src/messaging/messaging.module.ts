/**
 * MessagingModule — design Backend Component B (Phase 1, Requirements 5.7, 8.2).
 *
 * Houses the WebSocket message-relay surface: the {@link MessageRelayService} (sender
 * binding + cross-node `node:{nodeId}` fan-out + local delivery) and the node-local
 * {@link InProcessSocketRegistry} that tracks which recipient sockets live on this node.
 *
 * The relay depends only on the `@Global` RedisModule (the `REDIS_PUBLISHER_CLIENT`
 * publisher connection and the `PresenceRegistryService`), so no Redis import is needed
 * here. Both the service and the local-socket registry are exported so the
 * {@link RealtimeGateway} can, in task 4.7, inject the relay for its `send`-frame handler
 * and the registry to register/unregister sockets across the connection lifecycle.
 */

import { Module } from '@nestjs/common';

import { DevicesModule } from '../devices';
import { FcmPushSender } from './fcm-push-sender';
import { InProcessSocketRegistry, LOCAL_SOCKET_REGISTRY } from './local-socket-registry';
import { MessageRelayService } from './message-relay.service';
import { OfflineQueueService } from './offline-queue.service';
import { PushNotificationService } from './push-notification.service';
import { PUSH_SENDER } from './push-sender';

@Module({
  // DevicesModule supplies DevicesService (push-token lookup) to PushNotificationService.
  imports: [DevicesModule],
  providers: [
    MessageRelayService,
    OfflineQueueService,
    PushNotificationService,
    // The content-free push transport. FcmPushSender reuses the existing Firebase Admin app
    // (the OTP-auth project) and self-degrades to a no-op when Firebase isn't configured (e.g.
    // CI / self-hosted without FIREBASE_* creds), so it is safe to wire unconditionally.
    { provide: PUSH_SENDER, useClass: FcmPushSender },
    { provide: LOCAL_SOCKET_REGISTRY, useClass: InProcessSocketRegistry },
  ],
  exports: [MessageRelayService, OfflineQueueService, LOCAL_SOCKET_REGISTRY],
})
export class MessagingModule {}
