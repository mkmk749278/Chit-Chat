/**
 * `RealtimeClient` — the authenticated WebSocket connection state machine (Phase 1,
 * design Component 4: Realtime_Client).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Components and Interfaces" → "Client Component 4: Realtime_Client", the
 *   "Reconnect / backoff on close" sequence diagram, and `requirements.md` →
 *   Requirement 4 (4.1–4.11) plus Requirement 6.6.
 *
 * The client opens a TLS WebSocket to the `ws.` endpoint using the
 * `['bearer', <Firebase ID token>]` subprotocol handshake the Phase 0
 * `RealtimeGateway` already parses — the token rides the subprotocol ONLY and is
 * never placed in the URL query string (Requirements 4.1, 4.2, 8.6). It responds to
 * server heartbeat pings with a pong within 5 s (4.3) and reconnects with
 * close-code-aware policy:
 *
 *   - close `4401` (unauthorized)         → refresh the token, then reconnect; if the
 *                                            refresh is exhausted, stop and surface
 *                                            re-authentication-required (4.4, 4.9);
 *   - close `4503` / `4429` / any other
 *     non-deliberate close, a 10 s
 *     handshake timeout, or a missed pong  → reconnect with jittered exponential
 *                                            backoff (4.5, 4.6, 4.10, 4.11);
 *   - a client-initiated `disconnect()`    → no reconnection until the next
 *                                            `connect()` (4.8).
 *
 * It exposes `connected` while the socket is open and `disconnected` while closed,
 * connecting, or reconnecting (4.7, 6.6).
 *
 * Determinism: the transport, the auth service, the {@link BackoffPolicy}, and the
 * timer {@link Scheduler} are all injected, so the close-handling, handshake-timeout,
 * heartbeat, and backoff behaviour can be unit- and property-tested without a real
 * socket, real Firebase, or real wall-clock timers (design §"Determinism").
 */

import type {
  ClientToServerFrame,
  ConnectionStatus,
  ServerToClientFrame,
} from '@chat-app/types';
import { BackoffPolicy } from './backoff-policy';
import type { Unsubscribe, WebSocketHandle, WebSocketTransport } from './ports';

/** WebSocket close code meaning "unauthorized" — refresh the token then reconnect (4.4). */
export const CLOSE_CODE_UNAUTHORIZED = 4401;
/** WebSocket close code meaning "auth dependency unavailable" — backoff reconnect (4.5). */
export const CLOSE_CODE_AUTH_UNAVAILABLE = 4503;
/** WebSocket close code meaning "rate limited" — backoff reconnect (design §close codes). */
export const CLOSE_CODE_RATE_LIMITED = 4429;

/** Default handshake completion deadline: 10 s (Requirement 4.10). */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Default pong-response deadline after a server ping: 5 s (Requirements 4.3, 4.11). */
export const DEFAULT_PONG_TIMEOUT_MS = 5_000;

/**
 * Opaque timer handle returned by a {@link Scheduler}. The concrete shape depends on
 * the host (`number` in browsers, `Timeout` in Node), so the client treats it as
 * opaque and only ever hands it back to {@link Scheduler.clearTimeout}.
 */
export type TimerHandle = unknown;

/**
 * Injected timer surface so handshake/pong/backoff deadlines can be driven by a fake
 * clock in tests (design §"Determinism"). Defaults to the host `setTimeout` /
 * `clearTimeout` when not supplied.
 */
export interface Scheduler {
  /** Schedule `handler` to run after `delayMs` milliseconds; returns a cancel handle. */
  setTimeout(handler: () => void, delayMs: number): TimerHandle;
  /** Cancel a previously scheduled handler by its handle. */
  clearTimeout(handle: TimerHandle): void;
}

/**
 * The narrow Auth_Service surface the {@link RealtimeClient} depends on (design
 * Component 1). The full `AuthService` satisfies this structurally; only the current
 * token and the bounded-retry refresh are needed here.
 */
export interface RealtimeAuthService {
  /** Current cached Firebase ID token, or `null` if not signed in. */
  getCurrentToken(): string | null;
  /**
   * Refresh the Firebase ID token, retrying at most 3 times and stopping on the first
   * success; rejects (with a re-auth-required error) once refresh is exhausted
   * (Requirements 1.6, 1.9). Driven by a `4401` close (Requirement 4.4).
   */
  refreshWithRetry(): Promise<string>;
}

/** Construction options for {@link RealtimeClient}. */
export interface RealtimeClientOptions {
  /**
   * Absolute `wss://` URL of the `ws.` endpoint. The Firebase ID token is NEVER added
   * to this URL — it rides the `bearer` subprotocol only (Requirements 4.2, 8.6).
   */
  url: string;
  /** Transport used to open the authenticated WebSocket (injected for testability). */
  transport: WebSocketTransport;
  /** Auth service for the current token and the bounded-retry refresh on `4401`. */
  auth: RealtimeAuthService;
  /** Backoff policy for reconnection delays. Defaults to a fresh {@link BackoffPolicy}. */
  backoff?: BackoffPolicy;
  /** Timer surface. Defaults to the host `setTimeout` / `clearTimeout`. */
  scheduler?: Scheduler;
  /** Handshake completion deadline in ms. Defaults to {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}. */
  handshakeTimeoutMs?: number;
  /** Pong-response deadline in ms after a server ping. Defaults to {@link DEFAULT_PONG_TIMEOUT_MS}. */
  pongTimeoutMs?: number;
}

/**
 * The reaction to a WebSocket close, determined solely by the close code and whether
 * the close was a deliberate client-initiated disconnect (Property 13).
 *
 * - `no-reconnect`      — client-initiated disconnect; do not reconnect (4.8).
 * - `refresh-reconnect` — close `4401`; refresh the token, then reconnect (4.4, 4.9).
 * - `backoff-reconnect` — `4503` / `4429` / any other non-deliberate close; reconnect
 *                         with jittered exponential backoff (4.5, 4.6).
 */
export type ReconnectDecision = 'no-reconnect' | 'refresh-reconnect' | 'backoff-reconnect';

/**
 * Pure classifier mapping a WebSocket close to the {@link RealtimeClient}'s reaction.
 * Extracted as a standalone function so the close-code-driven reconnect classification
 * (Property 13) is testable in isolation, without driving the whole state machine.
 *
 * The reaction depends ONLY on the close code and deliberateness — never on transport
 * timing or attempt history (Requirements 4.4, 4.5, 4.6, 4.8).
 *
 * @param closeCode - the WebSocket close code.
 * @param clientInitiated - whether the close was a deliberate `disconnect()`.
 */
export function classifyReconnect(closeCode: number, clientInitiated: boolean): ReconnectDecision {
  if (clientInitiated) {
    return 'no-reconnect';
  }
  if (closeCode === CLOSE_CODE_UNAUTHORIZED) {
    return 'refresh-reconnect';
  }
  // 4503, 4429, and every other non-deliberate close fall through to backoff (4.5, 4.6).
  return 'backoff-reconnect';
}

/** The connection lifecycle phase. `connected` is the only phase that maps to a `connected` status. */
type Phase = 'idle' | 'connecting' | 'connected' | 'backoff';

/** Default {@link Scheduler} bound to the host timer functions. */
const defaultScheduler: Scheduler = {
  setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    if (handle !== null && handle !== undefined) {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    }
  },
};

/**
 * The authenticated-WebSocket state machine (design Component 4). Maintains the
 * connection, runs heartbeat pong responses, and reconnects with close-code-aware
 * backoff, exposing a `connected` / `disconnected` status to the Conversation_Screen
 * (Requirements 4.1–4.11, 6.6).
 *
 * Heartbeat model: because the injected {@link WebSocketHandle} carries text frames
 * only, the heartbeat is application-level — an inbound `{ kind: 'ping' }` frame is
 * answered with a `{ kind: 'pong' }` frame; if the pong cannot be sent within the
 * pong deadline the connection is treated as failed (Requirements 4.3, 4.11). Inbound
 * `deliver` / `ack` frames are forwarded to {@link RealtimeClient.onFrame} listeners;
 * ping/pong control frames are handled internally and never forwarded.
 */
export class RealtimeClient {
  private readonly url: string;
  private readonly transport: WebSocketTransport;
  private readonly auth: RealtimeAuthService;
  private readonly backoff: BackoffPolicy;
  private readonly scheduler: Scheduler;
  private readonly handshakeTimeoutMs: number;
  private readonly pongTimeoutMs: number;

  /** The live socket for the current attempt, or `null` while idle/backing off. */
  private currentHandle: WebSocketHandle | null = null;
  /** Listener teardown handles for the current socket. */
  private socketUnsubscribers: Unsubscribe[] = [];

  /**
   * Monotonic attempt token. Each attempt captures the value live at the time its
   * listeners fire; once an attempt is torn down this counter advances so any stale
   * transport callback (a late `open`/`close` after we proactively terminated) is
   * ignored.
   */
  private attemptId = 0;

  /** Zero-based reconnect attempt index fed to the {@link BackoffPolicy}. Reset on open. */
  private reconnectAttempt = 0;

  /**
   * Master reconnection switch. `false` after a client-initiated disconnect (4.8) or
   * once token refresh is exhausted (4.9); `connect()` re-enables it.
   */
  private autoReconnect = false;
  /** Whether the most recent close was a deliberate client-initiated disconnect. */
  private clientInitiated = false;
  /** Whether the client has surfaced a re-authentication-required indication (4.9). */
  private reauthRequired = false;

  private phase: Phase = 'idle';
  private status: ConnectionStatus = 'disconnected';

  private handshakeTimer: TimerHandle | null = null;
  private pongTimer: TimerHandle | null = null;
  private backoffTimer: TimerHandle | null = null;

  private readonly frameListeners = new Set<(frame: ServerToClientFrame) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly reauthListeners = new Set<() => void>();
  /** Resolvers for in-flight `connect()` promises, settled on open or terminal stop. */
  private pendingConnectResolvers: Array<() => void> = [];

  constructor(options: RealtimeClientOptions) {
    if (typeof options.url !== 'string' || !options.url.startsWith('wss://')) {
      // TLS-only: the realtime endpoint must be reached over wss:// (Requirements 8.6, 8.7).
      throw new TypeError('RealtimeClient: url must be an absolute wss:// endpoint');
    }
    this.url = options.url;
    this.transport = options.transport;
    this.auth = options.auth;
    this.backoff = options.backoff ?? new BackoffPolicy();
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // Public API (design Component 4 interface).
  // -------------------------------------------------------------------------

  /**
   * Open the authenticated WebSocket. Enables auto-reconnect and starts a connection
   * attempt if one is not already in progress. The returned promise resolves the next
   * time the socket opens; it also resolves (rather than rejecting) if the client is
   * stopped meanwhile (client-initiated disconnect or exhausted refresh), so a
   * fire-and-forget `connect()` never produces an unhandled rejection — observe the
   * outcome via {@link RealtimeClient.onStatus} / {@link RealtimeClient.getStatus} and
   * {@link RealtimeClient.onReauthRequired} (Requirements 4.1, 4.7).
   */
  connect(): Promise<void> {
    this.autoReconnect = true;
    this.clientInitiated = false;
    this.reauthRequired = false;
    if (this.phase === 'connected') {
      return Promise.resolve();
    }
    const promise = new Promise<void>((resolve) => {
      this.pendingConnectResolvers.push(resolve);
    });
    if (this.phase === 'idle') {
      this.reconnectAttempt = 0;
      this.startAttempt();
    }
    return promise;
  }

  /**
   * Client-initiated disconnect. Disables auto-reconnect until the next `connect()`,
   * tears down the current socket, and exposes `disconnected` (Requirements 4.8, 4.7).
   */
  disconnect(): void {
    this.autoReconnect = false;
    this.clientInitiated = true;
    this.clearBackoffTimer();
    const handle = this.currentHandle;
    this.teardownSocket();
    if (handle !== null) {
      try {
        handle.close(1000, 'client-initiated disconnect');
      } catch {
        // The socket may already be closing; nothing more to do.
      }
    }
    this.phase = 'idle';
    this.setStatus('disconnected');
    this.resolvePendingConnects();
  }

  /**
   * Force a fresh connection attempt immediately, regardless of the current phase — for
   * app-foreground resume.
   *
   * When the OS suspends a backgrounded app it can silently drop the TCP/TLS socket WITHOUT
   * delivering a `close` event to the frozen JS engine. On resume the client may therefore still
   * believe it is `connected` while the socket is actually a zombie: no `close` ever fires, the
   * server heartbeat never arrives, and the store-and-forward queue is never drained — so new
   * messages only appear after a manual app restart. Calling this on `AppState → active` tears down
   * any current socket, cancels a pending backoff, resets the attempt counter, and opens a new
   * authenticated socket at once. The gateway drains the offline queue on the fresh handshake, so
   * queued messages arrive promptly. Re-enables auto-reconnect (like {@link connect}); safe to call
   * when signed out (no token ⇒ it simply stays `disconnected`) and never throws.
   */
  reconnectNow(): void {
    this.autoReconnect = true;
    this.clientInitiated = false;
    this.reauthRequired = false;
    this.clearBackoffTimer();
    const handle = this.currentHandle;
    // Tear down the current (possibly zombie) socket and invalidate its attempt, then proactively
    // close the old handle so the server releases the stale presence entry.
    this.teardownSocket();
    if (handle !== null) {
      try {
        handle.close(1000, 'foreground reconnect');
      } catch {
        // The socket may already be closing; nothing more to do.
      }
    }
    this.reconnectAttempt = 0;
    this.phase = 'idle';
    this.setStatus('disconnected');
    this.startAttempt();
  }

  /**
   * Send a wire frame over the open socket (the Messaging layer builds the envelope).
   * Throws if called while not connected — the Messaging layer is responsible for the
   * pending-send queue while disconnected (design Component 5, Requirement 5.10).
   */
  send(frame: ClientToServerFrame): void {
    if (this.phase !== 'connected' || this.currentHandle === null) {
      throw new Error('RealtimeClient: cannot send while not connected');
    }
    this.currentHandle.send(JSON.stringify(frame));
  }

  /** Subscribe to inbound `deliver` / `ack` frames. Control frames are not forwarded. */
  onFrame(listener: (frame: ServerToClientFrame) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  /** Subscribe to connection-status changes (4.7, 6.6). Use {@link getStatus} for the current value. */
  onStatus(listener: (status: ConnectionStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Subscribe to the re-authentication-required indication surfaced when the token
   * refresh triggered by a `4401` close is exhausted (Requirement 4.9).
   */
  onReauthRequired(listener: () => void): Unsubscribe {
    this.reauthListeners.add(listener);
    return () => {
      this.reauthListeners.delete(listener);
    };
  }

  /** The current connection status: `connected` only while the socket is open (4.7, 6.6). */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /** Whether re-authentication is currently required (refresh exhausted on a `4401`; 4.9). */
  isReauthRequired(): boolean {
    return this.reauthRequired;
  }

  // -------------------------------------------------------------------------
  // Connection attempt lifecycle.
  // -------------------------------------------------------------------------

  /**
   * Open a fresh socket for the next attempt using the current token over the
   * `['bearer', token]` subprotocol — never in the URL (Requirements 4.1, 4.2). Arms
   * the handshake-timeout deadline (4.10). If no token is available the client stops
   * and stays `disconnected` (a fresh `connect()` is required after sign-in).
   */
  private startAttempt(): void {
    if (!this.autoReconnect) {
      this.phase = 'idle';
      this.setStatus('disconnected');
      return;
    }

    const token = this.auth.getCurrentToken();
    if (token === null) {
      // No valid token: cannot open an authenticated connection (Requirement 4.1).
      this.phase = 'idle';
      this.setStatus('disconnected');
      return;
    }

    this.phase = 'connecting';
    // Connecting is not yet open, so the exposed status remains disconnected (4.7, Property 14).
    this.setStatus('disconnected');

    const id = (this.attemptId += 1);
    let handle: WebSocketHandle;
    try {
      // Token rides the subprotocol ONLY; the URL carries no token (4.1, 4.2, 8.6).
      handle = this.transport.open(this.url, ['bearer', token]);
    } catch {
      // Transport failed to open (e.g. TLS could not be established, Requirement 8.7):
      // abort without retainable state and reconnect under backoff (4.6).
      this.scheduleBackoffReconnect();
      return;
    }

    this.currentHandle = handle;
    this.socketUnsubscribers = [
      handle.onOpen(() => {
        if (id === this.attemptId) {
          this.handleOpen();
        }
      }),
      handle.onMessage((data) => {
        if (id === this.attemptId) {
          this.handleMessage(data);
        }
      }),
      handle.onClose((code) => {
        if (id === this.attemptId) {
          this.handleClose(code);
        }
      }),
      handle.onError(() => {
        // A transport error is informational; the authoritative `close` (with its code)
        // drives reconnection so close-code classification (Property 13) is preserved.
        // The handshake timeout (4.10) covers an error that never produces a close.
      }),
    ];

    this.handshakeTimer = this.scheduler.setTimeout(() => {
      if (id === this.attemptId) {
        this.handleHandshakeTimeout();
      }
    }, this.handshakeTimeoutMs);
  }

  /** The handshake completed: clear the deadline, expose `connected`, reset backoff (4.7). */
  private handleOpen(): void {
    this.clearHandshakeTimer();
    this.phase = 'connected';
    this.reconnectAttempt = 0;
    this.clientInitiated = false;
    this.setStatus('connected');
    this.resolvePendingConnects();
  }

  /**
   * The socket closed. Tear down, then react per {@link classifyReconnect}: a
   * client-initiated/stopped close does nothing; `4401` refreshes then reconnects;
   * every other non-deliberate code reconnects with backoff (Requirements 4.4–4.6, 4.8).
   */
  private handleClose(code: number): void {
    this.teardownSocket();

    if (!this.autoReconnect) {
      this.phase = 'idle';
      this.setStatus('disconnected');
      return;
    }

    const decision = classifyReconnect(code, this.clientInitiated);
    switch (decision) {
      case 'no-reconnect':
        this.autoReconnect = false;
        this.phase = 'idle';
        this.setStatus('disconnected');
        break;
      case 'refresh-reconnect':
        this.setStatus('disconnected');
        void this.handleRefreshReconnect();
        break;
      case 'backoff-reconnect':
        this.scheduleBackoffReconnect();
        break;
    }
  }

  /**
   * Handle a `4401` close: refresh the Firebase ID token and reconnect on success; if
   * the refresh is exhausted, stop reconnecting, stay `disconnected`, and surface the
   * re-authentication-required indication (Requirements 4.4, 4.9).
   */
  private async handleRefreshReconnect(): Promise<void> {
    try {
      await this.auth.refreshWithRetry();
    } catch {
      // Refresh exhausted (Requirement 4.9): stop, expose disconnected, surface reauth.
      this.autoReconnect = false;
      this.phase = 'idle';
      this.reauthRequired = true;
      this.setStatus('disconnected');
      this.emitReauthRequired();
      this.resolvePendingConnects();
      return;
    }

    if (!this.autoReconnect) {
      // A client-initiated disconnect raced ahead of the refresh; honour it (4.8).
      return;
    }
    // A successful refresh reconnects immediately with the new token, not under backoff (4.4).
    this.reconnectAttempt = 0;
    this.startAttempt();
  }

  /**
   * Schedule the next reconnect after a jittered backoff delay for the current attempt
   * index (Requirements 4.5, 4.6, 4.10, 4.11). Stays `disconnected` while waiting (4.7).
   */
  private scheduleBackoffReconnect(): void {
    if (!this.autoReconnect) {
      this.phase = 'idle';
      this.setStatus('disconnected');
      return;
    }
    this.phase = 'backoff';
    this.setStatus('disconnected');

    const delay = this.backoff.delayForAttempt(this.reconnectAttempt);
    this.reconnectAttempt += 1;

    this.clearBackoffTimer();
    this.backoffTimer = this.scheduler.setTimeout(() => {
      this.backoffTimer = null;
      this.startAttempt();
    }, delay);
  }

  /**
   * The handshake did not complete within the deadline (Requirement 4.10): terminate
   * the pending socket, expose `disconnected`, and reconnect under backoff (4.6).
   */
  private handleHandshakeTimeout(): void {
    const handle = this.currentHandle;
    this.teardownSocket();
    if (handle !== null) {
      try {
        handle.close(CLOSE_CODE_RATE_LIMITED, 'handshake timeout');
      } catch {
        // Already closing; ignore.
      }
    }
    this.scheduleBackoffReconnect();
  }

  // -------------------------------------------------------------------------
  // Inbound frame + heartbeat handling.
  // -------------------------------------------------------------------------

  /**
   * Route an inbound text frame: answer a `ping` control frame with a `pong` (4.3),
   * forward `deliver` / `ack` frames to listeners, and ignore anything else. Malformed
   * JSON is dropped silently rather than crashing the socket.
   */
  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }
    const kind = (parsed as { kind?: unknown }).kind;
    if (kind === 'ping') {
      this.respondToPing();
      return;
    }
    if (kind === 'deliver' || kind === 'ack' || kind === 'typing') {
      // `typing` is an ephemeral presence hint (Req 5.3): forwarded like any server frame,
      // never persisted. Consumers (Messaging) decide what to do with it.
      this.emitFrame(parsed as ServerToClientFrame);
    }
    // Unknown frame kinds are ignored.
  }

  /**
   * Respond to a server heartbeat ping with a pong, arming a pong deadline so that a
   * pong which cannot be sent in time is treated as a failed connection (Requirements
   * 4.3, 4.11). On a successful synchronous send the deadline is cleared immediately.
   */
  private respondToPing(): void {
    if (this.currentHandle === null) {
      return;
    }
    const id = this.attemptId;
    this.clearPongTimer();
    this.pongTimer = this.scheduler.setTimeout(() => {
      if (id === this.attemptId) {
        this.handlePongMissed();
      }
    }, this.pongTimeoutMs);

    try {
      this.currentHandle.send(JSON.stringify({ kind: 'pong' }));
      // Pong delivered within the window; cancel the failure deadline.
      this.clearPongTimer();
    } catch {
      // Could not send the pong; leave the deadline armed to fail the connection (4.11).
    }
  }

  /**
   * No pong was sent within the deadline (Requirement 4.11): treat the connection as
   * failed, terminate it, and reconnect under backoff (4.6).
   */
  private handlePongMissed(): void {
    const handle = this.currentHandle;
    this.teardownSocket();
    if (handle !== null) {
      try {
        handle.close(CLOSE_CODE_RATE_LIMITED, 'pong timeout');
      } catch {
        // Already closing; ignore.
      }
    }
    this.scheduleBackoffReconnect();
  }

  // -------------------------------------------------------------------------
  // Internal helpers.
  // -------------------------------------------------------------------------

  /** Detach socket listeners, clear handshake/pong timers, drop the handle, invalidate the attempt. */
  private teardownSocket(): void {
    this.attemptId += 1;
    for (const unsubscribe of this.socketUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        // Best-effort detach.
      }
    }
    this.socketUnsubscribers = [];
    this.clearHandshakeTimer();
    this.clearPongTimer();
    this.currentHandle = null;
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      this.scheduler.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) {
      this.scheduler.clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private clearBackoffTimer(): void {
    if (this.backoffTimer !== null) {
      this.scheduler.clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  /** Update the exposed status and notify listeners only on an actual change (4.7, 6.6). */
  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // A listener throwing must not break the state machine.
      }
    }
  }

  private emitFrame(frame: ServerToClientFrame): void {
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch {
        // A listener throwing must not break the state machine.
      }
    }
  }

  private emitReauthRequired(): void {
    for (const listener of this.reauthListeners) {
      try {
        listener();
      } catch {
        // A listener throwing must not break the state machine.
      }
    }
  }

  /** Settle every in-flight `connect()` promise (on open or terminal stop). */
  private resolvePendingConnects(): void {
    const resolvers = this.pendingConnectResolvers;
    this.pendingConnectResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }
}
