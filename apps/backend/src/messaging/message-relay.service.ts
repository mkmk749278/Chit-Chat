/**
 * MessageRelayService — design Backend Component B (Phase 1, Requirements 5.7, 8.2).
 *
 * Routes a 1:1 `CiphertextEnvelope` from an authenticated sender to the recipient's
 * connected node(s), over the existing Phase 0 Redis pub/sub backbone
 * (`presence:{uid}` registry + `node:{nodeId}` channels). Ciphertext-only: the body is
 * never decoded, inspected, or logged on any path (Requirement 8.2).
 *
 * `relay` (sender → recipient nodes):
 *   1. Validate the envelope's structural shape; a malformed frame is rejected with
 *      `malformed` and nothing is published.
 *   2. Bind the envelope to the authenticated connection: `envelope.senderUid` MUST
 *      equal `sender.uid`. A spoofed sender is rejected with `sender-mismatch` and
 *      nothing is published — this is the relay's security boundary (Requirements 5.7,
 *      8.2).
 *   3. Look up `presence:{recipientUid}` → `{connId -> nodeId}`; for each DISTINCT owning
 *      node, publish a {@link NodeRelayMessage} to `node:{nodeId}` via the dedicated
 *      Redis publisher. The owning node (subscribed to its own channel) then calls
 *      {@link deliverLocal}. An offline recipient (no presence entries) publishes to no
 *      node; the envelope is still accepted for delivery so the sender is ACKed (5.6) and
 *      the client's own 30 s timeout governs (5.11).
 *
 * `deliverLocal` (recipient node → local socket): wraps the envelope in a `deliver`
 * server→client frame and pushes it to every socket the recipient holds on this node.
 *
 * Gateway wiring (the `send`-frame handler, the ACK frame, and the `node:{nodeId}`
 * subscription callback that invokes {@link deliverLocal}) is task 4.7.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext, CiphertextEnvelope, ServerToClientFrame } from '@chat-app/types';
import type Redis from 'ioredis';

import { PresenceRegistryService, REDIS_PUBLISHER_CLIENT } from '../redis';
// Reuse the canonical `node:{nodeId}` channel-name helper rather than redefining the
// convention, so the relay's publish target can never drift from the channel the
// gateway subscribes to. Imported from the leaf util (not the module barrel) to avoid a
// module import cycle once the gateway depends on this service in task 4.7.
import { nodeChannel } from '../realtime/node-identity.util';
import {
  LOCAL_SOCKET_REGISTRY,
  type LocalSocketRegistry,
} from './local-socket-registry';
import type { NodeRelayMessage } from './node-relay-message';

/**
 * The outcome of a relay attempt. `received` means the envelope was accepted for
 * delivery and the gateway should ACK the sender (Requirement 5.6); `rejected` carries
 * the reason the envelope was refused and nothing was published.
 */
export type RelayOutcome =
  | { status: 'received'; nodes: number }
  | { status: 'rejected'; reason: 'sender-mismatch' | 'malformed' };

@Injectable()
export class MessageRelayService {
  constructor(
    @Inject(REDIS_PUBLISHER_CLIENT) private readonly publisher: Redis,
    private readonly presence: PresenceRegistryService,
    @Inject(LOCAL_SOCKET_REGISTRY) private readonly localSockets: LocalSocketRegistry,
  ) {}

  /**
   * Relays an envelope from `sender` to the recipient's connected node(s).
   *
   * @param sender   - the verified identity of the authenticated connection that sent
   *                   the frame; its `uid` is the trusted sender.
   * @param envelope - the ciphertext envelope to route (opaque body; never decoded).
   * @returns `{ status: 'received' }` when accepted for delivery; otherwise a rejection
   *   with `malformed` (bad shape) or `sender-mismatch` (spoofed sender).
   */
  async relay(sender: AuthContext, envelope: CiphertextEnvelope): Promise<RelayOutcome> {
    // 1. Structural validation first, so a clearly malformed frame is reported as such
    //    rather than as a mismatch. The ciphertext body is treated as opaque — its
    //    presence/type is checked but its contents are never decoded (Requirement 8.2).
    if (!isWellFormedEnvelope(envelope)) {
      return { status: 'rejected', reason: 'malformed' };
    }

    // 2. Security boundary: the wire-claimed sender must be the authenticated connection
    //    owner. Reject any spoofed sender without publishing anything (Requirements 5.7,
    //    8.2).
    if (envelope.senderUid !== sender.uid) {
      return { status: 'rejected', reason: 'sender-mismatch' };
    }

    // 3. Resolve the recipient's live connections → the distinct nodes that hold them,
    //    and fan a NodeRelayMessage out to each node's channel exactly once.
    const entries = await this.presence.lookup(envelope.recipientUid);
    const nodeIds = new Set<string>(Object.values(entries));

    if (nodeIds.size > 0) {
      const payload = JSON.stringify(toNodeRelayMessage(envelope));
      await Promise.all(
        [...nodeIds].map((nodeId) => this.publisher.publish(nodeChannel(nodeId), payload)),
      );
    }

    // Accepted for delivery (the recipient may be offline; the client's 30 s timeout
    // governs that case). The gateway ACKs the sender on this outcome (task 4.7, 5.6).
    // `nodes` = the number of distinct recipient nodes the envelope was published to
    // (0 ⇒ the recipient has no live presence entry).
    return { status: 'received', nodes: nodeIds.size };
  }

  /**
   * Delivers an already-routed envelope to the recipient's local socket(s) on this node.
   * Invoked by the `node:{nodeId}` subscription callback (task 4.7) once a
   * {@link NodeRelayMessage} arrives. Wraps the envelope in a `deliver` frame; a
   * recipient with no local socket is a silent no-op. The body is never decoded
   * (Requirement 8.2).
   *
   * @param targetUid - the recipient whose local socket(s) should receive the envelope.
   * @param envelope  - the opaque ciphertext envelope to deliver.
   */
  deliverLocal(targetUid: string, envelope: CiphertextEnvelope): void {
    const frame: ServerToClientFrame = { kind: 'deliver', envelope };
    for (const socket of this.localSockets.getLocalSockets(targetUid)) {
      socket.send(frame);
    }
  }
}

/** Builds the cross-node payload, copying only routing target + opaque envelope. */
function toNodeRelayMessage(envelope: CiphertextEnvelope): NodeRelayMessage {
  return { targetUid: envelope.recipientUid, envelope };
}

/**
 * Structural validator for an inbound envelope. Confirms every routing field is a
 * non-empty string, `seq` is a non-negative integer, the libsignal `type` is 1 or 3,
 * and `ciphertext` is a non-empty string. The ciphertext is checked for presence only —
 * it is NEVER base64-decoded, parsed, or logged (Requirement 8.2).
 */
function isWellFormedEnvelope(value: unknown): value is CiphertextEnvelope {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  return (
    isNonEmptyString(envelope.senderUid) &&
    isNonEmptyString(envelope.recipientUid) &&
    isNonEmptyString(envelope.senderDeviceId) &&
    typeof envelope.seq === 'number' &&
    Number.isInteger(envelope.seq) &&
    envelope.seq >= 0 &&
    (envelope.type === 1 || envelope.type === 3) &&
    isNonEmptyString(envelope.ciphertext)
  );
}

/** True when `value` is a string with at least one character. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
