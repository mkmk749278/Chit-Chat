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
import { InProcessSocketRegistry, LOCAL_SOCKET_REGISTRY } from './local-socket-registry';
import { MessageRelayService } from './message-relay.service';
import { OfflineQueueService } from './offline-queue.service';
import { PushNotificationService } from './push-notification.service';
import { NoopPushSender, PUSH_SENDER } from './push-sender';

@Module({
  // DevicesModule supplies DevicesService (push-token lookup) to PushNotificationService.
  imports: [DevicesModule],
  providers: [
    MessageRelayService,
    OfflineQueueService,
    PushNotificationService,
    // The content-free push transport. NoopPushSender keeps the pipeline green until the FCM
    // binding lands with the mobile integration (task 6.3); swap the `useClass` then.
    { provide: PUSH_SENDER, useClass: NoopPushSender },
    { provide: LOCAL_SOCKET_REGISTRY, useClass: InProcessSocketRegistry },
  ],
  exports: [MessageRelayService, OfflineQueueService, LOCAL_SOCKET_REGISTRY],
})
export class MessagingModule {}
