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
 * {@link createMobileController} is the production controller for the parts that do NOT
 * require the native crypto engine: it performs REAL Firebase phone authentication via
 * the shared {@link AuthService} policy over the `@react-native-firebase/auth` adapter
 * (tasks 6.1 + 1.x). End-to-end MESSAGING still depends on the native libsignal
 * `SessionManager` + the SQLCipher `KeyStore` (tasks 6.2 + the native engine); until
 * those land, `send()` represents a message honestly — appended then marked `failed`
 * (text retained), never transmitted and never fake-encrypted.
 *
 * {@link createDemoController} remains an in-memory, transport-less stand-in (no real
 * auth) for local UI iteration.
 */

import { AuthService, type ConversationEvent } from '@chat-app/crypto';

import { FirebaseAuthAdapter } from '../auth';

export type ControllerEvent = ConversationEvent;

export interface ChatController {
  requestOtp(e164: string): Promise<boolean>;
  confirmOtp(code: string): Promise<string | null>;
  send(plaintext: string): Promise<void>;
  subscribe(listener: (event: ControllerEvent) => void): () => void;
}

/**
 * Production controller: REAL Firebase phone auth (via the shared {@link AuthService}
 * over the mobile {@link FirebaseAuthAdapter}). Messaging is gated on the native engine
 * (see file header) and surfaces an honest `failed` status rather than faking delivery.
 *
 * For phone auth to succeed on a device, the app's signing SHA-1/SHA-256 fingerprints
 * must be registered on the Firebase Android app, Phone sign-in must be enabled, and the
 * baked `google-services.json` must match the project.
 */
export function createMobileController(): ChatController {
  const provider = new FirebaseAuthAdapter();
  const authService = new AuthService(provider);
  const listeners = new Set<(event: ControllerEvent) => void>();
  const emit = (event: ControllerEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  let outboundSeq = 0;

  return {
    async requestOtp(e164: string): Promise<boolean> {
      const result = await authService.requestOtp(e164);
      return result.ok;
    },
    async confirmOtp(code: string): Promise<string | null> {
      try {
        const { uid } = await authService.confirmOtp(code);
        return uid;
      } catch {
        // Invalid/expired code (or provider error). The Sign_In_Screen keeps the
        // entered phone number and shows a retry affordance (Requirement 1.5).
        return null;
      }
    },
    async send(plaintext: string): Promise<void> {
      // Honest stand-in until the native libsignal SessionManager + SQLCipher KeyStore
      // are wired: show the message, then immediately mark it failed (text retained).
      // Nothing is transmitted and nothing is fake-encrypted.
      const seq = (outboundSeq += 1);
      const id = `out-${seq}`;
      emit({
        type: 'message-appended',
        message: { id, seq, direction: 'out', text: plaintext, status: 'sending' },
      });
      emit({ type: 'status-updated', id, status: 'failed' });
    },
    subscribe(listener: (event: ControllerEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
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
