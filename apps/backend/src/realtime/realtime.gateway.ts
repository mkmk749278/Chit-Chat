/**
 * RealtimeGateway — design Component 5 (Requirements 3.1, 3.4, 3.8, 8.5).
 *
 * The `ws`-based WebSocket gateway (`@nestjs/websockets` + the `@nestjs/platform-ws`
 * `WsAdapter`, wired in `main.ts`). It binds {@link WS_PORT} (3001) as a standalone
 * server, separate from the REST listener on :3000.
 *
 * Scope of this gateway covers the authenticated handshake (task 7.1) and the
 * connection registry + pub/sub backbone (task 7.2):
 *   1. Extract the Firebase ID token from the handshake — `Sec-WebSocket-Protocol`
 *      subprotocol preferred, `?token=` query param fallback
 *      ({@link extractHandshakeToken}).
 *   2. Verify it through the shared, Redis-cached {@link TokenVerificationService},
 *      so the cache and security semantics match the REST guard exactly.
 *   3. On a missing/invalid token ({@link UnauthorizedError}) close with code
 *      {@link WS_CLOSE_UNAUTHORIZED} (4401); when verification is unavailable or
 *      exceeds the 5-second budget ({@link FirebaseUnavailableError}) close with
 *      {@link WS_CLOSE_VERIFICATION_UNAVAILABLE} (4503). In BOTH failure cases the
 *      gateway creates NO connection-registry / `presence:{uid}` entry
 *      (Requirements 3.1, 3.8) — it simply returns after closing.
 *   4. On success, apply the {@link RateLimiterService} to the per-uid handshake
 *      surface (`ws-handshake:{uid}`) and close with {@link WS_CLOSE_RATE_LIMITED}
 *      (4429) when the limit is exceeded, again creating no registry entry
 *      (Requirement 5.2). Otherwise mint a unique `connId`, register
 *      `{uid, connId} -> nodeId` in `presence:{uid}` via {@link PresenceRegistryService}
 *      (marking the user online, Requirement 3.4), subscribe this node to its
 *      `node:{nodeId}` Redis pub/sub channel through the dedicated subscriber client so
 *      Phase 1 cross-node routing is a drop-in addition (Requirement 3.4), and store
 *      `connId`/`nodeId` on the socket for the disconnect cleanup (task 7.3).
 *
 * The gateway NEVER relays, forwards, delivers, or persists any chat-message payload —
 * Phase 0 has no message routing (Requirement 3.5). Task 7.3 adds the 25-second
 * heartbeat (ping/pong liveness; terminate a socket that misses a pong within one
 * interval, Requirements 3.2, 3.6) and the disconnect cleanup (drop the
 * `{uid, connId} -> nodeId` registry entry on close so the user goes offline once no
 * connection remains, Requirements 3.3, 3.7).
 *
 * The raw token is only ever passed to {@link TokenVerificationService}; it is never
 * logged or attached to the socket (Requirement 13.2).
 */

import { Inject, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import type {
  AuthContext,
  CiphertextEnvelope,
  ClientToServerFrame,
  ServerToClientFrame,
} from '@chat-app/types';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type Redis from 'ioredis';
import type { RawData, WebSocket } from 'ws';

import { FirebaseUnavailableError, TokenVerificationService, UnauthorizedError } from '../auth';
import {
  LOCAL_SOCKET_REGISTRY,
  type LocalRecipientSocket,
  type LocalSocketRegistry,
  MessageRelayService,
  type NodeChannelMessage,
  OfflineQueueService,
} from '../messaging';
import {
  PresenceRegistryService,
  RateLimiterService,
  REDIS_SUBSCRIBER_CLIENT,
} from '../redis';
import { extractHandshakeToken } from './handshake-token.util';
import { nodeChannel, resolveNodeId } from './node-identity.util';
import {
  WS_CLOSE_RATE_LIMITED,
  WS_CLOSE_UNAUTHORIZED,
  WS_CLOSE_VERIFICATION_UNAVAILABLE,
  WS_HANDSHAKE_RATE_LIMIT,
  WS_HANDSHAKE_RATE_LIMIT_SCOPE,
  WS_HANDSHAKE_RATE_WINDOW_SECONDS,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_PORT,
} from './realtime.constants';

/**
 * A `ws` socket once its handshake has authenticated: the verified identity is
 * attached so tasks 7.2 (registry/pub-sub) and 7.3 (heartbeat) can read it without
 * re-verifying. Absent until {@link RealtimeGateway.handleConnection} succeeds.
 */
export interface AuthenticatedSocket extends WebSocket {
  /** Verified Firebase identity for the connection; set on a successful handshake. */
  authContext?: AuthContext;
  /**
   * The unique connection id minted for this socket on a successful handshake and
   * registered in `presence:{uid}` as `{connId -> nodeId}`. Stored here so the
   * disconnect cleanup (task 7.3) can remove the exact registry entry.
   */
  connId?: string;
  /**
   * The backend node holding this socket. Stored alongside {@link connId} so the
   * disconnect cleanup (task 7.3) knows which `{uid, connId} -> nodeId` entry to drop.
   */
  nodeId?: string;
  /**
   * Heartbeat liveness flag (task 7.3, Requirements 3.2, 3.6). Set `true` on a
   * successful handshake and reset to `true` on every `pong`. Each heartbeat tick
   * flips it to `false` just before pinging; a socket still `false` at the next tick
   * failed to answer the previous ping and is terminated. Only meaningful while the
   * socket is registered.
   */
  isAlive?: boolean;
  /**
   * The {@link LocalRecipientSocket} adapter registered for this socket in the
   * node-local {@link LocalSocketRegistry} on a successful handshake (task 4.7). It
   * wraps the raw `ws` socket so {@link MessageRelayService.deliverLocal} can push a
   * `deliver` frame without knowing about `ws`. Stored here so the exact same adapter
   * reference is removed from the registry on disconnect.
   */
  localRecipientSocket?: LocalRecipientSocket;
}

@WebSocketGateway(WS_PORT)
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);

  /**
   * The live set of authenticated, registered connections on this node. A socket is
   * added on a successful handshake and removed on disconnect, so the heartbeat loop
   * only ever pings connections that hold a `presence:{uid}` entry (Requirement 3.6).
   */
  private readonly connections = new Set<AuthenticatedSocket>();

  /**
   * Handle for the 25-second heartbeat interval started in {@link afterInit} and
   * cleared in {@link onModuleDestroy}. `undefined` until the gateway is initialised.
   */
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  /**
   * The stable identifier for this backend node, resolved once at construction. Used
   * as the `nodeId` in every registry entry and as the `node:{nodeId}` pub/sub channel
   * this node subscribes to.
   */
  private readonly nodeId = resolveNodeId();

  /**
   * Tracks the one-time `node:{nodeId}` subscription. The node subscribes to its
   * channel on the first successful handshake and reuses that single subscription for
   * every later connection (the channel is per-node, not per-connection). A failed
   * attempt is reset to `undefined` so a subsequent handshake can retry.
   */
  private nodeSubscription?: Promise<void>;

  constructor(
    private readonly tokenVerification: TokenVerificationService,
    private readonly presenceRegistry: PresenceRegistryService,
    private readonly rateLimiter: RateLimiterService,
    @Inject(REDIS_SUBSCRIBER_CLIENT) private readonly subscriber: Redis,
    private readonly relay: MessageRelayService,
    @Inject(LOCAL_SOCKET_REGISTRY) private readonly localSockets: LocalSocketRegistry,
    private readonly offlineQueue: OfflineQueueService,
  ) {}

  /**
   * Authenticates a new WebSocket handshake and, on success, registers the connection
   * in the Redis presence registry and wires the node's pub/sub backbone. Resolves once
   * the socket is either fully established or closed with the appropriate code; it never
   * throws, so a single bad handshake cannot destabilise the gateway.
   *
   * @param socket  - the freshly upgraded `ws` socket.
   * @param request - the HTTP upgrade request carrying the handshake token.
   */
  async handleConnection(socket: AuthenticatedSocket, request: IncomingMessage): Promise<void> {
    // 1. Pull the token from the subprotocol (preferred) or query param. A handshake
    //    with no token is unauthenticated → 4401, with no registry/presence entry.
    const token = extractHandshakeToken(request);
    if (token === null) {
      this.closeUnauthorized(socket);
      return;
    }

    // 2. Verify via the shared cached path (5 s Firebase budget enforced there).
    let authContext: AuthContext;
    try {
      authContext = await this.tokenVerification.verify(token);
    } catch (err) {
      this.closeForVerificationError(socket, err);
      return;
    }

    const { uid } = authContext;

    // 3. Rate-limit the handshake surface per uid BEFORE the protected work (registry
    //    write + subscription) executes (Requirement 5.2). A rejected hit closes the
    //    socket with 4429 and creates no registry/`presence` entry. A limiter failure
    //    (Redis unavailable) must not wedge the gateway, so it fails open and proceeds.
    let allowed = true;
    try {
      const result = await this.rateLimiter.hit(
        `${WS_HANDSHAKE_RATE_LIMIT_SCOPE}:${uid}`,
        WS_HANDSHAKE_RATE_LIMIT,
        WS_HANDSHAKE_RATE_WINDOW_SECONDS,
      );
      allowed = result.allowed;
    } catch {
      this.logger.warn('WebSocket handshake rate-limit check failed; allowing handshake');
    }
    if (!allowed) {
      this.closeRateLimited(socket);
      return;
    }

    // 4. Authenticated and within limits. Mint a unique connId, register
    //    `{uid, connId} -> nodeId` in `presence:{uid}` (which marks the user online),
    //    and ensure this node is subscribed to its `node:{nodeId}` pub/sub channel so
    //    Phase 1 cross-node routing works without changes (Requirement 3.4).
    const connId = randomUUID();
    socket.authContext = authContext;
    socket.connId = connId;
    socket.nodeId = this.nodeId;

    await this.presenceRegistry.add(uid, connId, this.nodeId);
    await this.ensureNodeSubscribed();

    // 5. Enrol the socket in the heartbeat loop (task 7.3, Requirements 3.2, 3.6).
    //    A freshly established socket is alive; each `pong` resets the flag so the next
    //    tick spares it. Track it so the heartbeat pings it and disconnect deregisters
    //    it. The listener is removed automatically when the socket is GC'd after close.
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    this.connections.add(socket);

    // 6. Register the socket in the node-local registry so the relay can deliver inbound
    //    envelopes to it (task 4.7, Requirement 5.x). The raw `ws` socket is adapted onto
    //    the transport-agnostic `LocalRecipientSocket` surface by JSON-serializing each
    //    server→client frame; the adapter reference is stored on the socket so disconnect
    //    removes the exact same entry. The ciphertext body is never decoded here (8.2).
    const recipientSocket: LocalRecipientSocket = {
      send: (frame: ServerToClientFrame): void => {
        socket.send(JSON.stringify(frame));
      },
    };
    socket.localRecipientSocket = recipientSocket;
    this.localSockets.register(uid, recipientSocket);

    // 7. Handle inbound `send` frames from this authenticated connection. The frame is
    //    parsed and relayed via MessageRelayService; on accepted delivery the sender is
    //    ACKed (Requirement 5.6). The ciphertext is treated as opaque and never logged
    //    (Requirements 5.7, 8.2). A separate raw listener (mirroring the `pong` listener)
    //    is used because the wire frames key off `kind`, not the WsAdapter's event field.
    socket.on('message', (data: RawData) => {
      void this.handleInboundMessage(socket, data);
    });

    // 8. Store-and-forward: deliver any envelopes queued while this user was offline,
    //    in arrival order, to the socket that just connected. Done AFTER the local socket
    //    is registered so a concurrently-relayed live message also has a delivery target.
    void this.flushOfflineQueue(uid, recipientSocket);
  }

  /**
   * Drains the recipient's offline queue and pushes each queued envelope to the
   * freshly-connected socket as a `deliver` frame, in FIFO order (Requirement 8.2: the
   * body is never decoded). The drain is atomic, so two connections racing cannot deliver
   * the same envelope twice. A drain failure (transient Redis issue) is logged and
   * swallowed — it must not break an otherwise-valid connection; the messages remain
   * queued (or expire) for the next connect.
   */
  private async flushOfflineQueue(uid: string, socket: LocalRecipientSocket): Promise<void> {
    let queued: CiphertextEnvelope[];
    try {
      queued = await this.offlineQueue.drain(uid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to drain offline queue on connect: ${message}`);
      return;
    }
    for (const envelope of queued) {
      socket.send({ kind: 'deliver', envelope });
    }
  }

  /**
   * Starts the 25-second heartbeat once the gateway's WebSocket server is initialised
   * (Requirements 3.2, 3.6; design §"WebSocket heartbeat liveness"). NestJS invokes
   * this with the underlying `ws` server, but the loop drives off the gateway's own
   * {@link connections} set, so the argument is unused. Idempotent: a second init does
   * not stack timers.
   */
  afterInit(): void {
    if (this.heartbeatTimer !== undefined) {
      return;
    }
    // Wire the cross-node delivery callback: every message published to this node's
    // `node:{nodeId}` channel (by some node's MessageRelayService.relay) is parsed into a
    // NodeRelayMessage and handed to deliverLocal so the recipient's local socket(s)
    // receive a `deliver` frame (task 4.7, Requirement 5.x). The listener filters on this
    // node's channel and never decodes/logs the ciphertext body (Requirement 8.2). It is
    // attached once, alongside the heartbeat, guarded by the same idempotency check.
    this.subscriber.on('message', (channel: string, message: string) => {
      this.handleNodeMessage(channel, message);
    });
    this.heartbeatTimer = setInterval(() => {
      this.runHeartbeat();
    }, WS_HEARTBEAT_INTERVAL_MS);
    // Do not keep the Node process alive solely for the heartbeat.
    this.heartbeatTimer.unref?.();
  }

  /**
   * Stops the heartbeat on shutdown so the interval does not outlive the gateway.
   */
  onModuleDestroy(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * One heartbeat tick (Requirements 3.2, 3.6). For every registered connection:
   *   - a socket still flagged not-alive failed to answer the previous tick's ping with
   *     a `pong`, so it is deregistered and terminated (the missed pong is thus acted on
   *     within one interval, and the close drives registry cleanup inside the 5-second
   *     window, Requirement 3.3);
   *   - otherwise the socket is flagged not-alive and pinged, and its `pong` handler
   *     will flip it back to alive before the next tick.
   *
   * Loop invariant: after the tick, every retained socket has been pinged exactly once
   * and any socket that missed the prior pong has been terminated.
   */
  private runHeartbeat(): void {
    for (const socket of this.connections) {
      if (socket.isAlive === false) {
        // Deregister first so the socket is not pinged again, then force the close.
        // `terminate()` also emits 'close' → handleDisconnect, which is idempotent.
        void this.handleDisconnect(socket);
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }

  /**
   * Cleans up a closed connection, whether it closed cleanly or was terminated by a
   * missed heartbeat (Requirements 3.3, 3.7). Removes the socket from the heartbeat set
   * and drops its `{uid, connId} -> nodeId` entry from `presence:{uid}`; because the
   * registry is a hash keyed by `connId`, removing the last connection empties the hash
   * so Redis deletes the key, marking the user offline (Requirement 3.3).
   *
   * Idempotent and tolerant of unauthenticated sockets (which never registered): a
   * socket with no `connId`/identity is simply ignored, and a second call after the
   * entry is already gone is a no-op via `HDEL`.
   *
   * @param socket - the closed (or terminated) socket.
   */
  async handleDisconnect(socket: AuthenticatedSocket): Promise<void> {
    this.connections.delete(socket);

    const uid = socket.authContext?.uid;
    const { connId } = socket;
    if (uid === undefined || connId === undefined) {
      // Handshake never completed registration (e.g. closed 4401/4429); nothing to drop.
      return;
    }

    // Remove this socket from the node-local registry so the relay stops delivering to a
    // dead connection (task 4.7). Idempotent: a second call after removal is a no-op.
    if (socket.localRecipientSocket !== undefined) {
      this.localSockets.unregister(uid, socket.localRecipientSocket);
      socket.localRecipientSocket = undefined;
    }

    try {
      await this.presenceRegistry.remove(uid, connId);
      // Record a coarse last-seen for opted-in presence (Req 5.2). Stored TTL-bounded in Redis
      // and only ever exposed to peers when the user has opted in (gated in PresenceService), so
      // recording it unconditionally here leaks nothing.
      await this.presenceRegistry.recordLastSeen(uid, Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to remove presence entry on disconnect: ${message}`);
    }
  }

  /**
   * Handles an inbound wire frame from an authenticated connection (task 4.7,
   * Requirements 5.6, 5.7, 8.2). Only `{ kind: 'send' }` frames are acted on:
   *   1. The raw frame is JSON-parsed; a non-JSON or non-`send` frame is ignored (no
   *      ACK), since this slice defines only the `send` client→server frame.
   *   2. The envelope is relayed via {@link MessageRelayService.relay}, which binds the
   *      wire-claimed `senderUid` to this connection's authenticated uid (rejecting a
   *      spoofed sender) and fans the envelope out to the recipient's node(s).
   *   3. On `{ status: 'received' }` an `ack` frame is sent back to THIS sender so its
   *      message transitions sending → sent (5.6). A rejection is neither ACKed nor
   *      surfaced — the sender's own 30 s timeout governs (5.11).
   *
   * The ciphertext body is never decoded or logged on any path (Requirements 5.7, 8.2):
   * a parse failure is dropped silently without echoing the payload.
   *
   * @param socket - the authenticated sender socket the frame arrived on.
   * @param data   - the raw `ws` message payload (text or binary).
   */
  private async handleInboundMessage(socket: AuthenticatedSocket, data: RawData): Promise<void> {
    const auth = socket.authContext;
    if (auth === undefined) {
      // Unauthenticated socket (handshake not completed); never relay on its behalf.
      return;
    }

    let frame: ClientToServerFrame;
    try {
      const text = typeof data === 'string' ? data : data.toString();
      frame = JSON.parse(text) as ClientToServerFrame;
    } catch {
      // Malformed (non-JSON) frame — drop without logging the payload (Requirement 8.2).
      return;
    }

    if (frame === null || typeof frame !== 'object') {
      return;
    }

    // Ephemeral typing hint (Req 5.3): relayed to the recipient's node(s), never persisted and
    // never ACKed. Bound to the authenticated sender by the relay so it can't be spoofed.
    if (frame.kind === 'typing') {
      await this.relay.relayTyping(auth, frame.recipientUid);
      return;
    }

    if (frame.kind !== 'send') {
      // Not a recognised client→server frame for this slice; ignore (no ACK).
      return;
    }

    const envelope: CiphertextEnvelope = frame.envelope;
    const outcome = await this.relay.relay(auth, envelope);
    if (outcome.status !== 'received') {
      // Rejected (sender-mismatch / malformed): do not ACK. The relay published nothing
      // and never decoded the body; the sender's 30 s timeout governs (5.11).
      return;
    }

    // Accepted for delivery — ACK the sender so its message shows `sent` (5.6).
    const ack: ServerToClientFrame = {
      kind: 'ack',
      recipientUid: envelope.recipientUid,
      seq: envelope.seq,
      status: 'received',
      nodes: outcome.nodes,
    };
    socket.send(JSON.stringify(ack));
  }

  /**
   * Cross-node delivery callback for the `node:{nodeId}` Redis channel (task 4.7,
   * Requirement 5.x). A {@link MessageRelayService.relay} on any node publishes a
   * {@link NodeRelayMessage} to the channel of the node holding the recipient's socket;
   * the owning node (subscribed to its own channel) parses it here and calls
   * {@link MessageRelayService.deliverLocal} to push a `deliver` frame to the recipient's
   * local socket(s).
   *
   * The single subscriber connection is shared, so this filters strictly on this node's
   * own channel and ignores everything else. A malformed payload is dropped without
   * echoing it, and the ciphertext body is never decoded or logged (Requirement 8.2).
   *
   * @param channel - the channel the message was published on.
   * @param message - the JSON-encoded {@link NodeRelayMessage} payload.
   */
  private handleNodeMessage(channel: string, message: string): void {
    if (channel !== nodeChannel(this.nodeId)) {
      // A message for some other channel on the shared subscriber connection.
      return;
    }

    let relayMessage: NodeChannelMessage;
    try {
      relayMessage = JSON.parse(message) as NodeChannelMessage;
    } catch {
      this.logger.warn('Discarded a malformed node relay message');
      return;
    }

    if (relayMessage === null || typeof relayMessage !== 'object' || typeof relayMessage.targetUid !== 'string') {
      this.logger.warn('Discarded a structurally invalid node relay message');
      return;
    }

    // Ephemeral typing hint (Req 5.3): deliver a `typing` frame to the recipient's local
    // socket(s). Tagged with `kind: 'typing'`; envelope payloads stay untagged (back-compat).
    if ('kind' in relayMessage) {
      if (
        relayMessage.kind === 'typing' &&
        typeof relayMessage.fromUid === 'string' &&
        relayMessage.fromUid.length > 0
      ) {
        this.relay.deliverTypingLocal(relayMessage.targetUid, relayMessage.fromUid);
      }
      return;
    }

    if (relayMessage.envelope === undefined || relayMessage.envelope === null) {
      this.logger.warn('Discarded a structurally invalid node relay message');
      return;
    }

    // Deliver to the recipient's local socket(s); the relay treats the body as opaque.
    this.relay.deliverLocal(relayMessage.targetUid, relayMessage.envelope);
  }

  /**
   * Subscription failures are logged (not thrown) so a transient Redis issue cannot
   * fail an otherwise-valid handshake; the attempt is reset so a later handshake retries.
   *
   * No message listener is attached: Phase 0 relays no chat payload (Requirement 3.5).
   */
  private async ensureNodeSubscribed(): Promise<void> {
    if (this.nodeSubscription === undefined) {
      const channel = nodeChannel(this.nodeId);
      this.nodeSubscription = this.subscriber
        .subscribe(channel)
        .then(() => undefined)
        .catch((err: unknown) => {
          // Reset so a subsequent handshake can retry the subscription.
          this.nodeSubscription = undefined;
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to subscribe to ${channel}: ${message}`);
        });
    }
    await this.nodeSubscription;
  }

  /**
   * Closes a socket with 4401 (unauthenticated). No registry/`presence` entry is
   * created on this path (Requirement 3.1).
   */
  private closeUnauthorized(socket: WebSocket): void {
    socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
  }

  /**
   * Closes a socket with 4429 (rate limited). The handshake authenticated but the
   * per-uid handshake surface exceeded its window limit, so no registry/`presence`
   * entry is created on this path (Requirements 5.2, 5.4).
   */
  private closeRateLimited(socket: WebSocket): void {
    socket.close(WS_CLOSE_RATE_LIMITED, 'rate limited');
  }

  /**
   * Maps a verification failure onto the correct close code without leaking SDK
   * internals, creating no registry/`presence` entry on any path:
   *   - {@link FirebaseUnavailableError} → 4503 (dependency unavailable / >5 s,
   *     Requirements 3.8, 8.5).
   *   - {@link UnauthorizedError} (or any unexpected error) → 4401 (fail closed so an
   *     unverified socket is never left open, Requirement 3.1).
   */
  private closeForVerificationError(socket: WebSocket, err: unknown): void {
    if (err instanceof FirebaseUnavailableError) {
      this.logger.warn('WebSocket handshake rejected: token verification unavailable');
      socket.close(WS_CLOSE_VERIFICATION_UNAVAILABLE, 'verification unavailable');
      return;
    }

    if (!(err instanceof UnauthorizedError)) {
      // Unexpected failure — fail closed and treat as unauthenticated.
      this.logger.warn('WebSocket handshake rejected: unexpected verification error');
    }
    this.closeUnauthorized(socket);
  }
}
