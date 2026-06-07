/**
 * Mobile `WebSocketTransport` adapter (Phase 1, task 6.4; design Client Component 4).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Client Component 4: Realtime_Client" + "Ports and adapters", and
 *   `requirements.md` → Requirements 4.1, 4.2, 8.6.
 *
 * Binds the shared `WebSocketTransport` port (`@chat-app/crypto`) to the React Native
 * global `WebSocket` (Hermes provides a browser-compatible `WebSocket`). The shared
 * `RealtimeClient` owns all close/heartbeat/backoff logic; this adapter only opens the
 * socket and forwards lifecycle events.
 *
 * Security invariants (Requirements 4.2, 8.6): TLS only — the URL MUST be `wss://`; the
 * Firebase ID token rides the `['bearer', <token>]` subprotocol and is NEVER placed in
 * the URL. The subprotocols array is passed straight to the `WebSocket` constructor.
 */

import type {
  Unsubscribe,
  WebSocketHandle,
  WebSocketTransport,
} from '@chat-app/crypto';

class ReactNativeWebSocketHandle implements WebSocketHandle {
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
    const handler = (event: WebSocketMessageEvent): void => {
      const { data } = event;
      listener(typeof data === 'string' ? data : String(data));
    };
    this.socket.addEventListener('message', handler);
    return () => this.socket.removeEventListener('message', handler);
  }

  onClose(listener: (code: number, reason: string) => void): Unsubscribe {
    const handler = (event: WebSocketCloseEvent): void =>
      listener(event.code ?? 1006, event.reason ?? '');
    this.socket.addEventListener('close', handler);
    return () => this.socket.removeEventListener('close', handler);
  }

  onError(listener: (error: unknown) => void): Unsubscribe {
    const handler = (event: Event): void => listener(event);
    this.socket.addEventListener('error', handler);
    return () => this.socket.removeEventListener('error', handler);
  }
}

export class ReactNativeWebSocketTransport implements WebSocketTransport {
  open(url: string, subprotocols: string[]): WebSocketHandle {
    if (!url.startsWith('wss://')) {
      // TLS-only: refuse before constructing the socket so no bearer-subprotocol
      // handshake is ever attempted over a non-TLS endpoint (Requirements 8.6, 8.7).
      throw new Error('ReactNativeWebSocketTransport: url must be a wss:// (TLS) endpoint');
    }
    // The token rides the subprotocols array only; the URL is untouched.
    const socket = new WebSocket(url, subprotocols);
    return new ReactNativeWebSocketHandle(socket);
  }
}

export function createReactNativeWebSocketTransport(): WebSocketTransport {
  return new ReactNativeWebSocketTransport();
}
