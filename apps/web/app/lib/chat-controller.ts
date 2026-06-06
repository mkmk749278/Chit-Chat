/**
 * `ChatController` — the seam between the web UI screens and the shared crypto core.
 *
 * The UI (`SignInScreen` + `ConversationScreen`) is pure and platform-shared; it talks
 * to authentication and messaging ONLY through this narrow interface. Task 7.8 (web app
 * bootstrap) provides the real controller, wiring the Firebase Web SDK `AuthTokenProvider`
 * (task 7.1), the in-memory `KeyStore` (already implemented), the `WebSocketTransport` /
 * `HttpClient` adapters (7.4, 7.5), and the shared `Messaging` orchestrator (2.27) behind
 * this same surface — so the screens need no change when real transport lands.
 *
 * Until those adapters exist, {@link createDemoController} provides an in-memory,
 * transport-less stand-in so the UI is runnable and the shared reducer integration is
 * exercised end-to-end in the browser. It performs NO real authentication or encryption
 * and is clearly not a production path.
 */

import type { ConversationEvent } from '@chat-app/crypto';

/** A change the controller pushes to the UI, fed straight into the shared reducer. */
export type ControllerEvent = ConversationEvent;

export interface ChatController {
  /** Request an OTP for an E.164 number; resolves true when the code was sent (1.1). */
  requestOtp(e164: string): Promise<boolean>;
  /**
   * Confirm a 6-digit code; resolves the signed-in UID on success or `null` on a rejected
   * credential (1.5). A successful sign-in is the gate into the Conversation_Screen.
   */
  confirmOtp(code: string): Promise<string | null>;
  /** Send plaintext to the current peer; status updates arrive via {@link subscribe}. */
  send(plaintext: string): Promise<void>;
  /** Subscribe to conversation events (inbound messages, status/ack updates). */
  subscribe(listener: (event: ControllerEvent) => void): () => void;
}

/**
 * In-memory demo controller: no Firebase, no libsignal, no socket. It lets the web UI
 * run and render the shared reducer state before the real adapters (tasks 7.1/7.4/7.5/7.8)
 * are wired. `confirmOtp` accepts any 6-digit code and returns a placeholder UID; `send`
 * is a no-op (the UI's optimistic append is the only state change). Replace wholesale with
 * the real controller in task 7.8.
 */
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
      // only visible effect. Real send/ack/receive lands with task 7.8.
    },
    subscribe(listener: (event: ControllerEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
