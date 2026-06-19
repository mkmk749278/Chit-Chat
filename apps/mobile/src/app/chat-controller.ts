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
 * Storage: identity/sessions/messages live in a persistent, encrypted-at-rest KeyStore
 * (`createNativeVault` → AES-256-CBC+HMAC blob in AsyncStorage, key in the hardware-backed
 * Keystore via expo-secure-store). The device therefore registers ONCE and reuses its
 * identity across launches, instead of re-registering each launch — which removes the device
 * churn that caused encrypted messages to be delivered to a stale device and never decrypted.
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
  initialConversationState,
  KeyStoreSequenceAllocator,
  reduce,
  RealtimeClient,
  type ConversationEvent,
  type ConversationState,
  type KeyStore,
  type MessageTarget,
  type Messaging,
  type RegistrationResult,
  type SafetyNumber,
  type SessionManager,
  type VerificationEvent,
  type VerificationResponseKind,
} from '@chat-app/crypto';
import type { PresenceResponse, WhoAmIResponse } from '@chat-app/types';

import { FirebaseAuthAdapter } from '../auth';
import { API_BASE_URL, REGISTER_URL, WS_URL } from '../api/api-config';
import { createDirectoryClient, createPreKeyClaimClient, type DirectoryClient } from '../api/api-clients';
import { createNativeVault, probeNativeCrypto } from '../crypto/native-vault';
import {
  createPersistentKeyStore,
  createPersistentSignalProtocolStore,
  type PersistentVault,
} from '../crypto/persistent-store';
import { signalStoreFromIdentity } from '../crypto/signal-store';
import { clearDisplayName, loadDisplayName, saveDisplayName } from './profile-store';
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

/**
 * A conversation reconstructed from persisted on-device history for relaunch rehydration
 * (Phase 2 CC4). `state` is a fully-reduced {@link ConversationState} (so the UI renders it
 * exactly like a live one); `lastAt` is the newest message's timestamp for list ordering.
 */
export interface RehydratedConversation {
  /** The peer's Firebase UID (the conversation key). */
  id: string;
  /** Newest message timestamp (unix ms) for chat-list ordering. */
  lastAt: number;
  /** The reduced render state, ready to hand to the Conversation_Screen. */
  state: ConversationState;
}

export interface ChatController {
  requestOtp(e164: string): Promise<RequestOtpResult>;
  /** Confirm the OTP. `e164` is the number the code was sent to (stored as a discovery fallback). */
  confirmOtp(code: string, e164: string): Promise<string | null>;
  /** Resolve an E.164 phone number to a recipient UID via the backend directory. */
  resolveContact(e164: string): Promise<ResolveContactResult>;
  /**
   * Resolve a peer's display name from their Firebase UID (reverse directory lookup). Returns
   * `null` when unknown/offline so callers fall back to the UID. Used to name an inbound sender
   * the user never started a chat with (so the conversation header shows a name, not a raw UID).
   */
  resolvePeerName(uid: string): Promise<string | null>;
  /** Set the signed-in user's display name (shown to peers); called after onboarding. */
  setDisplayName(displayName: string): Promise<void>;
  /**
   * The display name remembered for the signed-in user, read from durable on-device storage
   * (falling back to the backend profile). `null` when none is known yet — the only case in
   * which onboarding should prompt for a name. Independent of encryption setup, so a returning
   * user skips onboarding even when the encrypted stack or backend is unavailable.
   */
  loadDisplayName(): Promise<string | null>;
  /** Set the conversation that subsequent {@link ChatController.send} calls target. */
  openConversation(recipientUid: string): void;
  /** Send `plaintext` to the currently-open conversation (see {@link openConversation}). */
  send(plaintext: string, options?: { viewOnce?: boolean }): Promise<void>;
  /**
   * Mark a view-once message as displayed: purge it from the store and remove it from the UI so
   * it cannot be re-opened (Req 4.3). `id` is the message's stable row id.
   */
  markViewed(id: string): Promise<void>;
  /** React to a message in the open conversation with an emoji (Req 3.1). */
  react(target: MessageTarget, emoji: string): Promise<void>;
  /** Edit a message's text in the open conversation (Req 3.2). */
  editMessage(target: MessageTarget, body: string): Promise<void>;
  /** Delete (tombstone) a message in the open conversation (Req 3.3). */
  deleteMessage(target: MessageTarget): Promise<void>;
  /** Set the open conversation's disappearing-message timer; `0` disables it (Req 4.1). */
  setDisappearingTimer(ttlMs: number): Promise<void>;
  /**
   * Notify the open conversation's peer that the user is typing (Req 5.3). Rate-limited
   * internally, so it is safe to call on every keystroke; ephemeral and never persisted.
   */
  sendTyping(): void;
  /** Subscribe to inbound typing hints; `fromUid` is the peer who is typing (Req 5.3). */
  onTyping(listener: (fromUid: string) => void): () => void;
  /** Read a peer's presence (online + coarse last-seen), or `null` if unavailable (Req 5.2). */
  getPresence(uid: string): Promise<PresenceResponse | null>;
  /** Set the signed-in user's presence opt-in (Req 5.1). */
  setPresenceEnabled(enabled: boolean): Promise<boolean>;
  /**
   * Compute the deterministic safety number for the open conversation, or `null` until a
   * message has been exchanged with the peer (so their identity key is known) (Req 1.1–1.3).
   */
  getSafetyNumber(recipientUid: string): Promise<SafetyNumber | null>;
  /**
   * Start an in-chat identity verification with the open conversation's peer (Signature Feature 2,
   * §4). Both apps derive the same rotating code from a freshly-shared session seed; the peer
   * answers via {@link respondVerification}. Session-scoped (resets on app lock/exit, §4.4).
   */
  requestVerification(): Promise<void>;
  /**
   * Answer a verification request from the open conversation's peer by submitting the current code
   * (§4.2). `kind: 'duress'` submits the duress code, which verifies identically to the requester
   * but also fires a silent alert to the configured trusted contact, if any (§4.3).
   */
  respondVerification(kind: VerificationResponseKind): Promise<void>;
  /**
   * Configure the trusted contact (recipient UID) that silent duress alerts are sent to (§4.2).
   * Held in memory for the session; `null` clears it.
   */
  setTrustedContact(uid: string | null): void;
  /** Subscribe to in-chat verification events driving the per-session badge + duress alerts (§4.3). */
  onVerification(listener: (event: VerificationEvent) => void): () => void;
  /**
   * Rehydrate every conversation from persisted on-device history (Phase 2 CC4), so chats
   * survive an app restart instead of starting empty. Returns an empty list before the
   * encrypted store is open.
   */
  loadConversations(): Promise<RehydratedConversation[]>;
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

/**
 * Turn a non-`registered` {@link RegistrationResult} into a human-readable setup-failure
 * message with a clear next step. Each outcome has a different cause and remedy, so collapsing
 * them into one opaque status word left the user (and support) unable to tell a server outage
 * apart from an expired session or a rejected payload.
 */
function describeRegistrationFailure(
  registration: Exclude<RegistrationResult, { status: 'registered' }>,
): string {
  switch (registration.status) {
    case 'service-unavailable':
      return "Couldn't reach the server to finish secure setup. Check your connection, then tap to retry.";
    case 'sign-in-required':
      return 'Your session expired before secure setup finished. Sign out and sign in again.';
    case 'invalid':
      return registration.field !== undefined
        ? `The server rejected device registration (field: ${registration.field}). Tap to retry.`
        : 'The server rejected device registration. Tap to retry.';
  }
}

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

  // Inbound typing hints (Req 5.3), surfaced separately from conversation events so the UI can
  // expire the indicator on its own timer.
  const typingListeners = new Set<(fromUid: string) => void>();
  const emitTyping = (fromUid: string): void => {
    for (const listener of typingListeners) {
      listener(fromUid);
    }
  };
  /** Throttle outbound typing hints to at most one per window (Req 5.3 rate-limit). */
  const TYPING_MIN_INTERVAL_MS = 3000;
  let lastTypingSentAt = 0;

  // In-chat identity verification (Signature Feature 2, §4), surfaced separately so the UI drives a
  // per-session badge. The trusted contact for duress alerts is held in RAM only (§4.2).
  const verificationListeners = new Set<(event: VerificationEvent) => void>();
  const emitVerification = (event: VerificationEvent): void => {
    for (const listener of verificationListeners) {
      listener(event);
    }
  };
  let trustedContactUid: string | null = null;

  // Live messaging stack, created on sign-in and torn down on sign-out.
  let vault: PersistentVault | null = null;
  let keyStore: KeyStore | null = null;
  let messaging: Messaging | null = null;
  let sessions: SessionManager | null = null;
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
    // Open the persistent, encrypted store for this user — reused across launches so the
    // device keeps one stable identity/deviceId (no re-registration churn). Guard it with a
    // crypto self-test. If the device's WebCrypto can't do the encrypted-at-rest round-trip we
    // must NOT silently fall back to an in-memory store: that regenerates the identity (and
    // re-registers a NEW device) on every launch, so a message queued for this user while they
    // were offline was encrypted to the PREVIOUS identity and can never be decrypted — the
    // recipient just sees "message unavailable / could not be decrypted". Surface a visible,
    // retryable setup failure instead of silently breaking delivery.
    let store: KeyStore;
    try {
      await probeNativeCrypto();
      vault = createNativeVault(uid);
      store = createPersistentKeyStore(vault);
    } catch (err) {
      vault = null;
      const reason = err instanceof Error ? err.message : 'secure storage unavailable';
      setSetup({
        phase: 'failed',
        error:
          'Secure on-device storage is unavailable, so encrypted messages can’t be kept ' +
          `readable across restarts (${reason}). Tap to retry.`,
      });
      emit({ type: 'connection-changed', connection: 'disconnected' });
      return;
    }
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
      // Without a deviceId the client cannot be addressed or discovered. Surface WHY in plain
      // language — each outcome needs a different action — instead of an opaque status word the
      // user can't act on.
      setSetup({ phase: 'failed', error: describeRegistrationFailure(registration) });
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
    const signalStore =
      vault !== null
        ? createPersistentSignalProtocolStore(vault, record)
        : signalStoreFromIdentity(record);

    realtime = new RealtimeClient({
      url: WS_URL,
      transport: createReactNativeWebSocketTransport(),
      auth: authService,
    });

    sessions = createSessionManager(signalStore, createPureTsLibsignalEngine());
    messaging = createMessaging(
      {
        realtime,
        sessions,
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
    messaging.onTyping(emitTyping);
    messaging.onVerification(emitVerification);
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
    // destroy() releases the store's in-memory state but RETAINS the encrypted blob, so a
    // retry/relaunch reuses the same identity. Explicit sign-out wipes via vault.wipe().
    keyStore?.destroy();
    messaging = null;
    sessions = null;
    realtime = null;
    keyStore = null;
    vault = null;
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
        }        // Surface the HTTP status so a discovery miss is diagnosable: 404 = not registered,
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

    async resolvePeerName(peerUid: string): Promise<string | null> {
      return directory.getProfile(peerUid);
    },

    async setDisplayName(displayName: string): Promise<void> {
      // Persist locally FIRST so the name survives a relaunch regardless of the backend —
      // this is what stops onboarding from re-prompting on every launch when the network or
      // encryption setup is failing.
      const uid = authService.getCurrentUid() ?? currentUid;
      if (uid !== null) {
        await saveDisplayName(uid, displayName);
      }
      try {
        await directory.setProfile(displayName);
      } catch {
        // Non-fatal: the backend copy is what peers discover; the local copy already keeps the
        // user out of onboarding. Failure here just leaves the peer showing as a UID.
      }
    },

    async loadDisplayName(): Promise<string | null> {
      const uid = authService.getCurrentUid() ?? currentUid;
      if (uid === null) {
        return null;
      }
      // Prefer the durable local copy (works offline / when setup failed); fall back to the
      // backend profile, re-persisting it locally so the next launch needs no network.
      const local = await loadDisplayName(uid);
      if (local !== null) {
        return local;
      }
      try {
        const me = await directory.whoAmI();
        const remote = me?.displayName ?? null;
        if (remote !== null && remote.length > 0) {
          await saveDisplayName(uid, remote);
          return remote;
        }
      } catch {
        // Offline or backend down: no remembered name to restore.
      }
      return null;
    },

    openConversation(recipientUid: string): void {
      activeRecipient = recipientUid;
    },

    async send(plaintext: string, options?: { viewOnce?: boolean }): Promise<void> {
      if (messaging === null || activeRecipient === null) {
        return;
      }
      await messaging.send(activeRecipient, plaintext, options);
    },

    async markViewed(id: string): Promise<void> {
      if (keyStore === null || activeRecipient === null) {
        return;
      }
      try {
        await keyStore.purgeMessages([id]);
      } catch {
        // A purge failure must not crash the UI; the message stays until a later relaunch.
      }
      emit({ type: 'messages-expired', ids: [id], remoteUid: activeRecipient });
    },

    async react(target: MessageTarget, emoji: string): Promise<void> {
      if (messaging === null || activeRecipient === null) {
        return;
      }
      await messaging.react(activeRecipient, target, emoji);
    },

    async editMessage(target: MessageTarget, body: string): Promise<void> {
      if (messaging === null || activeRecipient === null) {
        return;
      }
      await messaging.editMessage(activeRecipient, target, body);
    },

    async deleteMessage(target: MessageTarget): Promise<void> {
      if (messaging === null || activeRecipient === null) {
        return;
      }
      await messaging.deleteMessage(activeRecipient, target);
    },

    async setDisappearingTimer(ttlMs: number): Promise<void> {
      if (messaging === null || activeRecipient === null) {
        return;
      }
      await messaging.setDisappearingTimer(activeRecipient, ttlMs);
    },

    sendTyping(): void {
      if (messaging === null || activeRecipient === null) {
        return;
      }
      const now = Date.now();
      if (now - lastTypingSentAt < TYPING_MIN_INTERVAL_MS) {
        return;
      }
      lastTypingSentAt = now;
      messaging.sendTyping(activeRecipient);
    },

    onTyping(listener: (fromUid: string) => void): () => void {
      typingListeners.add(listener);
      return () => typingListeners.delete(listener);
    },

    async getPresence(uid: string): Promise<PresenceResponse | null> {
      return directory.getPresence(uid);
    },

    async setPresenceEnabled(enabled: boolean): Promise<boolean> {
      return directory.setPresence(enabled);
    },

    async getSafetyNumber(recipientUid: string): Promise<SafetyNumber | null> {
      const localUid = authService.getCurrentUid() ?? currentUid;
      if (sessions === null || localUid === null) {
        return null;
      }
      try {
        return await sessions.getSafetyNumber(localUid, recipientUid);
      } catch {
        return null;
      }
    },

    async requestVerification(): Promise<void> {
      if (messaging === null || activeRecipient === null) {
        return;
      }
      await messaging.requestVerification(activeRecipient);
    },

    async respondVerification(kind: VerificationResponseKind): Promise<void> {
      if (messaging === null || activeRecipient === null) {
        return;
      }
      await messaging.respondVerification(activeRecipient, kind, trustedContactUid ?? undefined);
    },

    setTrustedContact(uid: string | null): void {
      trustedContactUid = uid;
    },

    onVerification(listener: (event: VerificationEvent) => void): () => void {
      verificationListeners.add(listener);
      return () => verificationListeners.delete(listener);
    },

    async loadConversations(): Promise<RehydratedConversation[]> {
      if (keyStore === null) {
        return [];
      }
      let rows;
      let timers: Record<string, number>;
      try {
        rows = await keyStore.loadMessages();
        timers = await keyStore.loadConversationTimers();
      } catch {
        return [];
      }
      // Group persisted rows by peer, then replay them through the shared reducer so the
      // rehydrated state is byte-for-byte what a live session would have produced (Req 6.7).
      const byPeer = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = byPeer.get(row.remoteUid) ?? [];
        list.push(row);
        byPeer.set(row.remoteUid, list);
      }
      const now = Date.now();
      const conversations: RehydratedConversation[] = [];
      for (const [peerUid, peerRows] of byPeer) {
        let state = initialConversationState('mobile');
        let lastAt = 0;
        // Apply oldest-first so ordering/gap detection matches live arrival semantics.
        for (const row of [...peerRows].sort((a, b) => a.createdAt - b.createdAt)) {
          // Skip disappearing messages already past expiry — Messaging.initPurgeSchedule erases
          // them from the store on launch; don't flash them in the UI first (Req 4.2).
          if (row.expiresAt !== undefined && Number.isFinite(row.expiresAt) && now >= row.expiresAt) {
            continue;
          }
          lastAt = Math.max(lastAt, row.createdAt);
          // A row still `sending` at relaunch never got its server ack (the ack timer died
          // with the previous process), so surface it as `failed` — text retained — rather
          // than a spinner that can never resolve.
          const status = row.status === 'sending' ? 'failed' : row.status;
          const event: ConversationEvent =
            row.direction === 'in' && row.plaintext === null && status === 'delivery-error'
              ? { type: 'inbound-delivery-error', id: row.id, seq: row.seq, remoteUid: peerUid }
              : {
                  type: 'message-appended',
                  message: {
                    id: row.id,
                    seq: row.seq,
                    direction: row.direction,
                    text: row.plaintext,
                    status,
                    // Persisted reaction/edit/delete state, so those survive a relaunch too.
                    ...(row.reactions !== undefined ? { reactions: row.reactions } : {}),
                    ...(row.edited === true ? { edited: true } : {}),
                    ...(row.deleted === true ? { deleted: true } : {}),
                  },
                  remoteUid: peerUid,
                };
          state = reduce(state, event);
        }
        // Rehydrate the per-conversation disappearing-message timer (Req 4.1) and seed it into
        // Messaging (without re-notifying the peer) so messages sent this session expire too.
        const ttlMs = timers[peerUid] ?? 0;
        if (ttlMs > 0) {
          state = reduce(state, { type: 'timer-changed', ttlMs, remoteUid: peerUid });
          messaging?.primeConversationTtl(peerUid, ttlMs);
        }
        conversations.push({ id: peerUid, lastAt, state });
      }
      return conversations;
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
      // Wipe the encrypted on-device store (identity, sessions, messages) before teardown
      // clears the reference — explicit sign-out forgets this device (Requirement 7.4).
      try {
        await vault?.wipe();
      } catch {
        // A wipe failure must not block sign-out; the auth session is still cleared below.
      }
      // Forget the locally-remembered display name too, so the next account on this device
      // starts at onboarding rather than inheriting a stale name.
      const signedOutUid = authService.getCurrentUid() ?? currentUid;
      if (signedOutUid !== null) {
        await clearDisplayName(signedOutUid);
      }
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
    async resolvePeerName(): Promise<string | null> {
      return null;
    },
    async setDisplayName(): Promise<void> {
      // Demo controller has no backend profile.
    },
    async loadDisplayName(): Promise<string | null> {
      // Demo controller does not persist a profile; always onboard.
      return null;
    },
    openConversation(): void {
      // No transport in the demo controller.
    },
    async send(): Promise<void> {
      // No transport in the demo controller; the container's optimistic append is the
      // only visible effect.
    },
    async markViewed(): Promise<void> {
      // No store in the demo controller.
    },
    async react(): Promise<void> {
      // No transport in the demo controller.
    },
    async editMessage(): Promise<void> {
      // No transport in the demo controller.
    },
    async deleteMessage(): Promise<void> {
      // No transport in the demo controller.
    },
    async setDisappearingTimer(): Promise<void> {
      // No transport in the demo controller.
    },
    sendTyping(): void {
      // No transport in the demo controller.
    },
    onTyping(): () => void {
      return () => undefined;
    },
    async getPresence(): Promise<PresenceResponse | null> {
      return null;
    },
    async setPresenceEnabled(): Promise<boolean> {
      return false;
    },
    async getSafetyNumber(): Promise<SafetyNumber | null> {
      return null;
    },
    async requestVerification(): Promise<void> {
      // No transport in the demo controller.
    },
    async respondVerification(): Promise<void> {
      // No transport in the demo controller.
    },
    setTrustedContact(): void {
      // No transport in the demo controller.
    },
    onVerification(): () => void {
      return () => undefined;
    },
    async loadConversations(): Promise<RehydratedConversation[]> {
      return [];
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
        presenceEnabled: false,
      };
    },
    async signOut(): Promise<void> {
      // Demo controller holds no real auth session.
    },
  };
}
