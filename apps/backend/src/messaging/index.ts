/**
 * Public surface of the backend MessagingModule (Phase 1, design Backend Component B).
 */

export { MessagingModule } from './messaging.module';
export { MessageRelayService, type RelayOutcome } from './message-relay.service';
export {
  OfflineQueueService,
  MAX_QUEUED_MESSAGES,
  QUEUE_TTL_SECONDS,
} from './offline-queue.service';
export {
  LOCAL_SOCKET_REGISTRY,
  InProcessSocketRegistry,
  type LocalSocketRegistry,
  type LocalRecipientSocket,
} from './local-socket-registry';
export type { NodeRelayMessage, NodeTypingMessage, NodeChannelMessage } from './node-relay-message';
