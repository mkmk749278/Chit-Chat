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
import type { WhoAmIResponse } from '@chat-app/types';

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
  | { ok: true; uid: string; displayName: string | null }
  | { ok: false; error: string };

export interface ChatController {
  requestOtp(e164: string): Promise<RequestOtpResult>;
  /** Confirm the OTP. `e164` is the number the code was sent to (stored as a discovery fallback). */
  confirmOtp(code: string, e164: string): Promise<string | null>;
  /** Resolve an E.164 phone number to a recipient UID via the backend directory. */
  resolveContact(e164: string): Promise<ResolveContactResult>;
  /** Set the signed-in user's display name (shown to peers); called after onboarding. */
  setDisplayName(displayName: string): Promise<void>;
  /** Set the conversation that subsequent {@link ChatController.send} calls target. */
  openConversation(recipientUid: string): void;
  /** Send `plaintext` to the currently-open conversation (see {@link openConversation}). */
  send(plaintext: string): Promise<void>;
  subscribe(listener: (event: ControllerEvent) => void): () => void;
  /**
   * Subscribe to sign-in state. Fires with the signed-in UID when Firebase restores a
   * persisted session on launch (so the app skips the Sign_In_Screen) or after a fresh
   * sign-in, and with `null` on sign-out. Bootstrapping is triggered automatically.
   */
  onAuthStateChanged(listener: (uid: string | null) => void): () => void;
  /** Current encryption-setup state (identity + device registration + connection). */
  getSetup(): SetupState;
  /** Subscribe to {@link SetupState} changes; fires immediately with the current state. */
  onSetupChange(listener: (state: SetupState) => void): () => void;
  /** Re-run encryption setup after a failure (e.g. transient network at sign-in). */
  retrySetup(): Promise<void>;
  /** The server-issued device id once registered, else `null` (diagnostics). */
  getDeviceId(): string | null;
  /** The signed-in user's Firebase UID, else `null` (diagnostics). */
  getUid(): string | null;
  /** Diagnostic: the caller's own discovery state from the server (token vs stored phone). */
  whoAmI(): Promise<WhoAmIResponse | null>;
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
  let currentPhone: string | null = null;
  let deviceId: string | null = null;

  // Encryption-setup state, observable by the UI.
  let setup: SetupState = { phase: 'idle' };
  const setupListeners = new Set<(state: SetupState) => void>();
  const setSetup = (next: SetupState): void => {
    setup = next;
    for (const listener of setupListeners) {
      listener(setup);
    }
  };

  // Sign-in state, observable by the UI. `bootstrappedUid` dedupes bootstrap so a fresh
  // sign-in and the auth-state restore that follows it don't both run it.
  let bootstrappedUid: string | null = null;
  const authListeners = new Set<(uid: string | null) => void>();
  const notifyAuth = (uid: string | null): void => {
    for (const listener of authListeners) {
      listener(uid);
    }
  };

  /** Bootstrap once per signed-in uid (idempotent across the sign-in and restore paths). */
  function ensureBootstrapped(uid: string): void {
    if (bootstrappedUid === uid) {
      return;
    }
    bootstrappedUid = uid;
    currentUid = uid;
    void runBootstrap(uid);
  }

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
      // Send the signed-in number so the server can record it for discovery as a fallback
      // when the token has no phone claim (the server prefers the verified token phone).
      { registerUrl: REGISTER_URL, ...(currentPhone !== null ? { phoneNumber: currentPhone } : {}) },
    );
    const registration = await registrar.ensureRegistered();
    if (registration.status !== 'registered') {
      // Without a deviceId the client cannot be addressed or discovered. Surface WHY so the
      // user sees it and can retry, instead of silently failing every lookup/send.
      setSetup({ phase: 'failed', error: `Device registration failed (${registration.status}).` });
      emit({ type: 'connection-changed', connection: 'disconnected' });
      return;
    }
    deviceId = registration.deviceId;

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

  // Restore a persisted Firebase session on launch (and react to fresh sign-in / sign-out).
  // Firebase persists auth across an app kill, so this fires with the signed-in user shortly
  // after launch — bootstrapping and surfacing the uid so the UI skips the Sign_In_Screen.
  authService.onAuthStateChanged((state) => {
    if (state.status === 'signed-in') {
      ensureBootstrapped(state.uid);
      notifyAuth(state.uid);
    } else {
      bootstrappedUid = null;
      notifyAuth(null);
    }
  });

  return {
    async requestOtp(e164: string): Promise<RequestOtpResult> {
      const result = await authService.requestOtp(e164);
      return { ok: result.ok, error: result.error };
    },

    async confirmOtp(code: string, e164: string): Promise<string | null> {
      // Remember the OTP-verified number BEFORE the auth-state listener fires, so the
      // bootstrap it triggers can send it as a discovery fallback (used only if the token
      // has no phone claim).
      currentPhone = e164;
      try {
        const { uid } = await authService.confirmOtp(code);
        // The auth-state listener bootstraps on sign-in; ensure it's running even if that
        // event is delivered asynchronously, deduped so it never runs twice.
        ensureBootstrapped(uid);
        return uid;
      } catch {
        return null;
      }
    },

    async resolveContact(e164: string): Promise<ResolveContactResult> {
      try {
        const { status, user } = await directory.resolve(e164);
        if (user !== null) {
          return { ok: true, uid: user.uid, displayName: user.displayName };
        }
        // Surface the HTTP status so a discovery miss is diagnosable: 404 = not registered,
        // 429 = rate-limited, 401 = auth, 400 = bad format, 0 = not signed in / offline.
        const reason =
          status === 404
            ? 'No Lumin user is registered with that number.'
            : status === 0
              ? 'Not signed in or offline.'
              : `Lookup failed (HTTP ${status}).`;
        return { ok: false, error: reason };
      } catch {
        return { ok: false, error: 'Could not reach the directory. Check your connection.' };
      }
    },

    async setDisplayName(displayName: string): Promise<void> {
      try {
        await directory.setProfile(displayName);
      } catch {
        // Non-fatal: the name is a display nicety; failure leaves the peer showing as a UID.
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

    onAuthStateChanged(listener: (uid: string | null) => void): () => void {
      authListeners.add(listener);
      // Fire immediately with the current known state so a late subscriber isn't stuck.
      listener(authService.getCurrentUid());
      return () => authListeners.delete(listener);
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

    getDeviceId(): string | null {
      return deviceId;
    },

    getUid(): string | null {
      return authService.getCurrentUid() ?? currentUid;
    },

    async whoAmI(): Promise<WhoAmIResponse | null> {
      try {
        return await directory.whoAmI();
      } catch {
        return null;
      }
    },

    async signOut(): Promise<void> {
      teardown();
      deviceId = null;
      bootstrappedUid = null;
      setSetup({ phase: 'idle' });
      currentUid = null;
      currentPhone = null;
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
    async confirmOtp(code: string, _e164: string): Promise<string | null> {
      return /^\d{6}$/.test(code) ? `demo:${code}` : null;
    },
    async resolveContact(e164: string): Promise<ResolveContactResult> {
      return { ok: true, uid: `demo:${e164}`, displayName: null };
    },
    async setDisplayName(): Promise<void> {
      // Demo controller has no backend profile.
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
    onAuthStateChanged(): () => void {
      return () => undefined;
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
    getDeviceId(): string | null {
      return 'demo-device';
    },
    getUid(): string | null {
      return 'demo-uid';
    },
    async whoAmI(): Promise<WhoAmIResponse | null> {
      return {
        uid: 'demo-uid',
        displayName: 'Demo',
        tokenPhone: '+910000000000',
        storedPhone: '+910000000000',
        deviceCount: 1,
        selfLookup: 'ok:demo-uid',
      };
    },
    async signOut(): Promise<void> {
      // Demo controller holds no real auth session.
    },
  };
}
