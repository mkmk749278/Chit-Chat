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
 *      `malformed` and nothing is stored or published.
 *   2. Bind the envelope to the authenticated connection: `envelope.senderUid` MUST
 *      equal `sender.uid`. A spoofed sender is rejected with `sender-mismatch` and
 *      nothing is stored or published — this is the relay's security boundary
 *      (Requirements 5.7, 8.2).
 *   3. Durably append the envelope to the recipient's inbox ({@link InboxService}) under a
 *      server-assigned id. This happens BEFORE any live fan-out, so the sender is only ACKed
 *      for a message the server can still deliver after a dead socket, a crash, or a redeploy
 *      (reliable delivery, protocol v2). If the append fails the relay throws and the gateway
 *      does not ACK, so the sender's retry path governs.
 *   4. Look up the recipient's LIVE connections (`presence:{uid}` filtered by node liveness)
 *      and publish a {@link NodeRelayMessage} once per distinct owning node. The owning node
 *      calls {@link deliverLocal}.
 *   5. When no node actually received the publish (recipient offline, or every presence entry
 *      was stale), wake the recipient's devices with a content-free push. The envelope is
 *      already in the inbox and is replayed when they connect.
 *
 * `deliverLocal` (recipient node → local socket): wraps the envelope in a `deliver`
 * server→client frame and pushes it to every socket the recipient holds on this node.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthContext, CiphertextEnvelope, ServerToClientFrame } from '@chat-app/types';
import type Redis from 'ioredis';

import { PresenceRegistryService, REDIS_PUBLISHER_CLIENT } from '../redis';
// Reuse the canonical `node:{nodeId}` channel-name helper rather than redefining the
// convention, so the relay's publish target can never drift from the channel the
// gateway subscribes to. Imported from the leaf util (not the module barrel) to avoid a
// module import cycle once the gateway depends on this service in task 4.7.
import { nodeChannel } from '../realtime/node-identity.util';
import { InboxService } from './inbox.service';
import {
  LOCAL_SOCKET_REGISTRY,
  type LocalSocketRegistry,
} from './local-socket-registry';
import type { NodeRelayMessage, NodeTypingMessage } from './node-relay-message';
import { PushNotificationService } from './push-notification.service';

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
  private readonly logger = new Logger(MessageRelayService.name);

  constructor(
    @Inject(REDIS_PUBLISHER_CLIENT) private readonly publisher: Redis,
    private readonly presence: PresenceRegistryService,
    @Inject(LOCAL_SOCKET_REGISTRY) private readonly localSockets: LocalSocketRegistry,
    private readonly inbox: InboxService,
    private readonly pushNotifications: PushNotificationService,
  ) {}

  /**
   * Relays an envelope from `sender` to the recipient's connected node(s).
   *
   * @param sender   - the verified identity of the authenticated connection that sent
   *                   the frame; its `uid` is the trusted sender.
   * @param envelope - the ciphertext envelope to route (opaque body; never decoded).
   * @returns `{ status: 'received' }` when accepted for delivery; otherwise a rejection
   *   with `malformed` (bad shape) or `sender-mismatch` (spoofed sender).
   * @throws when the envelope could not be stored — the gateway must not ACK in that case.
   */
  async relay(sender: AuthContext, envelope: CiphertextEnvelope): Promise<RelayOutcome> {
    // 1. Structural validation first, so a clearly malformed frame is reported as such
    //    rather than as a mismatch. The ciphertext body is treated as opaque — its
    //    presence/type is checked but its contents are never decoded (Requirement 8.2).
    if (!isWellFormedEnvelope(envelope)) {
      return { status: 'rejected', reason: 'malformed' };
    }
    // 2. Security boundary: the wire-claimed sender must be the authenticated connection
    //    owner. Reject any spoofed sender without storing or publishing anything
    //    (Requirements 5.7, 8.2).
    if (envelope.senderUid !== sender.uid) {
      return { status: 'rejected', reason: 'sender-mismatch' };
    }
    // Copy only the known routing + body fields, so nothing a client smuggles onto the
    // envelope object is stored or forwarded to the recipient.
    const sanitized = sanitizeEnvelope(envelope);

    // 3. Durable first: the inbox entry is what guarantees delivery; live fan-out is an
    //    optimisation on top of it.
    const id = await this.inbox.append(sanitized.recipientUid, sanitized);

    // 4. Fan out to the recipient's live node(s). A publish failure is not fatal — the entry
    //    is already stored and will be replayed on the recipient's next connect.
    let deliveredNodes = 0;
    try {
      const entries = await this.presence.lookupLive(sanitized.recipientUid);
      const nodeIds = [...new Set<string>(Object.values(entries))];
      if (nodeIds.length > 0) {
        const message: NodeRelayMessage = { targetUid: sanitized.recipientUid, envelope: sanitized, id };
        const payload = JSON.stringify(message);
        const receivers = await Promise.all(
          nodeIds.map((nodeId) => this.publisher.publish(nodeChannel(nodeId), payload)),
        );
        // PUBLISH returns how many subscribers received it; 0 means that node is gone.
        deliveredNodes = receivers.filter((count) => count > 0).length;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Live fan-out failed; envelope stays in the inbox: ${message}`);
    }

    // 5. Nobody live received it: wake the recipient's devices (content-free, best-effort).
    if (deliveredNodes === 0) {
      void this.pushNotifications.notify(sanitized.recipientUid);
    }

    // Accepted: stored for delivery (and delivered live when a node received it). `nodes` is
    // diagnostic — 0 ⇒ the recipient had no live connection and will get it on reconnect.
    return { status: 'received', nodes: deliveredNodes };
  }

  /**
   * Relays an ephemeral typing hint from `sender` to the recipient's connected node(s)
   * (Req 5.3). Unlike {@link relay} this carries no content, is bound to the authenticated
   * sender, and is NEVER persisted/queued: an offline recipient (no presence entries) is a
   * silent no-op — a stale "typing…" must never be delivered later. Best-effort by design.
   *
   * @param sender       - the verified identity of the connection that sent the hint.
   * @param recipientUid - the peer to notify that `sender` is typing.
   */
  async relayTyping(sender: AuthContext, recipientUid: string): Promise<void> {
    if (typeof recipientUid !== 'string' || recipientUid.length === 0 || recipientUid.length > 128) {
      return;
    }
    const entries = await this.presence.lookupLive(recipientUid);
    const nodeIds = new Set<string>(Object.values(entries));
    if (nodeIds.size === 0) {
      return;
    }
    const payload: NodeTypingMessage = { kind: 'typing', targetUid: recipientUid, fromUid: sender.uid };
    const json = JSON.stringify(payload);
    await Promise.all([...nodeIds].map((nodeId) => this.publisher.publish(nodeChannel(nodeId), json)));
  }

  /**
   * Delivers an ephemeral typing hint to the recipient's local socket(s) on this node (Req 5.3),
   * invoked by the `node:{nodeId}` subscription when a {@link NodeTypingMessage} arrives. A
   * recipient with no local socket is a silent no-op.
   */
  deliverTypingLocal(targetUid: string, fromUid: string): void {
    const frame: ServerToClientFrame = { kind: 'typing', fromUid };
    for (const socket of this.localSockets.getLocalSockets(targetUid)) {
      socket.send(frame);
    }
  }

  /**
   * Delivers an already-routed envelope to the recipient's local socket(s) on this node.
   * Invoked by the `node:{nodeId}` subscription callback (task 4.7) once a
   * {@link NodeRelayMessage} arrives. Wraps the envelope in a `deliver` frame (carrying the
   * inbox `id` for acknowledgement); the body is never decoded (Requirement 8.2).
   *
   * A legacy (protocol v1) socket never acknowledges, so once the envelope has been pushed to one
   * the inbox entry is dropped here — otherwise it would be replayed (and fail to decrypt) on every
   * reconnect of that old app build.
   *
   * @param targetUid - the recipient whose local socket(s) should receive the envelope.
   * @param envelope  - the opaque ciphertext envelope to deliver.
   * @param id        - the recipient inbox entry id (absent for messages from an older backend).
   * @returns how many local sockets the frame was written to (0 ⇒ none on this node).
   */
  deliverLocal(targetUid: string, envelope: CiphertextEnvelope, id?: string): number {
    const frame: ServerToClientFrame =
      id !== undefined ? { kind: 'deliver', envelope, id } : { kind: 'deliver', envelope };
    const sockets = this.localSockets.getLocalSockets(targetUid);
    let deliveredToLegacy = false;
    for (const socket of sockets) {
      socket.send(frame);
      if ((socket.protocol ?? 1) < 2) {
        deliveredToLegacy = true;
      }
    }
    if (deliveredToLegacy && id !== undefined) {
      this.inbox.ack(targetUid, [id]).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to drop a legacy-delivered inbox entry: ${message}`);
      });
    }
    return sockets.length;
  }
}

/** Copies exactly the wire fields of a validated envelope (no extra client-supplied keys). */
function sanitizeEnvelope(envelope: CiphertextEnvelope): CiphertextEnvelope {
  return {
    senderUid: envelope.senderUid,
    recipientUid: envelope.recipientUid,
    senderDeviceId: envelope.senderDeviceId,
    seq: envelope.seq,
    type: envelope.type,
    ciphertext: envelope.ciphertext,
  };
}

/** Upper bound on any routing identifier (Firebase UIDs are ≤128 chars; device ids are UUIDs). */
const MAX_ROUTING_FIELD_LENGTH = 128;

/**
 * Structural validator for an inbound envelope. Confirms every routing field is a
 * non-empty, bounded string, `seq` is a non-negative safe integer, the libsignal `type` is 1 or 3,
 * and `ciphertext` is a non-empty string. The ciphertext is checked for presence only —
 * it is NEVER base64-decoded, parsed, or logged (Requirement 8.2). Its size is bounded by the
 * gateway's frame `maxPayload`.
 */
function isWellFormedEnvelope(value: unknown): value is CiphertextEnvelope {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  return (
    isRoutingString(envelope.senderUid) &&
    isRoutingString(envelope.recipientUid) &&
    isRoutingString(envelope.senderDeviceId) &&
    typeof envelope.seq === 'number' &&
    Number.isSafeInteger(envelope.seq) &&
    envelope.seq >= 0 &&
    (envelope.type === 1 || envelope.type === 3) &&
    typeof envelope.ciphertext === 'string' &&
    envelope.ciphertext.length > 0
  );
}

/** True when `value` is a non-empty string no longer than {@link MAX_ROUTING_FIELD_LENGTH}. */
function isRoutingString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ROUTING_FIELD_LENGTH;
}
