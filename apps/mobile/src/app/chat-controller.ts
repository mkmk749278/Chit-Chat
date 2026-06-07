/**
 * `ChatController` — the seam between the mobile UI screens and the shared crypto core.
 *
 * Mirrors the web controller: the screens (`SignInScreen` + `ConversationScreen`) talk
 * to authentication and messaging ONLY through this narrow interface. Task 6.9 (mobile
 * bootstrap) provides the real controller, wiring the `@react-native-firebase/auth`
 * adapter (task 6.1), the SQLCipher `KeyStore` (6.2), the native libsignal engine, the
 * RN `WebSocketTransport` / `HttpClient` adapters (6.4, 6.5), and the shared `Messaging`
 * orchestrator (2.27) behind this same surface — so the screens need no change when the
 * real transport/crypto land.
 *
 * Until the native engine + SQLCipher store are wired, {@link createDemoController}
 * provides an in-memory, transport-less stand-in so the UI is runnable and the shared
 * reducer integration is exercised on-device. It performs NO real authentication or
 * encryption and is clearly not a production path.
 */

import type { ConversationEvent } from '@chat-app/crypto';

export type ControllerEvent = ConversationEvent;

export interface ChatController {
  requestOtp(e164: string): Promise<boolean>;
  confirmOtp(code: string): Promise<string | null>;
  send(plaintext: string): Promise<void>;
  subscribe(listener: (event: ControllerEvent) => void): () => void;
}

export function createDemoController(): ChatController {
  const listeners = new Set<(event: ControllerEvent) => void>();
  return {
    async requestOtp(e164: string): Promise<boolean> {
      return /^\+[1-9]\d{6,14}$/.test(e164);
    },
    async confirmOtp(code: string): Promise<string | null> {
      return /^\d{6}$/.test(code) ? `demo:${code}` : null;
    },
    async send(): Promise<void> {
      // No transport in the demo controller; the container's optimistic append is the
      // only visible effect. Real send/ack/receive lands with task 6.9.
    },
    subscribe(listener: (event: ControllerEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
