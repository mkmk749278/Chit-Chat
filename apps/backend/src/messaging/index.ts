/**
 * Public surface of the backend MessagingModule (Phase 1, design Backend Component B).
 */

export { MessagingModule } from './messaging.module';
export { MessageRelayService, type RelayOutcome } from './message-relay.service';
export {
  InboxService,
  type InboxEntry,
  MAX_INBOX_ENTRIES,
  INBOX_TTL_SECONDS,
  MAX_ACK_IDS_PER_FRAME,
} from './inbox.service';
export { PushNotificationService, WAKE_DEBOUNCE_SECONDS } from './push-notification.service';
export {
  LOCAL_SOCKET_REGISTRY,
  InProcessSocketRegistry,
  type LocalSocketRegistry,
  type LocalRecipientSocket,
} from './local-socket-registry';
export type { NodeRelayMessage, NodeTypingMessage, NodeChannelMessage } from './node-relay-message';
