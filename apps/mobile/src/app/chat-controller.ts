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
  createConversationRegistry,
  createEnvelopeCodec,
  createMessaging,
  createPureTsLibsignalEngine,
  createPureTsLibsignalKeyGen,
  createSessionManager,
  DefaultDeviceRegistrar,
  DefaultIdentityManager,
  KeyStoreSequenceAllocator,
  partitionPersistedRows,
  reduce,
  reduceRowsToState,
  RealtimeClient,
  ShadowSecretStore,
  ShadowSequenceAllocator,
  type AppMode,
  type ConversationEvent,
  type ConversationState,
  type KeyStore,
  type MessageTarget,
  type Messaging,
  type OutgoingAttachment,
  type RecipientRouting,
  type RegistrationResult,
  type RowThreadAssociation,
  type SafetyNumber,
  type SessionManager,
  type ShadowInviteCoordinator,
  type ShadowInviteEvent,
  type ShadowSecretPersistence,
  type VerificationEvent,
  type VerificationResponseKind,
} from '@chat-app/crypto';
import type { PresenceResponse, WhoAmIResponse } from '@chat-app/types';

import { FirebaseAuthAdapter } from '../auth';
import { API_BASE_URL, REGISTER_URL, WS_URL } from '../api/api-config';
import {
  createBlobStore,
  createDirectoryClient,
  createPreKeyClaimClient,
  createPushTokenClient,
  type DirectoryClient,
} from '../api/api-clients';
import { createFirebasePushPlatform } from '../push/firebase-push-platform';
import {
  registerPushToken,
  revokePushToken,
  type PushRegistrationDeps,
} from '../push/push-registration';
import { clearConversationHistory } from './clear-chat';
import { createNativeVault, probeNativeCrypto } from '../crypto/native-vault';
import { createExpoBiometricAttestor } from '../crypto/expo-biometric-attestor';
import { createVaultBiometricEnrollment } from '../data/biometric-enrollment';
import { createSecureGate, type RevealResult, type SecureGate, type UnlockResult } from './secure-gate';
import { createVaultShadowSecretPersistence } from '../data/shadow-secret-persistence';
import { createVaultRowThreadAssociation } from '../data/row-thread-association';
import { buildShadowInviteCoordinator } from './shadow-invite-wiring';
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

/**
 * A SHADOW thread reconstructed from persisted on-device history for relaunch rehydration (Shadow
 * Chat, Req 7 + 14). Keyed by its server-opaque `threadId` and carrying the resolved `peerUid` so the
 * UI can reopen the thread in its render registry (restoring inbound routing) and add it under the
 * right contact — without which a restart loses the thread's history and drops post-restart inbound
 * shadow messages as "unknown thread" (Req 7.8). Only returned in real mode (decoy/locked reveal none).
 */
export interface RehydratedShadowConversation {
  /** The server-opaque shadow thread id (the render-registry key `shadow:${threadId}`). */
  threadId: string;
  /** The contact this shadow thread is with. */
  peerUid: string;
  /** Newest message timestamp (unix ms) for chat-list ordering. */
  lastAt: number;
  /** The reduced render state, ready to hand to the Conversation_Screen. */
  state: ConversationState;
}

/**
 * A lightweight reference to one of the user's active shadow chats, for the real-mode shadow-chat
 * manager (so it can be cleared/revoked without first reopening it via its `/alias`). Carries only
 * the routing ids; the display name is resolved separately via {@link ChatController.resolvePeerName}.
 */
export interface ShadowChatRef {
  /** The server-opaque shadow thread id. */
  threadId: string;
  /** The contact this shadow thread is with. */
  peerUid: string;
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
  send(plaintext: string, options?: { viewOnce?: boolean; threadId?: string }): Promise<void>;
  /**
   * Send an end-to-end encrypted attachment (e.g. a photo) to the currently-open conversation (Req
   * 7). The decrypted bytes are encrypted locally under a fresh per-attachment key and only the
   * ciphertext is uploaded to the blob store; the key rides the E2E payload. Optimistically renders a
   * `sending` row like {@link send} and never throws for an expected delivery problem (offline,
   * upload failure) — those surface as a `failed` message. Pass `options.threadId` to route into the
   * open shadow thread (mirrors {@link send}); absent ⇒ surface chat.
   */
  sendAttachment(content: OutgoingAttachment, options?: { threadId?: string }): Promise<void>;
  /**
   * Mark a view-once message as displayed: purge it from the store and remove it from the UI so
   * it cannot be re-opened (Req 4.3). `id` is the message's stable row id.
   */
  markViewed(id: string): Promise<void>;
  /**
   * Clear a SURFACE conversation's LOCAL history (the "Clear chat" action): purge every persisted
   * row belonging to `conversationId` (rows whose `remoteUid === conversationId`) via the store's
   * best-effort secure erase. Local-only — no network, no wire change — and fail-soft on a store
   * error. The conversation is NOT deleted; the caller dispatches `conversation-cleared` to reset the
   * open view to empty. Surface chats only; shadow threads are not cleared here.
   */
  clearChatHistory(conversationId: string): Promise<void>;
  /** React to a message in the open conversation with an emoji (Req 3.1). */
  react(target: MessageTarget, emoji: string): Promise<void>;
  /** Edit a message's text in the open conversation (Req 3.2). */
  editMessage(target: MessageTarget, body: string): Promise<void>;
  /** Delete (tombstone) a message in the open conversation (Req 3.3). */
  deleteMessage(target: MessageTarget): Promise<void>;
  /** Re-send a previously failed outbound message in the open conversation (P1 #5 retry). */
  retryMessage(target: MessageTarget, options?: { threadId?: string }): Promise<void>;
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
   * Enrol this device for biometric presence attestation with the open conversation's peer
   * (Signature Feature 2b, §4.5): publish this device's public attestation key so the peer can later
   * verify our live-biometric proofs. Resolves `true` when shared, `false` when this device has no
   * usable biometric. Both sides should enrol once before {@link requestBiometricVerification}.
   */
  enrollBiometric(): Promise<boolean>;
  /**
   * Begin a biometric presence verification of the open conversation's peer (Signature Feature 2b,
   * §4.5): challenge their device to prove the real owner is present via a live biometric. The
   * outcome arrives as a `bioverify-result` {@link VerificationEvent}. Resolves `false` (sending
   * nothing) when the peer has not enrolled a public attestation key on this device yet.
   */
  requestBiometricVerification(): Promise<boolean>;
  /**
   * Whether the open conversation's peer has a PUBLIC attestation key persisted on this device
   * (Signature Feature 2b, §4.5), i.e. they enrolled in a previous session. Lets the UI re-enable
   * "verify presence" after a relaunch even though the in-RAM badge has reset. `false` when no
   * conversation is open or no peer key is stored.
   */
  isPeerBiometricEnrolled(): Promise<boolean>;
  /**
   * Whether a real app PIN is configured, so the shell should present the lock screen on launch
   * (Signature Feature 4, §6). `false` when no PIN is set or the encrypted vault is unavailable.
   */
  hasAppPin(): Promise<boolean>;
  /** Whether a decoy PIN is configured (§6). */
  hasDecoyPin(): Promise<boolean>;
  /** Set/replace the real or decoy app PIN, stored as a salted verifier (§6.2). */
  setAppPin(pin: string, kind: 'real' | 'decoy'): Promise<void>;
  /** Remove the real or decoy app PIN (§6). */
  clearAppPin(kind: 'real' | 'decoy'): Promise<void>;
  /** Attempt to unlock the app; resolves the real/decoy mode, a lockout, or an invalid result (§6). */
  unlockApp(pin: string): Promise<UnlockResult>;
  /** Mark a chat hidden behind its own unlock secret (Signature Feature 1, §3.1). */
  hideChat(peerUid: string, secret: string): Promise<void>;
  /** Remove a chat's hidden status (from within the revealed chat, §3.3). */
  unhideChat(peerUid: string): Promise<void>;
  /** The peer uids of currently-hidden chats, so the chat list can exclude them (§3.1). */
  listHiddenPeers(): Promise<string[]>;
  /** Reveal the single hidden chat whose secret matches `secret`, honouring the lockout (§3.1). */
  revealHiddenChat(secret: string): Promise<RevealResult>;
  /**
   * Rehydrate every conversation from persisted on-device history (Phase 2 CC4), so chats
   * survive an app restart instead of starting empty. Returns an empty list before the
   * encrypted store is open.
   */
  loadConversations(): Promise<RehydratedConversation[]>;
  /**
   * Rehydrate every persisted SHADOW thread on relaunch (Shadow Chat, Req 7 + 14) so a shadow chat's
   * history survives a restart and its thread can be reopened in the render registry (restoring
   * inbound routing). Real-mode gated: returns an empty list in decoy/locked mode, revealing nothing
   * (design Correctness Properties 6, 16), and before the encrypted store is open.
   */
  loadShadowConversations(): Promise<RehydratedShadowConversation[]>;
  /**
   * List the user's active shadow chats (Shadow Chat Invites, Req 6/7) for the real-mode shadow-chat
   * manager, so each can be cleared or revoked WITHOUT first reopening it via its `/alias`. Real-mode
   * gated: returns an empty list in decoy/locked mode, revealing nothing (Correctness Properties 6, 16).
   */
  listShadowChats(): Promise<ShadowChatRef[]>;
  /**
   * The device-local, real-PIN-gated {@link ShadowSecretStore} for Shadow Chat, backed by the
   * encrypted on-device vault so its master secret, alias key, and alias→thread mappings survive
   * app restarts (Requirements 9.8, 9.9). `null` before the encrypted store is open (e.g. setup
   * still running) or when the controller has no vault. Provisioned during bootstrap on launch.
   */
  getShadowSecretStore(): ShadowSecretStore | null;
  /**
   * Ensure the device-local shadow secrets (the Master_Secret and the Alias_Key) exist so a shadow
   * chat can actually be bound (Shadow Chat, Requirement 11.6). The long-press creation flow calls
   * this in App_Mode `real` immediately before {@link ShadowSecretStore.bindAlias}: `bindAlias`
   * derives the thread id from `{ masterSecret, aliasKey }` and binds NOTHING when they are absent,
   * so the very first shadow chat on a device needs the secrets provisioned once. When neither
   * secret is present this generates a fresh 32-byte CSPRNG Master_Secret and a fresh 32-byte
   * Alias_Key and persists them DURABLY through the same encrypted vault the store reads from
   * (Requirements 9.1, 9.5, 9.8) — never to any network endpoint — so they survive restarts and a
   * later `/alias` re-resolves to the same thread. Idempotent: a no-op once provisioned. Returns
   * `false` (provisioning nothing) when the encrypted store is not yet open. The caller MUST only
   * invoke it in real mode; it performs no App_Mode check of its own (the secrets are still
   * release-gated behind real mode by {@link ShadowSecretStore}).
   */
  provisionShadowContext(): Promise<boolean>;
  /**
   * Shadow Chat Invites (design Component A). Create + send a shadow-chat invite to `peerUid` over the
   * existing E2E channel; returns the new (already-converged) `threadId` + `inviteId`, or `null` in
   * decoy/locked mode (release nothing, send nothing). `alias` is an optional local handle; `pin` an
   * optional per-chat PIN. Never disturbs the inviter's surface chat.
   */
  createShadowInvite(
    peerUid: string,
    alias?: string,
    pin?: string,
  ): Promise<{ inviteId: string; threadId: string } | null>;
  /**
   * Accept an inbound shadow invite with a routing choice — `'hidden'` (default: a hidden shadow
   * thread) or `'merge'` (surface it in the main chat, view-only). Returns true on success, false in
   * decoy/locked mode or for an unknown invite. The routing choice stays local to this device.
   */
  acceptShadowInvite(
    inviteId: string,
    routing: RecipientRouting,
    alias?: string,
    pin?: string,
  ): Promise<string | null>;
  /** Decline an inbound shadow invite; persists no shadow data and auto-removes the request card. */
  declineShadowInvite(inviteId: string): Promise<void>;
  /**
   * Revoke a shadow chat: purge its local history, delete the shared key + record, close the thread,
   * and instruct the peer to do the same. Real-mode only; fail-closed local-first. Unrecoverable.
   */
  revokeShadowChat(threadId: string): Promise<void>;
  /**
   * Clear a shadow chat's LOCAL history while keeping the shared key, so the chat keeps working. Real
   * mode only; no wire traffic (the peer's history is untouched — that is what Revoke is for).
   */
  clearShadowChat(threadId: string): Promise<void>;
  /**
   * Subscribe to {@link ShadowInviteEvent}s — `invite-received` (render the Accept/Decline card),
   * `invite-accepted` / `invite-resolved` (dismiss it), `thread-revoked` (remove the thread).
   */
  onShadowInvite(listener: (event: ShadowInviteEvent) => void): () => void;
  /**
   * Tell the controller the current resolved App-Lock mode (`real` / `decoy` / `null`). Shadow Chat
   * Invites actions are gated on this; the shell calls it whenever its app mode changes — including
   * the no-PIN case where the app runs in `real` mode WITHOUT an unlock — so the coordinator is never
   * left inert in real mode. Without this, `createShadowInvite` would silently no-op (no invite sent).
   */
  setActiveAppMode(mode: AppMode | null): void;
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

  // Shadow Chat Invites (design Component A): invite/accept/decline/revoke lifecycle events, surfaced
  // separately so the UI renders the Accept/Decline request card and the revoke/clear effects.
  const inviteListeners = new Set<(event: ShadowInviteEvent) => void>();
  const emitInvite = (event: ShadowInviteEvent): void => {
    for (const listener of inviteListeners) {
      listener(event);
    }
  };

  // Live messaging stack, created on sign-in and torn down on sign-out.
  let vault: PersistentVault | null = null;
  let gate: SecureGate | null = null;
  let shadowSecretStore: ShadowSecretStore | null = null;
  /** Shadow Chat Invites coordinator + its lifecycle registry / row→thread association (real-mode gated). */
  let shadowInviteCoordinator: ShadowInviteCoordinator | null = null;
  let shadowRowThreads: RowThreadAssociation | null = null;
  /** The current App-Lock mode (set on a successful unlock); gates all shadow-invite actions. */
  let currentAppMode: AppMode | null = null;
  // The narrow durable persistence the shadow store reads/writes through. Retained so the long-press
  // creation flow can provision the Master_Secret / Alias_Key once (Req 11.6) without widening the
  // store's port; the secrets live ONLY in the encrypted vault and never reach the network.
  let shadowSecretPersistence: ShadowSecretPersistence | null = null;
  let keyStore: KeyStore | null = null;
  let messaging: Messaging | null = null;
  let sessions: SessionManager | null = null;
  let realtime: RealtimeClient | null = null;
  let activeRecipient: string | null = null;
  let currentUid: string | null = null;
  let currentPhone: string | null = null;
  let deviceId: string | null = null;
  // Offline-push (FCM) registration state: the detach for the token-refresh listener, plus the
  // collaborators needed to revoke the token on explicit sign-out (Req 6.2/6.4).
  let pushUnsub: (() => void) | null = null;
  let pushRegistration: PushRegistrationDeps | null = null;

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
    // Bind the secure-gate (app PIN lock + hidden chats, §3/§6) to the encrypted vault.
    gate = createSecureGate(vault);
    // Provision the Shadow Chat secret store from DURABLE state (Shadow Chat, task 12.1): the store
    // reads/writes the shadow master secret, alias key, and alias→thread mappings through the SAME
    // encrypted vault, so a shadow chat provisioned in a previous session is rehydrated on launch and
    // survives restarts (Requirements 9.8, 9.9). Real-PIN gating and fail-closed reads live in the
    // shared `ShadowSecretStore`; read-path persistence errors are swallowed to keep the result
    // observationally identical to decoy/null mode (no UI signal that shadow data exists, Req 8.7).
    shadowSecretPersistence = createVaultShadowSecretPersistence(vault);
    shadowSecretStore = new ShadowSecretStore(shadowSecretPersistence, {
      onPersistenceError: () => {
        /* fail closed: getShadowContext/listAliasEntries already return null/[]; nothing to surface */
      },
    });

    // Shadow Chat Invites (design Component A): a lifecycle registry for opened invited threads, the
    // durable row→thread association for per-thread history purge (Req 14), and the coordinator that
    // owns invite/accept/decline/revoke. The coordinator is bound to Messaging below (shadowInvites)
    // and resolves the live instance lazily, so the construction cycle is broken cleanly. All actions
    // are real-mode gated through `currentAppMode`.
    const shadowInviteRegistry = createConversationRegistry({ platform: 'mobile' });
    shadowRowThreads = createVaultRowThreadAssociation(vault);
    shadowInviteCoordinator = buildShadowInviteCoordinator({
      messaging: () => messaging,
      store: shadowSecretStore,
      registry: shadowInviteRegistry,
      rowThreads: shadowRowThreads,
      keyStore: store,
      resolveMode: () => currentAppMode,
      myUid: () => authService.getCurrentUid(),
    });
    shadowInviteCoordinator.onInvite(emitInvite);

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
        // Shadow Chat (Req 4): a shadow send/control message uses a dedicated per-thread allocator
        // keyed `shadow:${threadId}`, so its seq is offset by +1e9 and stays disjoint from surface
        // seqs in the shared ack/reducer key space. Reuses the existing KeyStore — no port change.
        shadowSequence: (threadId: string) => new ShadowSequenceAllocator(store, threadId),
        // Shadow Chat Invites: intercept the four control payloads before conversation routing, and
        // tag persisted shadow rows with their threadId so Clear/Revoke can purge per-thread (Req 14).
        shadowInvites: shadowInviteCoordinator,
        recordRow: (rowId: string, threadId: string) => shadowRowThreads?.record(rowId, threadId),
        codec: createEnvelopeCodec(),
        keyClaimer: createPreKeyClaimClient(httpClient, () => authService.getCurrentToken(), API_BASE_URL),
        // E2E attachments (Req 7): the orchestrator encrypts media locally and moves ONLY the
        // ciphertext through this blob store (`POST/GET /api/blobs`); the per-attachment key rides
        // the encrypted message payload, never the store. Absent ⇒ attachments degrade to a local
        // `failed` row, so wiring it is what turns on send/receive of photos.
        blobs: createBlobStore(httpClient, () => authService.getCurrentToken(), API_BASE_URL),
        // Biometric presence attestation (Signature Feature 2b, §4.5): the device's biometric-gated
        // signing oracle proves the real owner is present, and peers' enrolled public keys are kept
        // in the encrypted vault so a verification works across launches. Both are device-local; no
        // wire/backend change. Absent ⇒ the feature degrades to "cannot attest" cleanly.
        biometricAttestor: createExpoBiometricAttestor(),
        biometricEnrollment: createVaultBiometricEnrollment(vault),
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

    // Offline push (Req 6.2/6.3): register this device's FCM token so the backend can send a
    // content-free wake push while the app is offline. Fire-and-forget + best-effort — it must never
    // delay or fail bootstrap (a denied permission / missing FCM just means no wake pushes; the
    // store-and-forward queue still drains on the next foreground connect). Remembered so an explicit
    // sign-out can revoke the token and a re-bootstrap can detach the previous refresh listener.
    pushUnsub?.();
    pushUnsub = null;
    pushRegistration = {
      client: createPushTokenClient(httpClient, () => authService.getCurrentToken(), API_BASE_URL),
      registrationId: record.registrationId,
      platform: createFirebasePushPlatform(),
    };
    void registerPushToken(pushRegistration).then((unsub) => {
      pushUnsub = unsub;
    });
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
    // Detach the FCM token-refresh listener (the token itself is retained for relaunch — only an
    // explicit sign-out revokes it).
    pushUnsub?.();
    pushUnsub = null;
    // destroy() releases the store's in-memory state but RETAINS the encrypted blob, so a
    // retry/relaunch reuses the same identity. Explicit sign-out wipes via vault.wipe().
    keyStore?.destroy();
    messaging = null;
    sessions = null;
    realtime = null;
    keyStore = null;
    vault = null;
    gate = null;
    shadowSecretStore = null;
    shadowSecretPersistence = null;
    shadowInviteCoordinator = null;
    shadowRowThreads = null;
    currentAppMode = null;
    activeRecipient = null;
  }

  /**
   * Resolve every KNOWN shadow thread to its peer UID — active invited threads (the invite flow) plus
   * any alias-bound thread (the /alias flow) — as `threadId -> peerUid`. Shared by shadow rehydration
   * and the shadow-chat manager. Real-mode gated by the callers; fail-closed (a persistence error
   * contributes no entries) so it never reveals a shadow thread the user can't securely access.
   */
  async function resolveKnownShadowThreads(): Promise<Map<string, string>> {
    const peerByThread = new Map<string, string>();
    try {
      const invited = (await shadowSecretPersistence?.loadInvitedThreads()) ?? [];
      for (const ref of invited) {
        if (ref.state === 'active') {
          peerByThread.set(ref.threadId, ref.peerUid);
        }
      }
    } catch {
      // fail closed — a persistence error reveals no shadow threads
    }
    try {
      const aliases = shadowSecretStore !== null ? await shadowSecretStore.listAliasEntries('real') : [];
      for (const entry of aliases) {
        peerByThread.set(entry.ref.threadId, entry.ref.peerUid);
      }
    } catch {
      // fail closed
    }
    return peerByThread;
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

    async send(plaintext: string, options?: { viewOnce?: boolean; threadId?: string }): Promise<void> {
      if (messaging === null || activeRecipient === null) {
        return;
      }
      // `options.threadId`, when present, routes the message into the contact's SHADOW thread (Req
      // 8 / task 8.2): it rides inside the encrypted body and the wire envelope is unchanged. Absent
      // ⇒ ordinary surface send, byte-for-byte as before. The shared Messaging already supports this
      // option, so this is a pure passthrough (no wire/port change).
      await messaging.send(activeRecipient, plaintext, options);
    },

    async sendAttachment(
      content: OutgoingAttachment,
      options?: { threadId?: string },
    ): Promise<void> {
      if (messaging === null || activeRecipient === null) {
        return;
      }
      // Pure passthrough to the shared orchestrator, mirroring `send`: it owns the encrypt → upload
      // ciphertext → optimistic row → transmit lifecycle, and `options.threadId` routes into the
      // open shadow thread when present.
      await messaging.sendAttachment(activeRecipient, content, options);
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

    async clearChatHistory(conversationId: string): Promise<void> {
      // Local-only Clear chat: purge exactly the persisted rows for this SURFACE conversation
      // (remoteUid === conversationId) via the store's best-effort secure erase. Fail-soft on a
      // store error (handled inside clearConversationHistory), mirroring the markViewed purge path.
      // The container dispatches `conversation-cleared` to reset the open view to empty.
      if (keyStore === null) {
        return;
      }
      await clearConversationHistory(keyStore, conversationId);
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

    async retryMessage(target: MessageTarget, options?: { threadId?: string }): Promise<void> {
      if (messaging === null || activeRecipient === null) {
        return;
      }
      // Pass `options.threadId` through for a shadow-thread message so the resend rides the shadow
      // seq space + routing (mirrors `send`); a surface message passes none.
      await messaging.retryMessage(activeRecipient, target, options);
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

    async enrollBiometric(): Promise<boolean> {
      if (messaging === null || activeRecipient === null) {
        return false;
      }
      return messaging.enrollBiometricAttestation(activeRecipient);
    },

    async requestBiometricVerification(): Promise<boolean> {
      if (messaging === null || activeRecipient === null) {
        return false;
      }
      return messaging.requestBiometricVerification(activeRecipient);
    },

    async isPeerBiometricEnrolled(): Promise<boolean> {
      if (messaging === null || activeRecipient === null) {
        return false;
      }
      return messaging.isBiometricPeerEnrolled(activeRecipient);
    },

    async hasAppPin(): Promise<boolean> {
      return gate !== null ? gate.hasRealPin() : false;
    },
    async hasDecoyPin(): Promise<boolean> {
      return gate !== null ? gate.hasDecoyPin() : false;
    },
    async setAppPin(pin: string, kind: 'real' | 'decoy'): Promise<void> {
      await gate?.setPin(pin, kind);
    },
    async clearAppPin(kind: 'real' | 'decoy'): Promise<void> {
      await gate?.clearPin(kind);
    },
    async unlockApp(pin: string): Promise<UnlockResult> {
      const result: UnlockResult = gate !== null ? await gate.unlock(pin) : { invalid: true };
      // Track the resolved App-Lock mode so Shadow Chat Invites actions are gated to real mode only
      // (decoy/null reveal nothing and act on nothing — design Correctness Properties 6, 16).
      if ('mode' in result) {
        currentAppMode = result.mode;
      }
      return result;
    },
    async hideChat(peerUid: string, secret: string): Promise<void> {
      await gate?.hideChat(peerUid, secret);
    },
    async unhideChat(peerUid: string): Promise<void> {
      await gate?.unhideChat(peerUid);
    },
    async listHiddenPeers(): Promise<string[]> {
      return gate !== null ? gate.listHiddenPeers() : [];
    },
    async revealHiddenChat(secret: string): Promise<RevealResult> {
      return gate !== null ? gate.revealHiddenChat(secret) : { invalid: true };
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
      // Partition persisted rows into SURFACE (seq < 1e9) and SHADOW (seq >= 1e9) and rehydrate ONLY
      // the surface conversations here. Shadow rows are deliberately EXCLUDED so a restart can never
      // replay a shadow message into the normal chat (Shadow Chat, Correctness Property 8); shadow
      // threads are rehydrated separately, real-mode gated, by `loadShadowConversations`.
      const { surfaceByPeer } = partitionPersistedRows(rows);
      const now = Date.now();
      const conversations: RehydratedConversation[] = [];
      for (const [peerUid, peerRows] of surfaceByPeer) {
        // Replay through the shared reducer so the rehydrated state is byte-for-byte what a live
        // session would have produced (Req 6.7).
        let { state, lastAt } = reduceRowsToState(peerRows, { now, platform: 'mobile' });
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

    async loadShadowConversations(): Promise<RehydratedShadowConversation[]> {
      // Rehydrate persisted SHADOW threads on relaunch so their history survives a restart AND so the
      // render registry can reopen them — without which an inbound shadow message arriving after a
      // restart is dropped as an "unknown thread" (Req 7.8) and the thread looks empty. Real-mode
      // gated: in decoy/locked mode this reveals NOTHING (returns []), exactly like every other shadow
      // entry point (design Correctness Properties 6, 16).
      if (keyStore === null || shadowRowThreads === null || currentAppMode !== 'real') {
        return [];
      }
      const peerByThread = await resolveKnownShadowThreads();
      if (peerByThread.size === 0) {
        return [];
      }
      let rows;
      try {
        rows = await keyStore.loadMessages();
      } catch {
        return [];
      }
      const rowsById = new Map(rows.map((row) => [row.id, row] as const));
      const now = Date.now();
      const conversations: RehydratedShadowConversation[] = [];
      for (const [threadId, peerUid] of peerByThread) {
        // The persisted MessageRow carries no threadId; the durable device-local row->thread
        // association resolves which rows belong to this thread (Req 14).
        let rowIds: string[];
        try {
          rowIds = await shadowRowThreads.rowIdsForThread(threadId);
        } catch {
          rowIds = [];
        }
        const threadRows = rowIds
          .map((id) => rowsById.get(id))
          .filter((row): row is NonNullable<typeof row> => row !== undefined);
        // Replay through the same shared reducer as the surface path so a shadow thread renders
        // byte-for-byte like a live one (stamp the resolved peer onto each event).
        const { state, lastAt } = reduceRowsToState(threadRows, {
          now,
          platform: 'mobile',
          remoteUid: peerUid,
        });
        conversations.push({ threadId, peerUid, lastAt, state });
      }
      return conversations;
    },

    async listShadowChats(): Promise<ShadowChatRef[]> {
      // Enumerate the user's active shadow chats for the manager UI so they can be cleared/revoked
      // WITHOUT first reopening each via its /alias. Real-mode gated: decoy/locked reveal nothing
      // (returns []), so the manager can never expose that shadow chats exist under coercion (design
      // Correctness Properties 6, 16).
      if (currentAppMode !== 'real') {
        return [];
      }
      const peerByThread = await resolveKnownShadowThreads();
      return [...peerByThread.entries()].map(([threadId, peerUid]) => ({ threadId, peerUid }));
    },

    subscribe(listener: (event: ControllerEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getShadowSecretStore(): ShadowSecretStore | null {
      return shadowSecretStore;
    },

    async provisionShadowContext(): Promise<boolean> {
      // No encrypted vault open yet (setup still running / signed out) → provision nothing.
      const persistence = shadowSecretPersistence;
      if (persistence === null) {
        return false;
      }
      // Idempotent: provision each secret only when absent, so an already-provisioned device (incl.
      // one rehydrated from a previous session) is untouched and existing thread ids stay valid.
      const [existingSecret, existingKey] = await Promise.all([
        persistence.loadMasterSecret(),
        persistence.loadAliasKey(),
      ]);
      if (existingSecret === null || existingSecret.length === 0) {
        // 32-byte CSPRNG master secret (seeds deriveShadowThreadId). Persisted only into the
        // encrypted vault; never transmitted off-device (Req 9.1, 9.5).
        await persistence.saveMasterSecret(crypto.getRandomValues(new Uint8Array(32)));
      }
      if (existingKey === null || existingKey.length === 0) {
        // 32-byte CSPRNG alias-HMAC key (keys hashAlias / matchAlias).
        await persistence.saveAliasKey(crypto.getRandomValues(new Uint8Array(32)));
      }
      return true;
    },

    async createShadowInvite(
      peerUid: string,
      alias?: string,
      pin?: string,
    ): Promise<{ inviteId: string; threadId: string } | null> {
      const pending = await shadowInviteCoordinator?.createInvite(peerUid, alias, pin);
      return pending != null ? { inviteId: pending.inviteId, threadId: pending.threadId } : null;
    },

    async acceptShadowInvite(
      inviteId: string,
      routing: RecipientRouting,
      alias?: string,
      pin?: string,
    ): Promise<string | null> {
      const ref = await shadowInviteCoordinator?.acceptInvite(inviteId, routing, alias, pin);
      return ref != null ? ref.threadId : null;
    },

    setActiveAppMode(mode: AppMode | null): void {
      currentAppMode = mode;
    },

    async declineShadowInvite(inviteId: string): Promise<void> {
      await shadowInviteCoordinator?.declineInvite(inviteId);
    },

    async revokeShadowChat(threadId: string): Promise<void> {
      await shadowInviteCoordinator?.revokeShadowThread(threadId);
    },

    async clearShadowChat(threadId: string): Promise<void> {
      await shadowInviteCoordinator?.clearShadowThread(threadId);
    },

    onShadowInvite(listener: (event: ShadowInviteEvent) => void): () => void {
      inviteListeners.add(listener);
      return () => inviteListeners.delete(listener);
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
      // Revoke this device's push token BEFORE wiping (Req 6.4) so the backend stops sending wake
      // pushes to a signed-out device. Best-effort — never blocks sign-out; needs the still-valid
      // auth token, so it runs before the auth session is cleared below.
      if (pushRegistration !== null) {
        await revokePushToken(pushRegistration);
        pushRegistration = null;
      }
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
    async sendAttachment(): Promise<void> {
      // No transport/blob store in the demo controller.
    },
    async markViewed(): Promise<void> {
      // No store in the demo controller.
    },
    async clearChatHistory(): Promise<void> {
      // No store in the demo controller; nothing to purge.
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
    async retryMessage(): Promise<void> {
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
    async enrollBiometric(): Promise<boolean> {
      // No messaging/attestor in the demo controller.
      return false;
    },
    async requestBiometricVerification(): Promise<boolean> {
      // No messaging/attestor in the demo controller.
      return false;
    },
    async isPeerBiometricEnrolled(): Promise<boolean> {
      // No enrollment store in the demo controller.
      return false;
    },
    async hasAppPin(): Promise<boolean> {
      return false;
    },
    async hasDecoyPin(): Promise<boolean> {
      return false;
    },
    async setAppPin(): Promise<void> {
      // No vault in the demo controller.
    },
    async clearAppPin(): Promise<void> {
      // No vault in the demo controller.
    },
    async unlockApp(): Promise<UnlockResult> {
      return { invalid: true };
    },
    async hideChat(): Promise<void> {
      // No vault in the demo controller.
    },
    async unhideChat(): Promise<void> {
      // No vault in the demo controller.
    },
    async listHiddenPeers(): Promise<string[]> {
      return [];
    },
    async revealHiddenChat(): Promise<RevealResult> {
      return { invalid: true };
    },
    async loadConversations(): Promise<RehydratedConversation[]> {
      return [];
    },
    async loadShadowConversations(): Promise<RehydratedShadowConversation[]> {
      // Demo controller has no encrypted vault, so there are no persisted shadow threads.
      return [];
    },
    async listShadowChats(): Promise<ShadowChatRef[]> {
      // Demo controller has no encrypted vault, so there are no shadow chats to manage.
      return [];
    },
    subscribe(listener: (event: ControllerEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getShadowSecretStore(): ShadowSecretStore | null {
      // Demo controller has no encrypted vault to back the durable shadow store.
      return null;
    },
    async provisionShadowContext(): Promise<boolean> {
      // No encrypted vault in the demo controller, so there is nothing to provision.
      return false;
    },
    // Shadow Chat Invites: no messaging/coordinator in the demo controller, so these are inert.
    async createShadowInvite(): Promise<{ inviteId: string; threadId: string } | null> {
      return null;
    },
    async acceptShadowInvite(): Promise<string | null> {
      return null;
    },
    async declineShadowInvite(): Promise<void> {
      // no-op
    },
    async revokeShadowChat(): Promise<void> {
      // no-op
    },
    async clearShadowChat(): Promise<void> {
      // no-op
    },
    onShadowInvite(): () => void {
      return () => undefined;
    },
    setActiveAppMode(): void {
      // no-op (demo controller has no coordinator)
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
