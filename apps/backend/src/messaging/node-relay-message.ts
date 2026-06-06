/**
 * Cross-node relay message (Phase 1, design Backend Component B; Requirements 5.7, 8.2).
 *
 * When a sender's envelope must reach a recipient whose live WebSocket connection is
 * held by a (possibly different) backend node, {@link MessageRelayService.relay}
 * publishes a `NodeRelayMessage` JSON payload to that node's `node:{nodeId}` Redis
 * pub/sub channel. The owning node — subscribed to its own channel — receives the
 * payload and calls {@link MessageRelayService.deliverLocal} to push the envelope to
 * the recipient's local socket(s).
 *
 * The payload carries only the routing target and the opaque `CiphertextEnvelope`; the
 * server never decodes or inspects the libsignal ciphertext body (Requirement 8.2).
 */

import type { CiphertextEnvelope } from '@chat-app/types';

/**
 * Published on `node:{nodeId}` so the node owning the recipient's connection delivers the
 * envelope to its local recipient socket(s).
 */
export interface NodeRelayMessage {
  /** Firebase UID of the recipient whose local socket(s) should receive the envelope. */
  targetUid: string;
  /** The opaque ciphertext envelope to deliver — never decoded or logged by the server. */
  envelope: CiphertextEnvelope;
}
