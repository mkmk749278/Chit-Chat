/**
 * Web `WebSocketTransport` adapter (Phase 1, task 7.4; design Client Component 4).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Client Component 4: Realtime_Client" + "Ports and adapters", and
 *   `requirements.md` → Requirements 4.1, 4.2, 8.6.
 *
 * Binds the shared `WebSocketTransport` port (from `@chat-app/crypto`) to the browser's
 * native `WebSocket`. The shared `RealtimeClient` owns all close/heartbeat/backoff logic;
 * this adapter only opens the socket and forwards lifecycle events.
 *
 * Security invariants enforced here (Requirements 4.2, 8.6):
 *   - TLS only: the URL MUST be `wss://`; a non-TLS endpoint is refused before any
 *     connection attempt, so no token-bearing handshake ever rides cleartext.
 *   - The Firebase ID token rides the `['bearer', <token>]` subprotocol the gateway
 *     parses; it is NEVER placed in the URL. This adapter passes the subprotocols array
 *     straight to the `WebSocket` constructor and never inspects or rewrites the URL.
 */

import type {
  Unsubscribe,
  WebSocketHandle,
  WebSocketTransport,
} from '@chat-app/crypto';

/** Wraps a single browser `WebSocket` as the shared {@link WebSocketHandle}. */
class BrowserWebSocketHandle implements WebSocketHandle {
  constructor(private readonly socket: WebSocket) {}

  send(data: string): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  onOpen(listener: () => void): Unsubscribe {
    const handler = (): void => listener();
    this.socket.addEventListener('open', handler);
    return () => this.socket.removeEventListener('open', handler);
  }

  onMessage(listener: (data: string) => void): Unsubscribe {
    const handler = (event: MessageEvent): void => {
      // The wire frames are JSON text; coerce non-string payloads defensively rather
      // than forwarding a Blob/ArrayBuffer the shared client would fail to JSON.parse.
      const { data } = event;
      listener(typeof data === 'string' ? data : String(data));
    };
    this.socket.addEventListener('message', handler);
    return () => this.socket.removeEventListener('message', handler);
  }

  onClose(listener: (code: number, reason: string) => void): Unsubscribe {
    const handler = (event: CloseEvent): void => listener(event.code, event.reason);
    this.socket.addEventListener('close', handler);
    return () => this.socket.removeEventListener('close', handler);
  }

  onError(listener: (error: unknown) => void): Unsubscribe {
    const handler = (event: Event): void => listener(event);
    this.socket.addEventListener('error', handler);
    return () => this.socket.removeEventListener('error', handler);
  }
}

/**
 * The browser `WebSocketTransport`. Inject into the shared `RealtimeClient` as its
 * `transport`. A single instance is reusable across reconnects (each `open` creates a
 * fresh socket).
 */
export class WebWebSocketTransport implements WebSocketTransport {
  open(url: string, subprotocols: string[]): WebSocketHandle {
    if (!url.startsWith('wss://')) {
      // TLS-only: refuse before constructing the socket so no handshake (and no token in
      // the subprotocol) is ever attempted over a non-TLS endpoint (Requirements 8.6, 8.7).
      throw new Error('WebWebSocketTransport: url must be a wss:// (TLS) endpoint');
    }
    // The token rides the subprotocols array only; the URL is passed through untouched.
    const socket = new WebSocket(url, subprotocols);
    return new BrowserWebSocketHandle(socket);
  }
}

/** Convenience factory mirroring the ports-and-adapters style of the shared core. */
export function createWebWebSocketTransport(): WebSocketTransport {
  return new WebWebSocketTransport();
}
