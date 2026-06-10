/**
 * `ChatController` — the seam between the mobile UI screens and the shared crypto core.
 *
 * The screens (`SignInScreen`, `ChatsListScreen`, `ContactsScreen`, `ConversationScreen`)
 * talk to authentication and messaging ONLY through this narrow interface, so the real
 * transport/crypto wiring lands here without changing the screens.
 *
 * {@link createMobileController} is the PRODUCTION controller. It performs real Firebase
 * phone authentication (shared {@link AuthService} over the `@react-native-firebase/auth`
 * adapter) and, on sign-in, bootstraps the full encrypted-messaging stack:
 *
 *   IdentityManager (pure-TS keygen) → DeviceRegistrar (POST /api/devices/register) →
 *   SessionManager (pure-TS libsignal engine over a SignalProtocolStore) →
 *   Messaging (claim → establish → encrypt → relay → ack / inbound decrypt) over a
 *   RealtimeClient (wss://ws.luminchat.app).
 *
 * Contact discovery resolves a phone number to a recipient UID via the backend directory
 * (`POST /api/directory/resolve`); a conversation is keyed by that UID.
 *
 * Storage note (v1): identity/sessions/messages live in an in-memory KeyStore, so they do
 * not survive an app restart (the device re-registers on next launch). A persistent,
 * encrypted-at-rest SQLCipher KeyStore is a drop-in replacement behind the same port.
 *
 * Routing note (v1): conversation events from the orchestrator are not yet tagged with the
 * peer, so the container applies them to the OPEN conversation. This is correct for the
 * common case (chatting with one peer with that chat open); per-conversation tagging is a
 * follow-up.
 *
 * {@link createDemoController} remains an in-memory, transport-less stand-in (no real auth)
 * for local UI iteration.
 */

import {
  AuthService,
  BackoffPolicy,
  createEnvelopeCodec,
  createMessaging,
  createPureTsLibsignalEngine,
  createPureTsLibsignalKeyGen,
  createSessionManager,
  DefaultDeviceRegistrar,
  DefaultIdentityManager,
  KeyStoreSequenceAllocator,
  RealtimeClient,
  type ConversationEvent,
  type KeyStore,
  type Messaging,
} from '@chat-app/crypto';

import { FirebaseAuthAdapter } from '../auth';
import { API_BASE_URL, REGISTER_URL, WS_URL } from '../api/api-config';
import { createDirectoryClient, createPreKeyClaimClient, type DirectoryClient } from '../api/api-clients';
import { createInMemoryKeyStore } from '../crypto/in-memory-key-store';
import { signalStoreFromIdentity } from '../crypto/signal-store';
import { createReactNativeHttpClient } from '../transport/http-client';
import { createReactNativeWebSocketTransport } from '../transport/web-socket-transport';

export type ControllerEvent = ConversationEvent;

/**
 * Encryption-setup lifecycle for the signed-in user: identity generation + device
 * registration + realtime connect. Surfaced to the UI so a failed bootstrap is VISIBLE
 * (with the underlying error) and retryable, instead of silently leaving the user unable to
 * be discovered or messaged.
 */
export interface SetupState {
  phase: 'idle' | 'registering' | 'ready' | 'failed';
  /** Human-readable failure reason when `phase === 'failed'`. */
  error?: string;
}

/** Result of an OTP request: `ok`, plus the raw provider error code on failure. */
export interface RequestOtpResult {
  ok: boolean;
  error?: string;
}

/** Result of resolving a phone number to a chat-able recipient. */
export type ResolveContactResult =
  | { ok: true; uid: string }
  | { ok: false; error: string };

export interface ChatController {
  requestOtp(e164: string): Promise<RequestOtpResult>;
  confirmOtp(code: string): Promise<string | null>;
  /** Resolve an E.164 phone number to a recipient UID via the backend directory. */
  resolveContact(e164: string): Promise<ResolveContactResult>;
  /** Set the conversation that subsequent {@link ChatController.send} calls target. */
  openConversation(recipientUid: string): void;
  /** Send `plaintext` to the currently-open conversation (see {@link openConversation}). */
  send(plaintext: string): Promise<void>;
  subscribe(listener: (event: ControllerEvent) => void): () => void;
  /** Current encryption-setup state (identity + device registration + connection). */
  getSetup(): SetupState;
  /** Subscribe to {@link SetupState} changes; fires immediately with the current state. */
  onSetupChange(listener: (state: SetupState) => void): () => void;
  /** Re-run encryption setup after a failure (e.g. transient network at sign-in). */
  retrySetup(): Promise<void>;
  /** Client-initiated sign-out (clears the auth session; Requirement 4.8). */
  signOut(): Promise<void>;
}

/** A short, collision-resistant client message id (no external uuid dependency). */
const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function createMobileController(): ChatController {
  const provider = new FirebaseAuthAdapter();
  const authService = new AuthService(provider);
  const httpClient = createReactNativeHttpClient();
  const directory: DirectoryClient = createDirectoryClient(
    httpClient,
    () => authService.getCurrentToken(),
    API_BASE_URL,
  );

  const listeners = new Set<(event: ControllerEvent) => void>();
  const emit = (event: ControllerEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  // Live messaging stack, created on sign-in and torn down on sign-out.
  let keyStore: KeyStore | null = null;
  let messaging: Messaging | null = null;
  let realtime: RealtimeClient | null = null;
  let activeRecipient: string | null = null;
  let currentUid: string | null = null;

  // Encryption-setup state, observable by the UI.
  let setup: SetupState = { phase: 'idle' };
  const setupListeners = new Set<(state: SetupState) => void>();
  const setSetup = (next: SetupState): void => {
    setup = next;
    for (const listener of setupListeners) {
      listener(setup);
    }
  };

  /**
   * Bring up the encrypted-messaging stack for a signed-in user: generate/load the device
   * identity, register the device, then wire SessionManager + Messaging over the realtime
   * client and connect. Failures here are surfaced as a disconnected status and degraded
   * sends rather than thrown — the user stays signed in.
   */
  async function bootstrap(uid: string): Promise<void> {
    setSetup({ phase: 'registering' });
    const store = createInMemoryKeyStore();
    keyStore = store;

    const identityManager = new DefaultIdentityManager(store, createPureTsLibsignalKeyGen());
    await identityManager.ensureIdentity(uid);

    const registrar = new DefaultDeviceRegistrar(
      { httpClient, keyStore: store, identityManager, auth: authService, backoff: new BackoffPolicy() },
      { registerUrl: REGISTER_URL },
    );
    const registration = await registrar.ensureRegistered();
    if (registration.status !== 'registered') {
      // Without a deviceId the client cannot be addressed or discovered. Surface WHY so the
      // user sees it and can retry, instead of silently failing every lookup/send.
      setSetup({ phase: 'failed', error: `Device registration failed (${registration.status}).` });
      emit({ type: 'connection-changed', connection: 'disconnected' });
      return;
    }

    const record = await store.loadIdentity(uid);
    if (record === null) {
      setSetup({ phase: 'failed', error: 'Identity could not be loaded after registration.' });
      emit({ type: 'connection-changed', connection: 'disconnected' });
      return;
    }
    const signalStore = signalStoreFromIdentity(record);

    realtime = new RealtimeClient({
      url: WS_URL,
      transport: createReactNativeWebSocketTransport(),
      auth: authService,
    });

    messaging = createMessaging(
      {
        realtime,
        sessions: createSessionManager(signalStore, createPureTsLibsignalEngine()),
        sequence: new KeyStoreSequenceAllocator(store),
        codec: createEnvelopeCodec(),
        keyClaimer: createPreKeyClaimClient(httpClient, () => authService.getCurrentToken(), API_BASE_URL),
        sender: {
          resolveSender: async () => {
            const deviceId = await store.loadDeviceId();
            const senderUid = authService.getCurrentUid();
            return deviceId !== null && senderUid !== null
              ? { uid: senderUid, deviceId }
              : null;
          },
        },
        store,
      },
      { generateId: newId },
    );

    messaging.onConversationUpdate(emit);
    realtime.onStatus((status) => emit({ type: 'connection-changed', connection: status }));
    realtime.connect();
    setSetup({ phase: 'ready' });
  }

  /** Run {@link bootstrap}, mapping any thrown error onto a visible `failed` setup state. */
  async function runBootstrap(uid: string): Promise<void> {
    try {
      await bootstrap(uid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSetup({ phase: 'failed', error: message });
      emit({ type: 'connection-changed', connection: 'disconnected' });
    }
  }

  function teardown(): void {
    messaging?.dispose();
    realtime?.disconnect();
    keyStore?.destroy();
    messaging = null;
    realtime = null;
    keyStore = null;
    activeRecipient = null;
  }

  return {
    async requestOtp(e164: string): Promise<RequestOtpResult> {
      const result = await authService.requestOtp(e164);
      return { ok: result.ok, error: result.error };
    },

    async confirmOtp(code: string): Promise<string | null> {
      try {
        const { uid } = await authService.confirmOtp(code);
        currentUid = uid;
        // Bring up messaging in the background; sign-in itself succeeds immediately so the
        // UI can advance. Setup progress/failure flows back through onSetupChange.
        void runBootstrap(uid);
        return uid;
      } catch {
        return null;
      }
    },

    async resolveContact(e164: string): Promise<ResolveContactResult> {
      try {
        const uid = await directory.resolve(e164);
        return uid !== null
          ? { ok: true, uid }
          : { ok: false, error: 'No Lumin user is registered with that phone number.' };
      } catch {
        return { ok: false, error: 'Could not reach the directory. Check your connection.' };
      }
    },

    openConversation(recipientUid: string): void {
      activeRecipient = recipientUid;
    },

    async send(plaintext: string): Promise<void> {
      if (messaging === null || activeRecipient === null) {
        return;
      }
      await messaging.send(activeRecipient, plaintext);
    },

    subscribe(listener: (event: ControllerEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSetup(): SetupState {
      return setup;
    },

    onSetupChange(listener: (state: SetupState) => void): () => void {
      setupListeners.add(listener);
      listener(setup);
      return () => setupListeners.delete(listener);
    },

    async retrySetup(): Promise<void> {
      if (setup.phase === 'registering') {
        return;
      }
      const uid = authService.getCurrentUid() ?? currentUid;
      if (uid === null) {
        setSetup({ phase: 'failed', error: 'Not signed in.' });
        return;
      }
      teardown();
      currentUid = uid;
      await runBootstrap(uid);
    },

    async signOut(): Promise<void> {
      teardown();
      setSetup({ phase: 'idle' });
      currentUid = null;
      await authService.signOut();
    },
  };
}

export function createDemoController(): ChatController {
  const listeners = new Set<(event: ControllerEvent) => void>();
  return {
    async requestOtp(e164: string): Promise<RequestOtpResult> {
      return { ok: /^\+[1-9]\d{6,14}$/.test(e164) };
    },
    async confirmOtp(code: string): Promise<string | null> {
      return /^\d{6}$/.test(code) ? `demo:${code}` : null;
    },
    async resolveContact(e164: string): Promise<ResolveContactResult> {
      return { ok: true, uid: `demo:${e164}` };
    },
    openConversation(): void {
      // No transport in the demo controller.
    },
    async send(): Promise<void> {
      // No transport in the demo controller; the container's optimistic append is the
      // only visible effect.
    },
    subscribe(listener: (event: ControllerEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSetup(): SetupState {
      return { phase: 'ready' };
    },
    onSetupChange(listener: (state: SetupState) => void): () => void {
      listener({ phase: 'ready' });
      return () => undefined;
    },
    async retrySetup(): Promise<void> {
      // Demo controller is always "ready".
    },
    async signOut(): Promise<void> {
      // Demo controller holds no real auth session.
    },
  };
}
