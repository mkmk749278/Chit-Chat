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
 * Reliable delivery (realtime protocol v2): a client that connects with `?v=2` is sent a
 * `hello` frame, then a replay of its whole server-side inbox ({@link InboxService}); every
 * `deliver` carries the inbox entry `id`, and the entry is only dropped when the client confirms
 * it with a `delivered` frame. A client without the flag (an older app build) keeps the legacy
 * at-most-once semantics. v2 clients may also send an application-level `ping`, answered with
 * `pong`, to detect a zombie socket.
 *
 * Node liveness: every heartbeat tick refreshes this node's `node-alive:{nodeId}` marker and
 * re-asserts the presence entries of the sockets it holds, so routing ignores entries left behind
 * by a crashed or redeployed node. On graceful shutdown the node drops its entries and marker and
 * closes every socket with 1012 so clients reconnect to the replacement at once.
 *
 * The raw token is only ever passed to {@link TokenVerificationService}; it is never
 * logged or attached to the socket (Requirement 13.2).
 */

import { Inject, Logger, type BeforeApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import {
  REALTIME_PROTOCOL_QUERY_PARAM,
  REALTIME_PROTOCOL_VERSION,
  type AuthContext,
  type CiphertextEnvelope,
  type ClientToServerFrame,
  type ServerToClientFrame,
} from '@chat-app/types';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type Redis from 'ioredis';
import { WebSocket, type RawData } from 'ws';

import { FirebaseUnavailableError, TokenVerificationService, UnauthorizedError } from '../auth';
import {
  InboxService,
  type InboxEntry,
  LOCAL_SOCKET_REGISTRY,
  type LocalRecipientSocket,
  type LocalSocketRegistry,
  MessageRelayService,
  type NodeChannelMessage,
  PushNotificationService,
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
  WS_CLOSE_SERVICE_RESTART,
  WS_CLOSE_UNAUTHORIZED,
  WS_CLOSE_VERIFICATION_UNAVAILABLE,
  WS_FRAME_RATE_WINDOW_SECONDS,
  WS_HANDSHAKE_RATE_LIMIT,
  WS_HANDSHAKE_RATE_LIMIT_SCOPE,
  WS_HANDSHAKE_RATE_WINDOW_SECONDS,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_MAX_PAYLOAD_BYTES,
  WS_PORT,
  WS_SEND_RATE_LIMIT,
  WS_SEND_RATE_LIMIT_SCOPE,
  WS_TYPING_RATE_LIMIT,
  WS_TYPING_RATE_LIMIT_SCOPE,
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
  /** Realtime protocol version negotiated on the handshake URL (1 = legacy, 2 = acked delivery). */
  realtimeProtocol?: number;
}

@WebSocketGateway(WS_PORT, { maxPayload: WS_MAX_PAYLOAD_BYTES })
export class RealtimeGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    OnModuleDestroy,
    BeforeApplicationShutdown
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

  /**
   * The first `node-alive:{nodeId}` write, started in {@link afterInit}. Handshakes await it so
   * no presence entry is written before this node is visible as alive (an entry of a node without
   * a marker is treated as stale by routing). Never rejects.
   */
  private nodeAlive: Promise<void> = Promise.resolve();

  /** Set once graceful shutdown starts; new handshakes are then refused. */
  private shuttingDown = false;

  constructor(
    private readonly tokenVerification: TokenVerificationService,
    private readonly presenceRegistry: PresenceRegistryService,
    private readonly rateLimiter: RateLimiterService,
    @Inject(REDIS_SUBSCRIBER_CLIENT) private readonly subscriber: Redis,
    private readonly relay: MessageRelayService,
    @Inject(LOCAL_SOCKET_REGISTRY) private readonly localSockets: LocalSocketRegistry,
    private readonly inbox: InboxService,
    private readonly pushNotifications: PushNotificationService,
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
    // 0. The client sees the socket as open as soon as the HTTP upgrade completes — before the
    //    token is verified below — and flushes any sends it queued while offline right away.
    //    `ws` drops frames that arrive while no `message` listener is attached, so buffer them
    //    (bounded) from this synchronous first step and replay them once the connection is
    //    registered; they are discarded if the handshake is rejected.
    const early = this.bufferEarlyFrames(socket);

    // 1. Pull the token from the subprotocol (preferred) or query param. A handshake
    //    with no token is unauthenticated → 4401, with no registry/presence entry.
    const token = extractHandshakeToken(request);
    if (token === null) {
      early.discard();
      this.closeUnauthorized(socket);
      return;
    }

    // 2. Verify via the shared cached path (5 s Firebase budget enforced there).
    let authContext: AuthContext;
    try {
      authContext = await this.tokenVerification.verify(token);
    } catch (err) {
      early.discard();
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
      early.discard();
      this.closeRateLimited(socket);
      return;
    }

    // The client may have hung up (or shutdown may have begun) while we awaited verification
    // and the limiter. Registering a closed socket would mark the user online with no socket to
    // deliver to, so stop here.
    if (this.shuttingDown || socket.readyState !== WebSocket.OPEN) {
      early.discard();
      if (this.shuttingDown && socket.readyState === WebSocket.OPEN) {
        socket.close(WS_CLOSE_SERVICE_RESTART, 'service restart');
      }
      return;
    }

    // 4. Authenticated and within limits. Mint a unique connId, register
    //    `{uid, connId} -> nodeId` in `presence:{uid}` (which marks the user online),
    //    and ensure this node is subscribed to its `node:{nodeId}` pub/sub channel so
    //    Phase 1 cross-node routing works without changes (Requirement 3.4).
    const connId = randomUUID();

    try {
      await this.nodeAlive;
      await this.presenceRegistry.add(uid, connId, this.nodeId);
      await this.ensureNodeSubscribed();
    } catch (err) {
      // Without a registry entry the relay cannot route to this socket; fail the handshake with a
      // retryable code instead of leaving a half-registered connection (and an unhandled rejection).
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`WebSocket handshake failed to register presence: ${message}`);
      early.discard();
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(WS_CLOSE_VERIFICATION_UNAVAILABLE, 'registry unavailable');
      }
      return;
    }

    if (socket.readyState !== WebSocket.OPEN) {
      // Closed during registration. Its `close` handler ran before the identity below was
      // attached, so it had nothing to clean up — drop the entry written above here instead.
      early.discard();
      this.presenceRegistry.remove(uid, connId).catch(() => undefined);
      return;
    }

    // Attach the identity only now (no await between the check above and here), so a `close`
    // from this point on always finds a fully registered socket to clean up.
    socket.authContext = authContext;
    socket.connId = connId;
    socket.nodeId = this.nodeId;
    socket.realtimeProtocol = negotiateProtocol(request.url);

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
      protocol: socket.realtimeProtocol,
    };
    socket.localRecipientSocket = recipientSocket;
    this.localSockets.register(uid, recipientSocket);

    // 7. Handle inbound frames from this authenticated connection (`send`, `typing`, and the v2
    //    `delivered` / `ping`). The ciphertext is treated as opaque and never logged
    //    (Requirements 5.7, 8.2). A separate raw listener (mirroring the `pong` listener)
    //    is used because the wire frames key off `kind`, not the WsAdapter's event field.
    socket.on('message', (data: RawData) => {
      void this.handleInboundMessage(socket, data);
    });
    // Frames the client sent while the handshake was still being verified, in arrival order.
    for (const data of early.release()) {
      void this.handleInboundMessage(socket, data);
    }

    // 8. Replay the inbox: everything relayed to this user that no device has confirmed yet.
    //    Done AFTER the local socket is registered so a concurrently-relayed live message also
    //    has a delivery target (a v2 client drops the resulting duplicate by id).
    void this.replayInbox(uid, recipientSocket);
  }

  /**
   * Start buffering inbound frames on a socket whose handshake is still being verified. Bounded
   * by {@link MAX_EARLY_FRAMES} / {@link MAX_EARLY_BYTES} so an unauthenticated peer cannot make
   * the server hold unbounded data; frames past the bound are dropped (the sender's ACK timeout
   * then governs, exactly as for any unacknowledged send).
   */
  private bufferEarlyFrames(socket: AuthenticatedSocket): { release(): RawData[]; discard(): void } {
    const frames: RawData[] = [];
    let bytes = 0;
    const listener = (data: RawData): void => {
      const size = rawDataLength(data);
      if (frames.length >= MAX_EARLY_FRAMES || bytes + size > MAX_EARLY_BYTES) {
        return;
      }
      frames.push(data);
      bytes += size;
    };
    socket.on('message', listener);
    const stop = (): void => {
      socket.off('message', listener);
    };
    return {
      release: (): RawData[] => {
        stop();
        return frames.splice(0);
      },
      discard: (): void => {
        stop();
        frames.length = 0;
      },
    };
  }

  /**
   * Sends the recipient's pending inbox to a freshly-connected socket, in arrival order
   * (Requirement 8.2: the body is never decoded). First folds any pre-v2 `offline:{uid}` list into
   * the inbox so an upgrade strands nothing.
   *
   * - protocol v2: `hello`, then every pending entry with its `id`, non-destructively; entries are
   *   removed only by the client's `delivered` confirmations.
   * - legacy: the inbox is drained atomically (the old client never confirms, and replaying an
   *   envelope it already decrypted would only produce a decryption error).
   *
   * A Redis failure is logged and swallowed — it must not break an otherwise-valid connection;
   * the entries remain for the next connect.
   */
  private async replayInbox(uid: string, socket: LocalRecipientSocket): Promise<void> {
    const acked = (socket.protocol ?? 1) >= REALTIME_PROTOCOL_VERSION;
    if (acked) {
      socket.send({ kind: 'hello', protocol: REALTIME_PROTOCOL_VERSION });
    }
    let entries: InboxEntry[];
    try {
      await this.inbox.migrateLegacy(uid);
      entries = acked ? await this.inbox.list(uid) : await this.inbox.takeAll(uid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to replay the inbox on connect: ${message}`);
      return;
    }
    for (const { id, envelope } of entries) {
      socket.send(acked ? { kind: 'deliver', envelope, id } : { kind: 'deliver', envelope });
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
    // Announce this node as alive before the first handshake registers presence under it.
    this.nodeAlive = this.refreshNodeLiveness();
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
    this.stopHeartbeat();
  }

  /**
   * Graceful shutdown (SIGTERM on redeploy, via `enableShutdownHooks`): refuse new handshakes,
   * withdraw this node's liveness marker and presence entries so routing immediately treats its
   * users as offline (their messages go to the inbox + a wake push instead of into a closing
   * socket), then close every socket with 1012 so clients reconnect to the replacement node.
   * Runs before the WebSocket server is disposed and before Redis clients quit. Never throws.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopHeartbeat();
    const sockets = [...this.connections];
    try {
      await this.presenceRegistry.clearNodeAlive(this.nodeId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to clear node liveness on shutdown: ${message}`);
    }
    await Promise.all(sockets.map((socket) => this.handleDisconnect(socket)));
    for (const socket of sockets) {
      try {
        socket.close(WS_CLOSE_SERVICE_RESTART, 'service restart');
      } catch {
        // Already closing; the server dispose terminates whatever is left.
      }
    }
  }

  private stopHeartbeat(): void {
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
   * Then refreshes this node's liveness marker and re-asserts the presence entries of the
   * sockets it still holds (self-healing after a Redis blip).
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
    void this.refreshNodeLiveness();
  }

  /**
   * Refresh `node-alive:{nodeId}` and re-assert every held connection's presence entry. Failures
   * are logged and retried on the next tick; while the marker is missing, routing treats this
   * node's users as offline, so messages land in the inbox + a wake push rather than being lost.
   * Never rejects.
   */
  private async refreshNodeLiveness(): Promise<void> {
    try {
      await this.presenceRegistry.markNodeAlive(this.nodeId);
      const held: Array<{ uid: string; connId: string }> = [];
      for (const socket of this.connections) {
        const uid = socket.authContext?.uid;
        if (uid !== undefined && socket.connId !== undefined) {
          held.push({ uid, connId: socket.connId });
        }
      }
      await this.presenceRegistry.refresh(held, this.nodeId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to refresh node liveness: ${message}`);
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
    // Clear the identity so a second call (close event after a shutdown/terminate cleanup) is a
    // cheap no-op and the socket can never be relayed for again.
    socket.connId = undefined;

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
   * Requirements 5.6, 5.7, 8.2):
   *   - `send`: rate-limited per uid, then relayed via {@link MessageRelayService.relay}, which
   *     binds the wire-claimed `senderUid` to this connection's authenticated uid (rejecting a
   *     spoofed sender), stores it in the recipient's inbox, and fans it out. On
   *     `{ status: 'received' }` an `ack` frame is sent back to THIS sender so its message
   *     transitions sending → sent (5.6). A rejection, an over-limit frame, or a storage failure
   *     is neither ACKed nor surfaced — the sender's own 30 s timeout governs (5.11).
   *   - `typing`: rate-limited per uid, relayed ephemerally (never stored).
   *   - `delivered` (v2): removes the listed entries from the caller's OWN inbox.
   *   - `ping` (v2): answered with `pong`.
   * Anything else (including non-JSON) is ignored.
   *
   * Never rejects: a Redis/relay failure on one frame is logged and dropped rather than becoming
   * an unhandled rejection that would take the whole process (and every socket) down.
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

    try {
      switch (frame.kind) {
        case 'ping':
          this.sendFrame(socket, { kind: 'pong' });
          return;
        case 'delivered':
          if (Array.isArray(frame.ids)) {
            await this.inbox.ack(auth.uid, frame.ids);
          }
          return;
        case 'typing':
          // Ephemeral typing hint (Req 5.3): relayed to the recipient's node(s), never persisted
          // and never ACKed. Bound to the authenticated sender by the relay so it can't be spoofed.
          if (
            await this.withinLimit(
              `${WS_TYPING_RATE_LIMIT_SCOPE}:${auth.uid}`,
              WS_TYPING_RATE_LIMIT,
            )
          ) {
            await this.relay.relayTyping(auth, frame.recipientUid);
          }
          return;
        case 'send':
          await this.handleSend(socket, auth, frame.envelope);
          return;
        default:
          // Not a recognised client→server frame; ignore (no ACK).
          return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to handle an inbound frame: ${message}`);
    }
  }

  /** Relay one `send` frame and ACK it on acceptance (see {@link handleInboundMessage}). */
  private async handleSend(
    socket: AuthenticatedSocket,
    auth: AuthContext,
    envelope: CiphertextEnvelope,
  ): Promise<void> {
    if (!(await this.withinLimit(`${WS_SEND_RATE_LIMIT_SCOPE}:${auth.uid}`, WS_SEND_RATE_LIMIT))) {
      this.logger.warn('Dropped a send frame over the per-user rate limit');
      return;
    }
    const outcome = await this.relay.relay(auth, envelope);
    if (outcome.status !== 'received') {
      // Rejected (sender-mismatch / malformed): do not ACK. The relay published nothing
      // and never decoded the body; the sender's 30 s timeout governs (5.11).
      return;
    }

    // Accepted for delivery — ACK the sender so its message shows `sent` (5.6).
    this.sendFrame(socket, {
      kind: 'ack',
      recipientUid: envelope.recipientUid,
      seq: envelope.seq,
      status: 'received',
      nodes: outcome.nodes,
    });
  }

  /** Fixed-window per-uid frame limit; fails OPEN when the limiter itself is unavailable. */
  private async withinLimit(key: string, limit: number): Promise<boolean> {
    try {
      const result = await this.rateLimiter.hit(key, limit, WS_FRAME_RATE_WINDOW_SECONDS);
      return result.allowed;
    } catch {
      return true;
    }
  }

  /** Serialize and write one server→client frame to a raw socket. */
  private sendFrame(socket: AuthenticatedSocket, frame: ServerToClientFrame): void {
    socket.send(JSON.stringify(frame));
  }

  /**
   * Cross-node delivery callback for the `node:{nodeId}` Redis channel (task 4.7,
   * Requirement 5.x). A {@link MessageRelayService.relay} on any node publishes a
   * {@link NodeRelayMessage} to the channel of the node holding the recipient's socket;
   * the owning node (subscribed to its own channel) parses it here and calls
   * {@link MessageRelayService.deliverLocal} to push a `deliver` frame to the recipient's
   * local socket(s). If the recipient no longer has a socket here (it closed between the
   * presence lookup and the publish), a wake push is sent instead; the envelope stays in the
   * inbox either way.
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
    const id = typeof relayMessage.id === 'string' ? relayMessage.id : undefined;
    const written = this.relay.deliverLocal(relayMessage.targetUid, relayMessage.envelope, id);
    if (written === 0) {
      void this.pushNotifications.notify(relayMessage.targetUid);
    }
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

/** Most frames buffered per socket while its handshake is being verified. */
const MAX_EARLY_FRAMES = 64;

/** Most bytes buffered per socket while its handshake is being verified. */
const MAX_EARLY_BYTES = 1024 * 1024;

/** Byte length of a `ws` message payload in any of its shapes. */
function rawDataLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.length, 0);
  }
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}

/**
 * Reads the client's realtime protocol version from the handshake URL (`?v=2`). Anything absent,
 * malformed, or below 2 is the legacy protocol (1); versions above what this server speaks are
 * clamped to {@link REALTIME_PROTOCOL_VERSION}.
 */
export function negotiateProtocol(url: string | undefined): number {
  if (typeof url !== 'string' || url.length === 0) {
    return 1;
  }
  let raw: string | null;
  try {
    raw = new URL(url, 'http://placeholder.invalid').searchParams.get(REALTIME_PROTOCOL_QUERY_PARAM);
  } catch {
    return 1;
  }
  const version = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isInteger(version) || version < 2) {
    return 1;
  }
  return Math.min(version, REALTIME_PROTOCOL_VERSION);
}
