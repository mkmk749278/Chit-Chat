/**
 * `@chat-app/crypto` — `Messaging` orchestration (Phase 1, design Component 5: Messaging).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Components and Interfaces" → "Client Component 5: Messaging" (the `Messaging`
 *   interface and the two send/receive sequence diagrams), and
 *   `.kiro/specs/phase1-client-messaging/requirements.md` → Requirement 5 (5.2, 5.5,
 *   5.6, 5.9, 5.10, 5.11) plus Requirement 6.2.
 *
 * `Messaging` is the stateful conductor that ties the pure shared pieces together into
 * the send/receive lifecycle. It owns no cryptography, transport, or storage of its own;
 * it drives the injected {@link SessionManager} (libsignal), {@link SequenceAllocator}
 * (per-conversation seq), {@link EnvelopeCodec} (wire frame), {@link PreKeyClaimClient}
 * (recipient bundle fetch), the {@link MessagingRealtime} transport, and the
 * {@link MessagingStore} (display rows + status):
 *
 *   - {@link DefaultMessaging.send}: establish a libsignal session if one does not yet
 *     exist (claim → establish), allocate the next per-conversation sequence number,
 *     encrypt the plaintext, build the `CiphertextEnvelope` via the codec (which has no
 *     plaintext field), and transmit a `send` frame — or, while the socket is not open,
 *     hold the already-built frame in a pending-send queue and flush it exactly once on
 *     the next reconnect (Requirements 5.2, 5.10). A session-establishment or encrypt
 *     failure transmits nothing and marks the message `failed`, retaining its text (5.9).
 *   - ack / timeout: a transmitted message arms a 30 s deadline; a matching `ack` frame
 *     transitions it `sending → sent`, while the deadline elapsing transitions it
 *     `sending → failed` with its text retained (Requirements 5.6, 5.11).
 *   - {@link DefaultMessaging.onEnvelope}: decrypt an inbound envelope and render the
 *     plaintext (`received`), or, on libsignal decryption failure, render no plaintext
 *     and surface a `delivery-error` for that message (Requirements 5.5, 6.9).
 *
 * The orchestrator is platform-agnostic and deterministic: the message-id generator, the
 * wall clock, and the timer {@link Scheduler} are all injected, so the pending-send flush
 * and ack/timeout behaviour can be unit- and property-tested without real timers or a
 * real socket. State changes are surfaced as {@link ConversationEvent}s (consumed by the
 * shared {@link reduce} / `ConversationReducer`) so the Mobile_App and Web_App render the
 * conversation through one pure code path (design Component 7, Requirement 6.7).
 */

import type {
  CiphertextEnvelope,
  ClientToServerFrame,
  ConnectionStatus,
  MessageStatus,
  ServerToClientFrame,
} from '@chat-app/types';
import type { ClaimedPreKeyBundle } from '@chat-app/types';

import { decryptAttachment, encryptAttachment } from './attachment-crypto';
import type { ConversationEvent, RenderableAttachment } from './conversation-reducer';
import { decodeContentPayload, encodeContentPayload, type ContentPayload } from './content-payload';
import { msUntilNextExpiry, selectExpired, type ExpiringEntry } from './disappearing-timer';
import {
  classifyVerificationCode,
  currentVerificationCodes,
  generateVerificationSeed,
  verificationSeedFromBase64,
  verificationSeedToBase64,
} from './identity-verification';
import type { EnvelopeCodec } from './envelope-codec';
import type { AttachmentRef, BlobStore, MessageRow, Unsubscribe } from './ports';
import type { Scheduler, TimerHandle } from './realtime-client';
import type { SequenceAllocator } from './sequence-allocator';
import { SHADOW_SEQ_OFFSET } from './shadow-sequence-allocator';
import type { SessionManager } from './session-manager';

/** Default deadline for a Backend_API acknowledgment after transmission: 30 s (5.6, 5.11). */
export const DEFAULT_ACK_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Injected collaborators (narrow ports the orchestrator depends on).
// ---------------------------------------------------------------------------

/**
 * The narrow Realtime_Client surface {@link DefaultMessaging} drives (design Component 4).
 * The full `RealtimeClient` satisfies this structurally; only sending a frame, reading
 * the current status, and subscribing to inbound frames + status changes are needed here.
 */
export interface MessagingRealtime {
  /** Transmit a client→server wire frame. Throws if the socket is not open. */
  send(frame: ClientToServerFrame): void;
  /** Current connection status: `connected` only while the socket is open (4.7). */
  getStatus(): ConnectionStatus;
  /** Subscribe to inbound `deliver` / `ack` frames (control frames are handled upstream). */
  onFrame(listener: (frame: ServerToClientFrame) => void): Unsubscribe;
  /** Subscribe to connection-status changes; used to flush pending sends on reconnect (5.10). */
  onStatus(listener: (status: ConnectionStatus) => void): Unsubscribe;
}

/**
 * Fetches a recipient's PUBLIC prekey bundle from the prekey-claim endpoint
 * (`GET /api/keys/:uid`) so a libsignal session can be established (Requirement 5.1).
 * Resolves `null` when the recipient has no registered device (HTTP 404), which the
 * orchestrator surfaces as a session-establishment failure (design Scenario 6 / 11).
 */
export interface PreKeyClaimClient {
  /** Claim the recipient's public prekey bundle, or `null` if they have no device. */
  claim(recipientUid: string): Promise<ClaimedPreKeyBundle | null>;
}

/**
 * Resolves the local sender's routing identity for the outbound envelope: the signed-in
 * Firebase UID and this device's server-issued `deviceId`. Bound by the app to the
 * Auth_Service (`getCurrentUid`) and the Device_Registrar (`getDeviceId`); resolves
 * `null` when the user is not signed in or the device is not yet registered, in which
 * case a send cannot be addressed and is marked `failed` (5.9).
 */
export interface LocalSenderResolver {
  resolveSender(): Promise<{ uid: string; deviceId: string } | null>;
}

/**
 * The on-device store surface {@link DefaultMessaging} writes display rows + status to
 * (design Component 6). The full `KeyStore` satisfies this structurally; the orchestrator
 * only appends rows and updates their status (Requirements 5.6, 5.10, 5.11, 6.2, 6.8).
 */
export interface MessagingStore {
  /** Append a message row for display (5.10, 6.2, 6.8). */
  appendMessage(row: MessageRow): Promise<void>;
  /** Update a message's status by id (5.6, 5.11, 6.5, 6.8). */
  updateMessageStatus(id: string, status: MessageStatus): Promise<void>;
  /** Persist a reaction onto the target message so it survives a relaunch (Req 3.1). */
  applyReaction(remoteUid: string, direction: 'in' | 'out', seq: number, emoji: string): Promise<void>;
  /** Persist an edit onto the target message (Req 3.2). */
  applyEdit(remoteUid: string, direction: 'in' | 'out', seq: number, body: string): Promise<void>;
  /** Persist a delete tombstone onto the target message (Req 3.3). */
  applyDelete(remoteUid: string, direction: 'in' | 'out', seq: number): Promise<void>;
  /** Persist the per-conversation disappearing-message timer (Req 4.1). */
  setConversationTimer(remoteUid: string, ttlMs: number): Promise<void>;
  /** Load every persisted row, used to re-arm disappearing-message purges on launch (Req 4.2). */
  loadMessages(): Promise<MessageRow[]>;
  /** Permanently remove expired rows (best-effort secure erase) (Req 4.2/4.4). */
  purgeMessages(ids: string[]): Promise<void>;
}

/** The injected ports + collaborators {@link DefaultMessaging} depends on. */
export interface MessagingDeps {
  /** Authenticated WebSocket transport for `send` frames and inbound `deliver` / `ack`. */
  realtime: MessagingRealtime;
  /** libsignal session orchestrator: `hasSession` / `establishSession` / `encrypt` / `decrypt`. */
  sessions: SessionManager;
  /** Per-conversation strictly-increasing sequence allocator (5.3, 6.2). */
  sequence: SequenceAllocator;
  /** Stateless codec building the `CiphertextEnvelope` wire frame (no plaintext field). */
  codec: EnvelopeCodec;
  /** Prekey-claim client used to fetch a recipient bundle before first send (5.1). */
  keyClaimer: PreKeyClaimClient;
  /** Resolver for the local sender's `{ uid, deviceId }` envelope routing identity. */
  sender: LocalSenderResolver;
  /** On-device store for display rows + status (5.6, 5.10, 5.11, 6.2). */
  store: MessagingStore;
  /**
   * OPTIONAL factory for a per-thread shadow {@link SequenceAllocator} (Shadow Chat, design
   * Component 3/4). When a {@link SendOptions.threadId} (or a `threadId` on react/edit/delete/timer)
   * is present, the orchestrator allocates the message's sequence number from
   * `shadowSequence(threadId)` instead of the surface {@link sequence}, so shadow seqs are offset by
   * `+1e9` and contiguous per thread (disjoint from surface seqs in the shared ack/reducer key
   * spaces). The platform adapter binds this to a `ShadowSequenceAllocator` constructed against its
   * own `KeyStore` (the `KeyStore` is not otherwise visible to this orchestrator). It is OPTIONAL so
   * every existing surface-only call site keeps compiling and behaving identically: when it is
   * absent the surface path is completely unchanged, and a shadow send attempted without it is
   * treated as a misconfiguration and fails locally (text retained) rather than leaking onto the
   * surface conversation.
   */
  shadowSequence?: (threadId: string) => SequenceAllocator;
  /**
   * OPTIONAL inbound interceptor for Shadow Chat Invites control payloads (Shadow Chat Invites,
   * design Component E). When present, an inbound `shadow-invite` / `shadow-accept` / `shadow-decline`
   * / `shadow-revoke` payload is handed to it BEFORE conversation routing and never becomes a
   * conversation row — exactly mirroring the verification-control seam. Bound by the platform adapter
   * to its `ShadowInviteCoordinator`; absent in surface-only constructions, in which case those four
   * control types are simply ignored (forward-compatible, like any other unknown control).
   */
  shadowInvites?: InboundShadowControlHandler;
  /**
   * OPTIONAL device-local hook invoked whenever a SHADOW message row (one carrying a `threadId`) is
   * persisted, on both the send and receive paths (Shadow Chat Invites, Req 14). The platform adapter
   * binds it to its `RowThreadAssociation.record` so "Clear shadow chat" / "Revoke shadow chat" can
   * resolve every row id belonging to a `threadId` for `KeyStore.purgeMessages`. It is additive and
   * device-local only — it adds no wire/envelope/codec field and never touches a surface row.
   */
  recordRow?: (rowId: string, threadId: string) => void | Promise<void>;
  /**
   * OPTIONAL transport for end-to-end encrypted attachment ciphertext (Req 7). When present,
   * {@link Messaging.sendAttachment} encrypts + uploads media here and an inbound `attachment`
   * payload is downloaded + decrypted for rendering. Bound by the platform adapter to the backend
   * blob service. ABSENT in text-only constructions: `sendAttachment` then fails the message locally
   * and an inbound attachment surfaces as a delivery-error row, so the surface path is unchanged.
   */
  blobs?: BlobStore;
}

/**
 * The narrow inbound seam `Messaging` uses to delegate Shadow Chat Invites control payloads, so the
 * orchestrator never imports the coordinator directly (the coordinator depends on Messaging for its
 * transport, not the reverse). Returns true when the payload was consumed as shadow control.
 */
export interface InboundShadowControlHandler {
  handleInbound(peerUid: string, payload: ContentPayload): Promise<boolean>;
}

/** Tuning knobs + injected determinism seams for {@link DefaultMessaging}. */
export interface MessagingOptions {
  /**
   * Generates a stable client-side message id (e.g. a UUID) for each outbound and inbound
   * row. Injected so ids are deterministic in tests.
   */
  generateId: () => string;
  /** Wall-clock source in unix ms for row `createdAt`. Defaults to `Date.now`. */
  now?: () => number;
  /** Timer surface for the ack deadline. Defaults to the host `setTimeout` / `clearTimeout`. */
  scheduler?: Scheduler;
  /** Ack deadline in ms after transmission. Defaults to {@link DEFAULT_ACK_TIMEOUT_MS} (5.6, 5.11). */
  ackTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Public component contract (design Component 5: Messaging interface).
// ---------------------------------------------------------------------------

/**
 * Conducts the 1:1 send/receive lifecycle over the shared crypto core (design Component 5;
 * Requirements 5.2, 5.5, 5.6, 5.9, 5.10, 5.11).
 */
/** Identifies a target message within a conversation by its LOCAL direction + sequence number. */
export interface MessageTarget {
  /** `out` for a message this device sent, `in` for one it received. */
  direction: 'in' | 'out';
  /** The target message's per-conversation sequence number. */
  seq: number;
}

/** Options for {@link Messaging.send}. */
export interface SendOptions {
  /** Send as a view-once message: the recipient may open it once, then it is purged (Req 4.3). */
  viewOnce?: boolean;
  /**
   * Route this message into the contact's SHADOW thread (Shadow Chat, Req 3.1/5.2). When present
   * (a non-empty, ≤255-char string — the bounds the content-payload codec treats as routable, so
   * the encoded body and the allocated seq space never disagree) the message is allocated a shadow
   * sequence (`≥1e9`) via {@link MessagingDeps.shadowSequence}, the `threadId` rides INSIDE the
   * encrypted body, and every emitted `ConversationEvent` is tagged with it so the
   * `ConversationRegistry` routes it to the shadow conversation. ABSENT ⇒ ordinary surface chat,
   * byte-for-byte unchanged.
   */
  threadId?: string;
}

/** The decrypted media handed to {@link Messaging.sendAttachment} (Req 7). */
export interface OutgoingAttachment {
  /** Raw, decrypted attachment bytes (the orchestrator encrypts them before upload). */
  data: Uint8Array;
  /** MIME type of the content (e.g. `image/jpeg`, `audio/aac`). */
  mediaType: string;
  /** Optional original file name to preserve for the recipient. */
  name?: string;
}

/** Options for the targeted control operations (react/edit/delete) — Shadow Chat thread scoping. */
export interface ControlOptions {
  /**
   * Route this reaction/edit/delete/timer into the contact's SHADOW thread (Shadow Chat, Req
   * 7.2/7.3). Same semantics as {@link SendOptions.threadId}: present ⇒ shadow (seq `≥1e9`,
   * `threadId` inside the body, events tagged); absent ⇒ surface, byte-for-byte unchanged.
   */
  threadId?: string;
}

/**
 * In-chat identity-verification lifecycle events (Signature Feature 2, §4). Emitted as the
 * verification challenge flows over the E2E channel so the platform UI can show the per-session
 * badge (§4.3). Verification state is session-scoped (RAM only) and resets on app lock/exit (§4.4).
 */
export type VerificationEvent =
  /** We sent a verification request to `peerUid`; awaiting their coded response. */
  | { type: 'verify-requested'; peerUid: string }
  /** `peerUid` asked us to verify; the UI should prompt us to submit the rotating code. */
  | { type: 'verify-incoming'; peerUid: string }
  /** A verification finished with `ok` (passed/failed). Drives the green "Verified ✓" badge (§4.3). */
  | { type: 'verify-result'; peerUid: string; ok: boolean }
  /**
   * We are a pre-configured trusted contact and received a SILENT duress alert: `peerUid` is the
   * person who was coerced into running a verification (§4.2, §4.3). The UI surfaces this discreetly.
   */
  | { type: 'duress-alert-received'; peerUid: string };

/** Which rotating code the responder submits when answering a verification (§4.2). */
export type VerificationResponseKind = 'normal' | 'duress';

export interface Messaging {
  /**
   * Send `plaintext` to `recipientUid`. Establishes a libsignal session first if needed,
   * allocates the next sequence number, encrypts, builds the envelope, and transmits — or
   * holds the frame for flush-on-reconnect while disconnected (Requirements 5.2, 5.10).
   * Never throws for an expected delivery problem (offline, no recipient device, encrypt
   * failure); those surface as a `failed` message with its text retained (5.9).
   *
   * Pass `options.threadId` to route the message into the contact's shadow thread (Shadow Chat,
   * Req 3.1); absent ⇒ surface chat, byte-for-byte unchanged.
   */
  send(recipientUid: string, plaintext: string, options?: SendOptions): Promise<void>;
  /**
   * Send an end-to-end encrypted attachment to `recipientUid` (Req 7). The decrypted bytes are
   * encrypted locally under a fresh per-attachment AES-256-GCM key, the CIPHERTEXT is uploaded to the
   * {@link MessagingDeps.blobs} store, and the blob handle + key + iv ride inside the same E2E channel
   * as text — the key never reaches the store (Req 7.1/7.2). Optimistically renders a `sending` row
   * (carrying the decrypted bytes for immediate display) like {@link send}. Never throws for an
   * expected delivery problem (no blob transport, upload/encrypt failure, offline); those surface as a
   * `failed` message. Pass `options.threadId` to route into a shadow thread (Shadow Chat, Req 3.1).
   */
  sendAttachment(recipientUid: string, content: OutgoingAttachment, options?: SendOptions): Promise<void>;
  /**
   * Re-send a previously `failed` outbound message (connection-reliability UX): the user taps "retry"
   * on a message that never got an ack (offline, transient encrypt/claim failure, ack timeout). The
   * message is reconstructed from its persisted row and re-driven through the same send path, reusing
   * its ORIGINAL id and seq so no duplicate row or sequence number is created — it simply flips back
   * to `sending` and then `sent`/`failed` again. A no-op (idempotent) when the target is not an
   * outbound row, is not currently `failed`, or has nothing resendable. Pass `options.threadId` for a
   * shadow-thread message (the thread context is not stored on the row, so the caller supplies it).
   */
  retryMessage(recipientUid: string, target: MessageTarget, options?: ControlOptions): Promise<void>;
  /**
   * React to a prior message with an emoji (Requirement 3.1). `target` identifies the message
   * by its LOCAL direction + seq; the reaction rides as an E2E content payload and the peer
   * renders it against the same message. Pass `options.threadId` to scope the reaction to a shadow
   * thread (Shadow Chat, Req 7.2); absent ⇒ surface, byte-for-byte unchanged.
   */
  react(recipientUid: string, target: MessageTarget, emoji: string, options?: ControlOptions): Promise<void>;
  /**
   * Edit a prior message's text (Requirement 3.2); the latest text supersedes the original.
   * Typically `target.direction === 'out'` (you edit your own messages). Pass `options.threadId` to
   * scope the edit to a shadow thread (Shadow Chat, Req 7.2); absent ⇒ surface, unchanged.
   */
  editMessage(recipientUid: string, target: MessageTarget, body: string, options?: ControlOptions): Promise<void>;
  /**
   * Delete (tombstone) a prior message (Requirement 3.3); both sides replace its content with a
   * deleted placeholder. Typically `target.direction === 'out'`. Pass `options.threadId` to scope
   * the delete to a shadow thread (Shadow Chat, Req 7.2); absent ⇒ surface, unchanged.
   */
  deleteMessage(recipientUid: string, target: MessageTarget, options?: ControlOptions): Promise<void>;
  /**
   * Set the conversation's disappearing-message timer (Req 4.1). `ttlMs` is the message
   * lifetime in milliseconds; `0` disables it. Sent as an E2E payload so both peers converge
   * on the same timer; applied optimistically locally. Pass `options.threadId` to scope the timer
   * to a shadow thread (Shadow Chat, Req 7.3); absent ⇒ surface, byte-for-byte unchanged.
   */
  setDisappearingTimer(recipientUid: string, ttlMs: number, options?: ControlOptions): Promise<void>;
  /**
   * Seed the in-memory disappearing-timer for a conversation WITHOUT sending or persisting it
   * (Req 4.1). Used on relaunch to restore a previously-agreed timer so messages sent in the new
   * session are stamped with the right expiry, without re-notifying the peer.
   */
  primeConversationTtl(recipientUid: string, ttlMs: number): void;
  /**
   * Send an ephemeral "typing" hint to `recipientUid` (Req 5.3). Best-effort: dropped silently
   * while disconnected. Carries no content and is never persisted. Callers should rate-limit.
   */
  sendTyping(recipientUid: string): void;
  /**
   * Subscribe to inbound typing hints from peers (Req 5.3); `fromUid` is the peer who is typing.
   * Ephemeral — there is no "stopped typing" frame; consumers expire the indicator on a timer.
   */
  onTyping(listener: (fromUid: string) => void): Unsubscribe;
  /**
   * Send a Shadow Chat Invites control payload (`shadow-invite` / `shadow-accept` / `shadow-decline`
   * / `shadow-revoke`) to `recipientUid` over the existing E2E channel (Shadow Chat Invites, design
   * Component E). The payload rides inside an ordinary `CiphertextEnvelope` between the two surface
   * UIDs — no `threadId`, key, or plaintext on the wire — exactly like the verification controls. The
   * platform binds its `ShadowInviteCoordinator`'s transport to this method. Offline sends ride the
   * existing pending-send flush-on-reconnect path.
   */
  sendShadowControl(recipientUid: string, payload: ContentPayload): Promise<void>;
  /**
   * Begin an in-chat identity verification with `recipientUid` (§4). Generates a fresh session
   * seed, shares it over the E2E channel, and emits `verify-requested`. Both peers then derive the
   * same rotating code; the recipient answers via {@link respondVerification} (§4.2, §4.3).
   */
  requestVerification(recipientUid: string): Promise<void>;
  /**
   * Answer a verification request from `recipientUid` by submitting the current rotating code (§4.2).
   * `kind: 'duress'` submits the duress code instead — it verifies identically to the requester but
   * also fires a SILENT alert to `trustedContactUid` if one is configured (§4.3). Indistinguishable
   * to an observer from a normal response.
   */
  respondVerification(
    recipientUid: string,
    kind: VerificationResponseKind,
    trustedContactUid?: string,
  ): Promise<void>;
  /** Subscribe to {@link VerificationEvent}s driving the per-session verification badge (§4.3). */
  onVerification(listener: (event: VerificationEvent) => void): Unsubscribe;
  /**
   * Handle an inbound `CiphertextEnvelope` from the Realtime_Client: decrypt and render the
   * plaintext, or surface a `delivery-error` with no plaintext on decryption failure
   * (Requirements 5.4, 5.5, 6.9).
   */
  onEnvelope(envelope: CiphertextEnvelope): Promise<void>;
  /**
   * Subscribe to conversation state changes as {@link ConversationEvent}s, fed by consumers
   * into the shared {@link reduce} / `ConversationReducer` so both platforms render through
   * one pure path (design Component 7, Requirement 6.7).
   */
  onConversationUpdate(listener: (event: ConversationEvent) => void): Unsubscribe;
  /** Detach all transport subscriptions and cancel outstanding ack timers. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Internal pending-send bookkeeping.
// ---------------------------------------------------------------------------

/**
 * An outbound message awaiting either transmission (while disconnected) or an ack (after
 * transmission). The frame is built and encrypted exactly once at `send` time and reused
 * verbatim on flush, so the libsignal ratchet is never advanced twice for one message and
 * the pending send flushes exactly once (Property 16).
 */
interface PendingSend {
  /** Client-side row id, for status updates + ack/timeout resolution. */
  id: string;
  /** Conversation key components (the ack frame echoes `recipientUid` + `seq`). */
  recipientUid: string;
  seq: number;
  /** The fully-built, already-encrypted wire frame to transmit. */
  frame: ClientToServerFrame;
  /**
   * `queued`       — not yet transmitted; awaiting the next connection (no ack timer; 5.10).
   * `awaiting-ack` — transmitted; the 30 s ack deadline is armed (5.6, 5.11).
   */
  state: 'queued' | 'awaiting-ack';
  /** The armed ack-deadline timer while `awaiting-ack`, else `null`. */
  ackTimer: TimerHandle | null;
  /**
   * Shadow thread this send belongs to, or absent for a surface send (Shadow Chat). Carried so the
   * ack→`sent` and timeout→`failed` status events are tagged with the same `threadId` and route to
   * the shadow conversation rather than the surface one.
   */
  threadId?: string;
  /**
   * When set, the ack→`sent` / timeout→`failed` transition emits NO `status-updated` conversation
   * event (Shadow Chat Invites). The invite/accept/decline/revoke control payloads carry no visible
   * row and must never materialise or mutate a surface `ConversationState`, preserving the inviter's
   * no-surface-disturbance invariant (Req 1.6, 10.4, Correctness Property 8).
   */
  silentAck?: boolean;
}

/** Default {@link Scheduler} bound to the host timer functions. */
const defaultScheduler: Scheduler = {
  setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    if (handle !== null && handle !== undefined) {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    }
  },
};

/** Key a pending send by its conversation + sequence number (the ack echoes both). */
function pendingKey(recipientUid: string, seq: number): string {
  return `${recipientUid}:${seq}`;
}

/** Upper bound on a routable shadow threadId — matches the content-payload codec's `isThreadId`. */
const THREAD_ID_MAX_LENGTH = 255;

/**
 * Normalise an optional `threadId` to the value the orchestrator routes on (Shadow Chat). Returns
 * the string only when it is routable — a non-empty string of 1..255 characters, the exact bounds
 * `content-payload`'s codec treats as a real threadId — so the allocated seq space (shadow vs
 * surface) and the threadId actually encoded into the body can never disagree. Anything else
 * (undefined, empty, over-length) collapses to `undefined` ⇒ surface chat.
 */
function routableThreadId(threadId: string | undefined): string | undefined {
  return typeof threadId === 'string' && threadId.length > 0 && threadId.length <= THREAD_ID_MAX_LENGTH
    ? threadId
    : undefined;
}

/**
 * Project a persisted {@link AttachmentRef} to the render-facing shape, optionally attaching the
 * in-memory decrypted bytes. Deliberately DROPS the key/iv: the rendered message (and thus every
 * `ConversationEvent`) never carries the content key, which stays confined to the store row.
 */
function renderableFromRef(ref: AttachmentRef, data?: Uint8Array): RenderableAttachment {
  return {
    blobId: ref.blobId,
    mediaType: ref.mediaType,
    size: ref.size,
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

/**
 * Defensive C1 / Property 5 invariant guard: the shadow `threadId` rides ONLY inside the encrypted
 * body, so the serialized {@link CiphertextEnvelope} must expose neither a `threadId` nor any
 * plaintext field. The current codec has no such field by construction; this guard fails fast if a
 * future codec change ever regressed that, before any frame is transmitted.
 */
function assertWireSafe(envelope: CiphertextEnvelope): void {
  if (
    Object.prototype.hasOwnProperty.call(envelope, 'threadId') ||
    Object.prototype.hasOwnProperty.call(envelope, 'plaintext')
  ) {
    throw new Error('CiphertextEnvelope must not carry a threadId or plaintext field on the wire');
  }
}

// ---------------------------------------------------------------------------
// Default implementation.
// ---------------------------------------------------------------------------

/**
 * Default {@link Messaging} orchestrator backed by the injected ports (design Component 5).
 *
 * Wires itself to the Realtime_Client on construction: inbound `deliver` frames route to
 * {@link onEnvelope}, inbound `ack` frames resolve the matching pending send, and a
 * transition to `connected` flushes the pending-send queue (5.10). Call {@link dispose}
 * to detach those subscriptions and cancel any armed ack timers.
 */
export class DefaultMessaging implements Messaging {
  private readonly realtime: MessagingRealtime;
  private readonly sessions: SessionManager;
  private readonly sequence: SequenceAllocator;
  private readonly codec: EnvelopeCodec;
  private readonly keyClaimer: PreKeyClaimClient;
  private readonly sender: LocalSenderResolver;
  private readonly store: MessagingStore;
  /**
   * Optional factory binding a per-thread shadow {@link SequenceAllocator} (Shadow Chat). Present
   * only when the platform adapter injected one; surface-only deployments leave it undefined and the
   * shadow code paths are never reached.
   */
  private readonly shadowSequence?: (threadId: string) => SequenceAllocator;
  /** Inbound interceptor for Shadow Chat Invites control payloads (design Component E). */
  private readonly shadowInvites?: InboundShadowControlHandler;
  /** Device-local row→thread recorder for shadow rows (Shadow Chat Invites, Req 14). */
  private readonly recordRow?: (rowId: string, threadId: string) => void | Promise<void>;
  /** Encrypted-attachment ciphertext transport (Req 7); absent in text-only constructions. */
  private readonly blobs?: BlobStore;

  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly ackTimeoutMs: number;

  /** Pending sends keyed by `${recipientUid}:${seq}` (queued or awaiting-ack). */
  private readonly pending = new Map<string, PendingSend>();

  /** In-memory per-conversation disappearing TTL (ms), so new rows can be stamped (Req 4.1/4.2). */
  private readonly conversationTtls = new Map<string, number>();
  /** Live set of messages awaiting expiry, keyed by row id (Req 4.2). */
  private readonly expiring = new Map<string, { expiresAt: number; remoteUid: string }>();
  /** The single armed purge timer for the soonest expiry, or `null`. */
  private purgeTimer: TimerHandle | null = null;

  /**
   * Monotonic sentinel seq, in the shadow space (`≥1e9`), for the local-only `failed` row produced
   * when a shadow send is attempted with no {@link shadowSequence} factory configured. It consumes
   * no persisted counter and never reaches the wire; living in the shadow space keeps its key
   * disjoint from every surface seq.
   */
  private shadowMisconfigSeq = SHADOW_SEQ_OFFSET;

  private readonly updateListeners = new Set<(event: ConversationEvent) => void>();
  private readonly typingListeners = new Set<(fromUid: string) => void>();
  private readonly verificationListeners = new Set<(event: VerificationEvent) => void>();
  /**
   * Per-peer serialization queues for inbound envelope processing. Each peer's envelopes are
   * chained onto a promise so they are processed one-at-a-time in arrival order, preventing
   * concurrent libsignal session access that can corrupt the Double Ratchet state when multiple
   * frames arrive close together (e.g. verify-response triggering a sendControl while a text
   * message is being decrypted).
   */
  private readonly envelopeQueues = new Map<string, Promise<void>>();
  /**
   * Per-peer in-chat-verification seeds, RAM-only and session-scoped: cleared on `dispose`
   * (app lock/exit), so verification state never outlives the session (§4.4) and the seed is
   * never persisted (ephemeral-by-construction).
   */
  private readonly verificationSeeds = new Map<string, Uint8Array>();
  private readonly transportUnsubscribers: Unsubscribe[];

  constructor(deps: MessagingDeps, options: MessagingOptions) {
    if (typeof options.generateId !== 'function') {
      throw new TypeError('MessagingOptions.generateId must be a function');
    }

    this.realtime = deps.realtime;
    this.sessions = deps.sessions;
    this.sequence = deps.sequence;
    this.codec = deps.codec;
    this.keyClaimer = deps.keyClaimer;
    this.sender = deps.sender;
    this.store = deps.store;
    this.shadowSequence = deps.shadowSequence;
    this.shadowInvites = deps.shadowInvites;
    this.recordRow = deps.recordRow;
    this.blobs = deps.blobs;

    this.generateId = options.generateId;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

    // Wire the transport: inbound frames + reconnect-driven flush (5.6, 5.10).
    this.transportUnsubscribers = [
      this.realtime.onFrame((frame) => {
        this.handleFrame(frame);
      }),
      this.realtime.onStatus((status) => {
        if (status === 'connected') {
          this.flushPending();
        }
      }),
    ];

    // Re-arm disappearing-message purges from persisted rows so a relaunch keeps deleting
    // already-expired and soon-to-expire messages (Req 4.2). Fire-and-forget: a load failure
    // must not break construction.
    void this.initPurgeSchedule();
  }

  // -------------------------------------------------------------------------
  // Public API.
  // -------------------------------------------------------------------------

  /** @inheritdoc */
  async send(recipientUid: string, plaintext: string, options?: SendOptions): Promise<void> {
    const id = this.generateId();
    const viewOnce = options?.viewOnce === true;
    // Resolve the routable shadow threadId (absent ⇒ surface). The bounds match the content-payload
    // codec's `isThreadId`, so the seq space (shadow vs surface) and the encoded body never disagree.
    const threadId = routableThreadId(options?.threadId);

    // Select the sequence allocator: the per-thread shadow allocator for a shadow send (seq ≥1e9),
    // else the surface allocator (seq <1e9). A shadow send with no configured shadow factory is a
    // misconfiguration: fail locally with the text retained WITHOUT consuming a surface seq or
    // leaking the message into the surface conversation (Shadow Chat, Req 3.6, 5.2).
    const allocator = this.allocatorFor(threadId);
    if (allocator === null) {
      await this.failShadowMisconfig(id, recipientUid, plaintext, threadId as string, viewOnce);
      return;
    }

    // Allocate the per-conversation sequence number up front so the row and the envelope
    // share one strictly-increasing seq (Requirements 5.3, 6.2).
    const seq = await allocator.next(recipientUid);

    // Optimistically render the outbound message as `sending` before any network work
    // (design §12 optimistic UI; Requirements 5.10, 6.2).
    const row: MessageRow = {
      id,
      remoteUid: recipientUid,
      direction: 'out',
      seq,
      plaintext,
      status: 'sending',
      createdAt: this.now(),
      ...(viewOnce ? { viewOnce: true } : {}),
    };
    // Stamp the disappearing-message expiry from the conversation's active timer (Req 4.2):
    // the sender's clock starts at send time. The messaging purge engine is keyed by `remoteUid`
    // (surface), so a shadow row is NOT stamped here — that would apply the SURFACE timer to a
    // shadow message; thread-scoped shadow purge is handled per-thread by the registry/reducer.
    if (threadId === undefined) {
      this.stampExpiry(row);
    }
    await this.store.appendMessage(row);
    if (threadId !== undefined) {
      await this.recordRow?.(id, threadId); // device-local row→thread tag for per-thread purge (Req 14)
    }
    this.emitUpdate({
      type: 'message-appended',
      message: {
        id,
        seq,
        direction: 'out',
        text: plaintext,
        status: 'sending',
        createdAt: row.createdAt,
        ...(viewOnce ? { viewOnce: true } : {}),
      },
      remoteUid: recipientUid,
      ...(threadId !== undefined ? { threadId } : {}),
    });

    // Encode the text as the versioned content payload, then run the shared session/encrypt/
    // envelope/transmit tail (the same path attachments use).
    await this.dispatch(
      id,
      recipientUid,
      seq,
      { type: 'text', body: plaintext, ...(viewOnce ? { viewOnce: true } : {}) },
      threadId,
    );
  }

  /**
   * Shared send tail for any content payload (text or attachment): resolve the local sender,
   * establish a libsignal session on first send, encrypt the (already shadow-threaded) payload, build
   * the wire-safe envelope, register the pending/ack entry, and transmit (or hold for reconnect). Any
   * expected delivery problem — no sender identity, no recipient keys, encrypt failure — marks the
   * optimistic row `failed` with its content retained rather than throwing (Requirements 5.1, 5.2,
   * 5.9, 5.10). The optimistic row + `message-appended` emit is the CALLER's responsibility, so this
   * stays payload-shape agnostic.
   */
  private async dispatch(
    id: string,
    recipientUid: string,
    seq: number,
    payload: ContentPayload,
    threadId: string | undefined,
  ): Promise<void> {
    // Resolve the local routing identity; without it the message cannot be addressed (5.9).
    const sender = await this.sender.resolveSender();
    if (sender === null) {
      await this.markFailed(id, recipientUid, 'not registered (no device id)', threadId);
      return;
    }

    // Establish a libsignal session on first send to this recipient (5.1, 5.2). A claim
    // miss (no recipient device) or any establish/encrypt failure transmits nothing and
    // retains the content as `failed` (Requirements 5.9; design Scenarios 6, 11).
    let body;
    try {
      if (!(await this.sessions.hasSession(recipientUid))) {
        const bundle = await this.keyClaimer.claim(recipientUid);
        if (bundle === null) {
          await this.markFailed(id, recipientUid, 'recipient has no published keys', threadId);
          return;
        }
        await this.sessions.establishSession(recipientUid, bundle);
      }
      // Wrap the payload in the versioned content envelope (Phase 2). For a shadow send the
      // `threadId` rides INSIDE this encrypted body (Shadow Chat, Req 3.1) — never on the wire
      // envelope. A legacy peer that predates a given payload type decodes it to `unsupported`.
      body = await this.sessions.encrypt(recipientUid, encodeContentPayload(payload, threadId));
    } catch (err) {
      // A short reason is surfaced for diagnosis; the raw error (which may carry sensitive
      // material, 8.5) is never logged or transmitted.
      const reason = err instanceof Error ? err.message.slice(0, 80) : 'unknown';
      await this.markFailed(id, recipientUid, `encrypt failed: ${reason}`, threadId);
      return;
    }

    // Build the wire frame once. The codec has no plaintext field, so plaintext cannot be
    // serialized to the socket (Requirements 5.3, 5.7, 8.2). For a shadow message the only on-wire
    // difference is `seq` (≥1e9); the threadId stays inside the encrypted body.
    const envelope = this.codec.encode(
      { senderUid: sender.uid, recipientUid, senderDeviceId: sender.deviceId, seq },
      body,
    );
    // Defensive C1 / Property 5 invariant: the serialized envelope must expose neither a `threadId`
    // nor any plaintext field (the threadId rides only inside the ciphertext). Holds by construction
    // for the current codec; this guard fails fast if a future codec change ever regressed it.
    assertWireSafe(envelope);
    const frame: ClientToServerFrame = { kind: 'send', envelope };

    // Pending/ack key stays `${recipientUid}:${seq}` — disjoint across surface/shadow because the
    // seq spaces are disjoint by construction (surface <1e9 ≤ shadow), so ack matching is correct
    // for both (Shadow Chat, Req 4.4).
    const entry: PendingSend = {
      id,
      recipientUid,
      seq,
      frame,
      state: 'queued',
      ackTimer: null,
      ...(threadId !== undefined ? { threadId } : {}),
    };
    this.pending.set(pendingKey(recipientUid, seq), entry);

    // Transmit now if connected, else hold for flush-on-reconnect (5.10).
    if (this.realtime.getStatus() === 'connected') {
      this.transmit(entry);
    }
  }

  /** @inheritdoc */
  async sendAttachment(
    recipientUid: string,
    content: OutgoingAttachment,
    options?: SendOptions,
  ): Promise<void> {
    const id = this.generateId();
    const threadId = routableThreadId(options?.threadId);

    // Same allocator selection as text: a shadow send needs the per-thread allocator; its absence is
    // a misconfiguration that fails locally rather than leaking onto the surface (Shadow Chat, 3.6).
    const allocator = this.allocatorFor(threadId);
    if (allocator === null) {
      this.failAttachment(id, recipientUid, content, threadId, 'shadow chat not configured');
      return;
    }
    const seq = await allocator.next(recipientUid);

    // Encrypt locally under a fresh per-attachment AES-256-GCM key, then upload ONLY the ciphertext
    // (Req 7.1/7.2). The key + iv stay on the device and ride solely inside the E2E payload below.
    if (this.blobs === undefined) {
      this.failAttachment(id, recipientUid, content, threadId, 'attachments unavailable');
      return;
    }
    let key: string;
    let iv: string;
    let blobId: string;
    let size: number;
    try {
      const enc = await encryptAttachment(content.data);
      key = Buffer.from(enc.key).toString('base64');
      iv = Buffer.from(enc.iv).toString('base64');
      size = enc.ciphertext.length;
      blobId = await this.blobs.put(enc.ciphertext);
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 80) : 'unknown';
      this.failAttachment(id, recipientUid, content, threadId, `attachment upload failed: ${reason}`);
      return;
    }

    const ref: AttachmentRef = {
      blobId,
      key,
      iv,
      mediaType: content.mediaType,
      size,
      ...(content.name !== undefined ? { name: content.name } : {}),
    };
    // Optimistic row + emit, mirroring text send. `plaintext` is null (captions are not part of the
    // attachment wire payload in this version); the decrypted bytes ride on the emit for immediate
    // local render, while the persisted row keeps key/iv so a relaunch can re-fetch + re-decrypt.
    const row: MessageRow = {
      id,
      remoteUid: recipientUid,
      direction: 'out',
      seq,
      plaintext: null,
      status: 'sending',
      createdAt: this.now(),
      attachment: ref,
    };
    if (threadId === undefined) {
      this.stampExpiry(row);
    }
    await this.store.appendMessage(row);
    if (threadId !== undefined) {
      await this.recordRow?.(id, threadId);
    }
    this.emitUpdate({
      type: 'message-appended',
      message: {
        id,
        seq,
        direction: 'out',
        text: null,
        status: 'sending',
        createdAt: row.createdAt,
        attachment: renderableFromRef(ref, content.data),
      },
      remoteUid: recipientUid,
      ...(threadId !== undefined ? { threadId } : {}),
    });

    // Send the attachment routing/key payload over the SAME encrypted channel as text (Req 7.2):
    // the content key travels only here, never to the blob store.
    await this.dispatch(id, recipientUid, seq, { type: 'attachment', ...ref }, threadId);
  }

  /**
   * Append + emit a `failed` attachment row when a send cannot even reach the transmit stage
   * (shadow misconfig, no blob transport, or encrypt/upload failure) — so the user sees the failed
   * media in place, with its bytes retained for a retry, rather than a silent drop.
   */
  private failAttachment(
    id: string,
    recipientUid: string,
    content: OutgoingAttachment,
    threadId: string | undefined,
    reason: string,
  ): void {
    const render: RenderableAttachment = {
      blobId: '',
      mediaType: content.mediaType,
      size: content.data.length,
      ...(content.name !== undefined ? { name: content.name } : {}),
      data: content.data,
    };
    this.emitUpdate({
      type: 'message-appended',
      message: {
        id,
        seq: -1,
        direction: 'out',
        text: null,
        status: 'failed',
        createdAt: this.now(),
        error: reason,
        attachment: render,
      },
      remoteUid: recipientUid,
      ...(threadId !== undefined ? { threadId } : {}),
    });
  }

  /** @inheritdoc */
  async retryMessage(
    recipientUid: string,
    target: MessageTarget,
    options?: ControlOptions,
  ): Promise<void> {
    // Only an outbound row this device sent can be retried (you can't resend a peer's message).
    if (target.direction !== 'out') {
      return;
    }
    const threadId = routableThreadId(options?.threadId);

    // Locate the failed row from the durable store (the source of truth that survives a relaunch).
    const rows = await this.store.loadMessages();
    const row = rows.find(
      (r) => r.remoteUid === recipientUid && r.direction === 'out' && r.seq === target.seq,
    );
    // Idempotent: nothing to do if the row is gone, already in flight, or already acknowledged.
    if (row === undefined || row.status !== 'failed') {
      return;
    }

    // Reconstruct the content payload from the persisted row. The core does not retain the raw
    // attachment bytes, so an attachment is only resendable once its ciphertext was uploaded (a
    // non-empty blobId); a row whose upload never produced a handle is left failed.
    let payload: ContentPayload;
    if (row.attachment !== undefined) {
      if (row.attachment.blobId.length === 0) {
        return;
      }
      payload = { type: 'attachment', ...row.attachment };
    } else if (row.plaintext !== null) {
      payload = { type: 'text', body: row.plaintext, ...(row.viewOnce ? { viewOnce: true } : {}) };
    } else {
      return; // a deleted/empty row carries nothing to resend
    }

    // Flip back to `sending` (clearing the prior error) and re-drive the shared send tail with the
    // SAME id + seq — no new row, no new sequence number, so the message updates in place.
    await this.store.updateMessageStatus(row.id, 'sending');
    this.emitUpdate({
      type: 'status-updated',
      id: row.id,
      status: 'sending',
      remoteUid: recipientUid,
      ...(threadId !== undefined ? { threadId } : {}),
    });
    await this.dispatch(row.id, recipientUid, row.seq, payload, threadId);
  }

  /** @inheritdoc */
  async onEnvelope(envelope: CiphertextEnvelope): Promise<void> {
    const id = this.generateId();
    let plaintext: string;
    try {
      plaintext = await this.sessions.decrypt(envelope);
    } catch {
      // Decryption failed: render no plaintext and mark delivery-error (Requirements 5.5, 6.9).
      // This path runs BEFORE decode, so the shadow `threadId` (which lives INSIDE the
      // undecryptable body) is unknowable here — the error necessarily stays on the surface
      // conversation (design Error Scenario 2). A shadow thread cannot be revealed by a frame we
      // could not decrypt in the first place.
      const errorRow: MessageRow = {
        id,
        remoteUid: envelope.senderUid,
        direction: 'in',
        seq: envelope.seq,
        plaintext: null,
        status: 'delivery-error',
        createdAt: this.now(),
      };
      await this.store.appendMessage(errorRow);
      this.emitUpdate({
        type: 'inbound-delivery-error',
        id,
        seq: envelope.seq,
        remoteUid: envelope.senderUid,
        createdAt: errorRow.createdAt,
      });
      return;
    }

    // The decrypted plaintext is a versioned content payload (Phase 2). Decoding is total and
    // backward-compatible: a legacy Phase 1 bare-string plaintext decodes as text (Req 3.1).
    // The decoder also surfaces an optional shadow `threadId` (Shadow Chat, Req 5.2): when present
    // EVERY event emitted below is tagged with it so the `ConversationRegistry` routes them to the
    // shadow conversation; when absent the path is byte-for-byte the surface behaviour. The seq is
    // `envelope.seq` (already ≥1e9 for a shadow message), and the reaction/edit/delete
    // `targetOutbound`→local-direction flip is unchanged.
    const { payload, threadId } = decodeContentPayload(plaintext);
    const threadTag = threadId !== undefined ? { threadId } : {};
    const remoteUid = envelope.senderUid;
    switch (payload.type) {
      case 'text': {
        const viewOnce = payload.viewOnce === true;
        const row: MessageRow = {
          id,
          remoteUid,
          direction: 'in',
          seq: envelope.seq,
          plaintext: payload.body,
          status: 'received',
          createdAt: this.now(),
          ...(viewOnce ? { viewOnce: true } : {}),
        };
        // The recipient's disappearing-message clock starts when the message arrives (Req 4.2).
        // As on the send path, the messaging purge engine is surface-scoped (keyed by `remoteUid`),
        // so a shadow row is not stamped here; thread-scoped purge is a per-thread concern.
        if (threadId === undefined) {
          this.stampExpiry(row);
        }
        await this.store.appendMessage(row);
        if (threadId !== undefined) {
          await this.recordRow?.(id, threadId); // device-local row→thread tag for per-thread purge (Req 14)
        }
        this.emitUpdate({
          type: 'message-appended',
          message: {
            id,
            seq: envelope.seq,
            direction: 'in',
            text: payload.body,
            status: 'received',
            createdAt: row.createdAt,
            ...(viewOnce ? { viewOnce: true } : {}),
          },
          remoteUid,
          ...threadTag,
        });
        return;
      }
      // Reaction/edit/delete reference a message in the SENDER's frame; flip `targetOutbound`
      // to THIS device's local direction (a message the peer sent is inbound here). An unknown
      // target is ignored by the reducer and the store (Req 3.5). The store write keeps the
      // mutation durable so it survives a relaunch alongside the base message rows. For a shadow
      // message `targetSeq` is ≥1e9, so the store keys stay disjoint from surface mutations.
      case 'reaction': {
        const targetDirection = payload.targetOutbound ? 'in' : 'out';
        await this.store.applyReaction(remoteUid, targetDirection, payload.targetSeq, payload.emoji);
        this.emitUpdate({
          type: 'reaction-applied',
          targetDirection,
          targetSeq: payload.targetSeq,
          emoji: payload.emoji,
          remoteUid,
          ...threadTag,
        });
        this.emitUpdate({ type: 'inbound-control-frame', seq: envelope.seq, remoteUid, ...threadTag });
        return;
      }
      case 'edit': {
        const targetDirection = payload.targetOutbound ? 'in' : 'out';
        await this.store.applyEdit(remoteUid, targetDirection, payload.targetSeq, payload.body);
        this.emitUpdate({
          type: 'message-edited',
          targetDirection,
          targetSeq: payload.targetSeq,
          body: payload.body,
          remoteUid,
          ...threadTag,
        });
        this.emitUpdate({ type: 'inbound-control-frame', seq: envelope.seq, remoteUid, ...threadTag });
        return;
      }
      case 'delete': {
        const targetDirection = payload.targetOutbound ? 'in' : 'out';
        await this.store.applyDelete(remoteUid, targetDirection, payload.targetSeq);
        this.emitUpdate({
          type: 'message-deleted',
          targetDirection,
          targetSeq: payload.targetSeq,
          remoteUid,
          ...threadTag,
        });
        this.emitUpdate({ type: 'inbound-control-frame', seq: envelope.seq, remoteUid, ...threadTag });
        return;
      }
      case 'timer':
        // Per-conversation disappearing timer. For a SURFACE timer (no threadId) keep the existing
        // behaviour: converge both peers on the same TTL (Req 4.1) and keep the in-memory copy so
        // subsequently-received messages are stamped for purge (4.2). For a SHADOW timer we only
        // emit the (threadId-tagged) event so the thread's `ConversationState` converges, WITHOUT
        // writing the surface-scoped `conversationTtls`/store (keyed by `remoteUid`), which would
        // cross-contaminate the surface conversation's stamping (Shadow Chat, Req 7.3).
        if (threadId === undefined) {
          this.conversationTtls.set(remoteUid, Math.max(0, payload.ttlMs));
          await this.store.setConversationTimer(remoteUid, Math.max(0, payload.ttlMs));
        }
        this.emitUpdate({ type: 'timer-changed', ttlMs: payload.ttlMs, remoteUid, ...threadTag });
        this.emitUpdate({ type: 'inbound-control-frame', seq: envelope.seq, remoteUid, ...threadTag });
        return;
      case 'attachment': {
        // E2E attachment (Req 7): the payload carries the blob handle + the per-attachment key/iv
        // (which arrived ONLY inside this decrypted body, never from the store). Download the
        // ciphertext and decrypt locally. The persisted row keeps the key/iv so a relaunch can
        // re-fetch + re-decrypt; the decrypted bytes ride on the emit for immediate render.
        const ref: AttachmentRef = {
          blobId: payload.blobId,
          key: payload.key,
          iv: payload.iv,
          mediaType: payload.mediaType,
          size: payload.size,
          ...(payload.name !== undefined ? { name: payload.name } : {}),
        };
        let data: Uint8Array;
        try {
          if (this.blobs === undefined) {
            throw new Error('no blob transport');
          }
          const ciphertext = await this.blobs.get(payload.blobId);
          data = await decryptAttachment({
            ciphertext,
            key: new Uint8Array(Buffer.from(payload.key, 'base64')),
            iv: new Uint8Array(Buffer.from(payload.iv, 'base64')),
          });
        } catch {
          // No transport, a failed download, or a failed/tampered decrypt (GCM auth): surface a
          // delivery-error row rather than dropping the message. The row keeps the ref so a retry
          // (e.g. once a blob transport exists, or the blob becomes reachable) can resolve it.
          const errorRow: MessageRow = {
            id,
            remoteUid,
            direction: 'in',
            seq: envelope.seq,
            plaintext: null,
            status: 'delivery-error',
            createdAt: this.now(),
            attachment: ref,
          };
          await this.store.appendMessage(errorRow);
          if (threadId !== undefined) {
            await this.recordRow?.(id, threadId);
          }
          this.emitUpdate({
            type: 'inbound-delivery-error',
            id,
            seq: envelope.seq,
            remoteUid,
            createdAt: errorRow.createdAt,
            ...threadTag,
          });
          return;
        }
        const row: MessageRow = {
          id,
          remoteUid,
          direction: 'in',
          seq: envelope.seq,
          plaintext: null,
          status: 'received',
          createdAt: this.now(),
          attachment: ref,
        };
        // Recipient's disappearing clock starts on arrival (Req 4.2); surface-scoped like text.
        if (threadId === undefined) {
          this.stampExpiry(row);
        }
        await this.store.appendMessage(row);
        if (threadId !== undefined) {
          await this.recordRow?.(id, threadId);
        }
        this.emitUpdate({
          type: 'message-appended',
          message: {
            id,
            seq: envelope.seq,
            direction: 'in',
            text: null,
            status: 'received',
            createdAt: row.createdAt,
            attachment: renderableFromRef(ref, data),
          },
          remoteUid,
          ...threadTag,
        });
        return;
      }
      case 'verify-request':
        // The peer is starting a verification and shared the session seed (§4.2). Hold it in RAM
        // and prompt the local user to answer with the rotating code (§4.3).
        this.verificationSeeds.set(remoteUid, verificationSeedFromBase64(payload.seed));
        this.emitVerification({ type: 'verify-incoming', peerUid: remoteUid });
        this.emitUpdate({ type: 'inbound-control-frame', seq: envelope.seq, remoteUid, ...threadTag });
        return;
      case 'verify-response': {
        // We requested verification; classify the responder's code. Both a normal and a duress
        // code count as a pass to us — the duress path is indistinguishable here by design (§4.3);
        // any side effect of duress fires on the responder's device, not ours.
        const seed = this.verificationSeeds.get(remoteUid);
        let ok = false;
        if (seed !== undefined) {
          const kind = await classifyVerificationCode(seed, payload.code, this.now());
          ok = kind !== 'invalid';
        }
        // Tell the responder the outcome so their badge converges with ours (§4.3), then show ours.
        await this.sendControl(remoteUid, { type: 'verify-result', ok });
        this.emitVerification({ type: 'verify-result', peerUid: remoteUid, ok });
        this.emitUpdate({ type: 'inbound-control-frame', seq: envelope.seq, remoteUid, ...threadTag });
        return;
      }
      case 'verify-result':
        // The requester reported the outcome of the code we submitted; mirror their badge (§4.3).
        this.emitVerification({ type: 'verify-result', peerUid: remoteUid, ok: payload.ok });
        this.emitUpdate({ type: 'inbound-control-frame', seq: envelope.seq, remoteUid, ...threadTag });
        return;
      case 'duress-alert':
        // We are a configured trusted contact: surface the silent duress alert discreetly (§4.3).
        this.emitVerification({ type: 'duress-alert-received', peerUid: payload.peerUid });
        this.emitUpdate({ type: 'inbound-control-frame', seq: envelope.seq, remoteUid, ...threadTag });
        return;
      case 'shadow-invite':
      case 'shadow-accept':
      case 'shadow-decline':
      case 'shadow-revoke':
        // Shadow Chat Invites control payloads (design Component E). Intercepted BEFORE conversation
        // routing and handled entirely by the ShadowInviteCoordinator (open/close thread, purge
        // history, emit lifecycle events) — they NEVER become a conversation row and never reach the
        // ConversationRegistry as a message. When no coordinator is wired they are ignored, exactly
        // like any other control an older surface-only build does not consume (forward-compat).
        await this.shadowInvites?.handleInbound(remoteUid, payload);
        this.emitUpdate({ type: 'inbound-control-frame', seq: envelope.seq, remoteUid, ...threadTag });
        return;
      case 'unsupported':
        // A payload type this client version does not understand; ignore (forward-compat).
        this.emitUpdate({ type: 'inbound-control-frame', seq: envelope.seq, remoteUid, ...threadTag });
        return;
      default: {
        const _exhaustive: never = payload;
        void _exhaustive;
        return;
      }
    }
  }

  /** @inheritdoc */
  async react(
    recipientUid: string,
    target: MessageTarget,
    emoji: string,
    options?: ControlOptions,
  ): Promise<void> {
    const threadId = routableThreadId(options?.threadId);
    // Persist first so the reaction survives a relaunch even if the network send fails. For a shadow
    // reaction `target.seq` is ≥1e9, so the store keys stay disjoint from any surface mutation.
    await this.store.applyReaction(recipientUid, target.direction, target.seq, emoji);
    await this.sendControl(
      recipientUid,
      { type: 'reaction', targetSeq: target.seq, targetOutbound: target.direction === 'out', emoji },
      {
        type: 'reaction-applied',
        targetDirection: target.direction,
        targetSeq: target.seq,
        emoji,
        remoteUid: recipientUid,
        ...(threadId !== undefined ? { threadId } : {}),
      },
      threadId,
    );
  }

  /** @inheritdoc */
  async editMessage(
    recipientUid: string,
    target: MessageTarget,
    body: string,
    options?: ControlOptions,
  ): Promise<void> {
    const threadId = routableThreadId(options?.threadId);
    await this.store.applyEdit(recipientUid, target.direction, target.seq, body);
    await this.sendControl(
      recipientUid,
      { type: 'edit', targetSeq: target.seq, targetOutbound: target.direction === 'out', body },
      {
        type: 'message-edited',
        targetDirection: target.direction,
        targetSeq: target.seq,
        body,
        remoteUid: recipientUid,
        ...(threadId !== undefined ? { threadId } : {}),
      },
      threadId,
    );
  }

  /** @inheritdoc */
  async deleteMessage(
    recipientUid: string,
    target: MessageTarget,
    options?: ControlOptions,
  ): Promise<void> {
    const threadId = routableThreadId(options?.threadId);
    await this.store.applyDelete(recipientUid, target.direction, target.seq);
    await this.sendControl(
      recipientUid,
      { type: 'delete', targetSeq: target.seq, targetOutbound: target.direction === 'out' },
      {
        type: 'message-deleted',
        targetDirection: target.direction,
        targetSeq: target.seq,
        remoteUid: recipientUid,
        ...(threadId !== undefined ? { threadId } : {}),
      },
      threadId,
    );
  }

  /** @inheritdoc */
  async setDisappearingTimer(
    recipientUid: string,
    ttlMs: number,
    options?: ControlOptions,
  ): Promise<void> {
    const threadId = routableThreadId(options?.threadId);
    // A SURFACE timer keeps the existing behaviour (in-memory TTL + persisted, so new surface rows
    // are stamped). A SHADOW timer is only sent + emitted (threadId-tagged) so the thread's state
    // converges, WITHOUT writing the surface-scoped `conversationTtls`/store keyed by `remoteUid`,
    // which would cross-contaminate the surface conversation's stamping (Shadow Chat, Req 7.3).
    if (threadId === undefined) {
      this.conversationTtls.set(recipientUid, Math.max(0, ttlMs));
      await this.store.setConversationTimer(recipientUid, Math.max(0, ttlMs));
    }
    await this.sendControl(
      recipientUid,
      { type: 'timer', ttlMs },
      {
        type: 'timer-changed',
        ttlMs,
        remoteUid: recipientUid,
        ...(threadId !== undefined ? { threadId } : {}),
      },
      threadId,
    );
  }

  /** @inheritdoc */
  primeConversationTtl(recipientUid: string, ttlMs: number): void {
    this.conversationTtls.set(recipientUid, Math.max(0, ttlMs));
  }

  /** @inheritdoc */
  sendTyping(recipientUid: string): void {
    if (this.realtime.getStatus() !== 'connected') {
      return;
    }
    try {
      this.realtime.send({ kind: 'typing', recipientUid });
    } catch {
      // Best-effort: a typing hint is disposable, so a transient send failure is ignored.
    }
  }

  /** @inheritdoc */
  onTyping(listener: (fromUid: string) => void): Unsubscribe {
    this.typingListeners.add(listener);
    return () => {
      this.typingListeners.delete(listener);
    };
  }

  /** @inheritdoc */
  async sendShadowControl(recipientUid: string, payload: ContentPayload): Promise<void> {
    // Surface-addressed control frame (no threadId): the shadow-* control rides inside the existing
    // E2E ciphertext between the two real UIDs, identical in shape to a verification control. The
    // ack is SILENT (no status-updated event) so the inviter's surface chat stays byte-for-byte
    // untouched (Req 1.6, 10.4, Property 8).
    await this.sendControl(recipientUid, payload, undefined, undefined, true);
  }

  /** @inheritdoc */
  async requestVerification(recipientUid: string): Promise<void> {
    // Fresh per-session seed (RAM only); share it over E2E so both peers derive the same codes (§4.2).
    const seed = generateVerificationSeed();
    this.verificationSeeds.set(recipientUid, seed);
    this.emitVerification({ type: 'verify-requested', peerUid: recipientUid });
    await this.sendControl(recipientUid, {
      type: 'verify-request',
      seed: verificationSeedToBase64(seed),
    });
  }

  /** @inheritdoc */
  async respondVerification(
    recipientUid: string,
    kind: VerificationResponseKind,
    trustedContactUid?: string,
  ): Promise<void> {
    const seed = this.verificationSeeds.get(recipientUid);
    if (seed === undefined) {
      // No active request from this peer (or the session reset); nothing to answer.
      return;
    }
    const codes = await currentVerificationCodes(seed, this.now());
    const code = kind === 'duress' ? codes.duress : codes.normal;
    await this.sendControl(recipientUid, { type: 'verify-response', code });
    if (kind === 'duress' && trustedContactUid !== undefined && trustedContactUid.length > 0) {
      // Fire the silent alert to the trusted contact over the same encrypted channel — never via
      // SMS/Call Log (Restricted Permissions this app does not request) (§4.2).
      await this.sendControl(trustedContactUid, { type: 'duress-alert', peerUid: recipientUid });
    }
  }

  /** @inheritdoc */
  onVerification(listener: (event: VerificationEvent) => void): Unsubscribe {
    this.verificationListeners.add(listener);
    return () => {
      this.verificationListeners.delete(listener);
    };
  }

  /** @inheritdoc */
  onConversationUpdate(listener: (event: ConversationEvent) => void): Unsubscribe {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  /** @inheritdoc */
  dispose(): void {
    for (const unsubscribe of this.transportUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        // Best-effort detach.
      }
    }
    for (const entry of this.pending.values()) {
      this.clearAckTimer(entry);
    }
    this.pending.clear();
    this.typingListeners.clear();
    this.verificationListeners.clear();
    // Session-scoped verification seeds never survive the session (§4.4).
    this.verificationSeeds.clear();
    if (this.purgeTimer !== null) {
      this.scheduler.clearTimeout(this.purgeTimer);
      this.purgeTimer = null;
    }
    this.expiring.clear();
  }

  // -------------------------------------------------------------------------
  // Disappearing-message purge engine (Req 4.2 / 4.4).
  // -------------------------------------------------------------------------

  /**
   * Stamp `row.expiresAt` from the conversation's active timer (if any) and register it for
   * purging. The clock starts at the row's own `createdAt`, which is send time for an outbound
   * row and receive time for an inbound one (Req 4.2).
   */
  private stampExpiry(row: MessageRow): void {
    const ttl = this.conversationTtls.get(row.remoteUid) ?? 0;
    if (ttl <= 0) {
      return;
    }
    row.expiresAt = row.createdAt + ttl;
    this.expiring.set(row.id, { expiresAt: row.expiresAt, remoteUid: row.remoteUid });
    this.reschedulePurge();
  }

  /** Load persisted rows on construction and re-arm purges (including already-expired). */
  private async initPurgeSchedule(): Promise<void> {
    let rows: MessageRow[];
    try {
      rows = await this.store.loadMessages();
    } catch {
      return;
    }
    for (const row of rows) {
      if (row.expiresAt !== undefined && Number.isFinite(row.expiresAt)) {
        this.expiring.set(row.id, { expiresAt: row.expiresAt, remoteUid: row.remoteUid });
      }
    }
    // Purge anything already past due immediately, then arm the next timer.
    await this.runPurge();
  }

  /** Snapshot the live expiring set as {@link ExpiringEntry} list for the pure expiry helpers. */
  private expiringEntries(): ExpiringEntry[] {
    return [...this.expiring.entries()].map(([id, { expiresAt }]) => ({ id, expiresAt }));
  }

  /** (Re)arm a single timer for the soonest pending expiry, or none when nothing is pending. */
  private reschedulePurge(): void {
    if (this.purgeTimer !== null) {
      this.scheduler.clearTimeout(this.purgeTimer);
      this.purgeTimer = null;
    }
    const delay = msUntilNextExpiry(this.expiringEntries(), this.now());
    if (delay === null) {
      return;
    }
    this.purgeTimer = this.scheduler.setTimeout(() => {
      this.purgeTimer = null;
      void this.runPurge();
    }, delay);
  }

  /**
   * Purge every message whose expiry has elapsed: erase it from the store (plaintext overwrite),
   * drop it from the UI via a `messages-expired` event per conversation, and re-arm the next
   * timer (Req 4.2). Safe to call repeatedly; a no-op when nothing is due.
   */
  private async runPurge(): Promise<void> {
    const expiredIds = selectExpired(this.expiringEntries(), this.now());
    if (expiredIds.length === 0) {
      this.reschedulePurge();
      return;
    }
    // Group by conversation so each chat gets one removal event.
    const byConversation = new Map<string, string[]>();
    for (const id of expiredIds) {
      const entry = this.expiring.get(id);
      this.expiring.delete(id);
      if (entry === undefined) {
        continue;
      }
      const list = byConversation.get(entry.remoteUid) ?? [];
      list.push(id);
      byConversation.set(entry.remoteUid, list);
    }
    try {
      await this.store.purgeMessages(expiredIds);
    } catch {
      // A store failure must not crash the loop; the rows stay tracked-removed in memory and
      // a later relaunch re-attempts via initPurgeSchedule.
    }
    for (const [remoteUid, ids] of byConversation) {
      this.emitUpdate({ type: 'messages-expired', ids, remoteUid });
    }
    this.reschedulePurge();
  }

  // -------------------------------------------------------------------------
  // Transmission + ack/timeout.
  // -------------------------------------------------------------------------

  /**
   * Transmit a queued send and arm its ack deadline (5.6, 5.11). If the transport throws
   * (the socket raced to closed), the message is left `queued` so it flushes exactly once
   * on the next reconnect rather than being lost or double-sent (Property 16).
   */
  private transmit(entry: PendingSend): void {
    try {
      this.realtime.send(entry.frame);
    } catch {
      // Not actually transmitted; keep it queued for the next flush.
      entry.state = 'queued';
      this.clearAckTimer(entry);
      return;
    }
    entry.state = 'awaiting-ack';
    this.clearAckTimer(entry);
    entry.ackTimer = this.scheduler.setTimeout(() => {
      entry.ackTimer = null;
      this.handleAckTimeout(entry);
    }, this.ackTimeoutMs);
  }

  /**
   * Flush every queued send once the connection is (re)established, transmitting each
   * exactly once. Already-`awaiting-ack` entries are left alone so a reconnect mid-wait
   * never re-sends them (Requirement 5.10, Property 16).
   */
  private flushPending(): void {
    for (const entry of this.pending.values()) {
      if (entry.state === 'queued') {
        this.transmit(entry);
      }
    }
  }

  /**
   * Enqueue an inbound envelope for per-peer serial processing. Chaining onto the existing
   * promise for this sender ensures that all envelopes from the same peer are processed
   * one-at-a-time in arrival order, preventing concurrent libsignal session access.
   */
  private enqueueEnvelope(senderUid: string, envelope: CiphertextEnvelope): void {
    const prev = this.envelopeQueues.get(senderUid) ?? Promise.resolve();
    // Always run the next envelope even if the previous one threw (chain via .then + .catch).
    const next = prev.then(() => this.onEnvelope(envelope)).catch(() => {});
    this.envelopeQueues.set(senderUid, next);
  }

  /** Route an inbound frame: `deliver` → decrypt+render (serialised per-peer); `ack` → resolve send; `typing` → hint. */
  private handleFrame(frame: ServerToClientFrame): void {
    if (frame.kind === 'deliver') {
      // Serialise per-peer so concurrent libsignal session access cannot corrupt ratchet state.
      this.enqueueEnvelope(frame.envelope.senderUid, frame.envelope);
      return;
    }
    if (frame.kind === 'ack') {
      void this.handleAck(frame.recipientUid, frame.seq, frame.nodes);
      return;
    }
    if (frame.kind === 'typing') {
      for (const listener of this.typingListeners) {
        try {
          listener(frame.fromUid);
        } catch {
          // A listener throwing must not break the orchestrator.
        }
      }
    }
  }

  /**
   * A Backend_API acknowledgment arrived within the deadline: transition the matching
   * pending send `sending → sent` and stop tracking it (Requirements 5.6, 6.5).
   */
  private async handleAck(recipientUid: string, seq: number, nodes?: number): Promise<void> {
    const key = pendingKey(recipientUid, seq);
    const entry = this.pending.get(key);
    if (entry === undefined) {
      return;
    }
    this.clearAckTimer(entry);
    this.pending.delete(key);
    await this.store.updateMessageStatus(entry.id, 'sent');
    if (entry.silentAck === true) {
      // A shadow-invite/accept/decline/revoke control: carries no visible row, so emit NO conversation
      // status event — the inviter's surface ConversationState must stay byte-for-byte untouched.
      return;
    }
    // `nodes` (diagnostic): how many recipient nodes the server fanned the envelope to.
    // 0 ⇒ the recipient had no live presence entry, so the server queued it for
    // store-and-forward and will deliver it when they next connect.
    const info =
      nodes === undefined
        ? undefined
        : nodes === 0
          ? 'queued (recipient offline)'
          : `delivered to ${nodes} device${nodes === 1 ? '' : 's'}`;
    this.emitUpdate({
      type: 'status-updated',
      id: entry.id,
      status: 'sent',
      remoteUid: recipientUid,
      ...(info !== undefined ? { error: info } : {}),
      // Route the status transition to the same conversation (shadow or surface) the send belonged
      // to, so a shadow ack never surfaces on the surface chat (Shadow Chat, Req 5.2).
      ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
    });
  }

  /**
   * No acknowledgment within the deadline: transition the message `sending → failed`,
   * retaining its text in the list, and stop tracking it (Requirements 5.11, 6.8).
   */
  private handleAckTimeout(entry: PendingSend): void {
    const key = pendingKey(entry.recipientUid, entry.seq);
    if (this.pending.get(key) !== entry) {
      // Already resolved (acked) — nothing to do.
      return;
    }
    this.pending.delete(key);
    void this.markFailed(
      entry.id,
      entry.recipientUid,
      'no server ack (timeout)',
      entry.threadId,
      entry.silentAck === true,
    );
  }

  // -------------------------------------------------------------------------
  // Internal helpers.
  // -------------------------------------------------------------------------

  /**
   * Encrypt and transmit a control content payload (reaction/edit/delete), optimistically
   * applying `optimistic` to the local conversation first. Control messages carry no visible
   * message row, so a failure is dropped silently (the optimistic local change stands). Reuses
   * the pending-send + ack machinery so a control message also flushes on reconnect.
   */
  private async sendControl(
    recipientUid: string,
    payload: ContentPayload,
    optimistic?: ConversationEvent,
    threadId?: string,
    silentAck = false,
  ): Promise<void> {
    // Optimistically apply locally so the sender sees their own reaction/edit/delete at once.
    // Verification/duress control frames carry no visible row, so they pass no optimistic event.
    if (optimistic !== undefined) {
      this.emitUpdate(optimistic);
    }
    const sender = await this.sender.resolveSender();
    if (sender === null) {
      return;
    }
    // Choose the per-thread shadow allocator for a shadow control message (seq ≥1e9), else the
    // surface allocator. A shadow control message with no configured factory is a misconfiguration:
    // drop the network send silently (the optimistic local change stands), consistent with how a
    // control-message transmit failure is otherwise handled — never falling back to a surface seq.
    const allocator = this.allocatorFor(threadId);
    if (allocator === null) {
      return;
    }
    const seq = await allocator.next(recipientUid);
    let body;
    try {
      if (!(await this.sessions.hasSession(recipientUid))) {
        const bundle = await this.keyClaimer.claim(recipientUid);
        if (bundle === null) {
          return;
        }
        await this.sessions.establishSession(recipientUid, bundle);
      }
      // The `threadId` (when present) rides INSIDE the encrypted body, exactly as for a text send.
      body = await this.sessions.encrypt(recipientUid, encodeContentPayload(payload, threadId));
    } catch {
      return;
    }
    const id = this.generateId();
    const envelope = this.codec.encode(
      { senderUid: sender.uid, recipientUid, senderDeviceId: sender.deviceId, seq },
      body,
    );
    assertWireSafe(envelope);
    const entry: PendingSend = {
      id,
      recipientUid,
      seq,
      frame: { kind: 'send', envelope },
      state: 'queued',
      ackTimer: null,
      ...(threadId !== undefined ? { threadId } : {}),
      ...(silentAck ? { silentAck: true } : {}),
    };
    this.pending.set(pendingKey(recipientUid, seq), entry);
    if (this.realtime.getStatus() === 'connected') {
      this.transmit(entry);
    }
  }

  /** Mark an outbound message `failed` (text retained) in the store and to listeners (5.9, 5.11, 6.8). */
  private async markFailed(
    id: string,
    remoteUid: string,
    reason?: string,
    threadId?: string,
    silent = false,
  ): Promise<void> {
    await this.store.updateMessageStatus(id, 'failed');
    if (silent) {
      // Shadow control message (no visible row): never emit a surface/shadow status event.
      return;
    }
    this.emitUpdate({
      type: 'status-updated',
      id,
      status: 'failed',
      remoteUid,
      ...(reason !== undefined ? { error: reason } : {}),
      // Keep the failure on the same conversation the send belonged to (Shadow Chat, Req 5.2).
      ...(threadId !== undefined ? { threadId } : {}),
    });
  }

  /**
   * Select the {@link SequenceAllocator} for a send/control message: the surface allocator when
   * `threadId` is absent, or a fresh per-thread shadow allocator from {@link shadowSequence} when a
   * `threadId` is present. Returns `null` for the misconfiguration where a shadow message is
   * requested but no shadow factory was injected — the caller then fails/drops locally rather than
   * leaking the message onto the surface conversation (Shadow Chat, Req 3.6).
   */
  private allocatorFor(threadId: string | undefined): SequenceAllocator | null {
    if (threadId === undefined) {
      return this.sequence;
    }
    if (this.shadowSequence === undefined) {
      return null;
    }
    return this.shadowSequence(threadId);
  }

  /**
   * Handle a shadow send requested with no {@link shadowSequence} factory configured: append a
   * `failed` row (text retained, Req 5.9) tagged to the shadow thread and emit it, WITHOUT consuming
   * a surface sequence number or transmitting anything. The sentinel seq lives in the shadow space
   * so its key never collides with a surface message.
   */
  private async failShadowMisconfig(
    id: string,
    recipientUid: string,
    plaintext: string,
    threadId: string,
    viewOnce: boolean,
  ): Promise<void> {
    const seq = (this.shadowMisconfigSeq += 1);
    const row: MessageRow = {
      id,
      remoteUid: recipientUid,
      direction: 'out',
      seq,
      plaintext,
      status: 'failed',
      createdAt: this.now(),
      ...(viewOnce ? { viewOnce: true } : {}),
    };
    await this.store.appendMessage(row);
    this.emitUpdate({
      type: 'message-appended',
      message: {
        id,
        seq,
        direction: 'out',
        text: plaintext,
        status: 'failed',
        ...(viewOnce ? { viewOnce: true } : {}),
      },
      remoteUid: recipientUid,
      threadId,
    });
  }

  private clearAckTimer(entry: PendingSend): void {
    if (entry.ackTimer !== null) {
      this.scheduler.clearTimeout(entry.ackTimer);
      entry.ackTimer = null;
    }
  }

  private emitUpdate(event: ConversationEvent): void {
    for (const listener of this.updateListeners) {
      try {
        listener(event);
      } catch {
        // A listener throwing must not break the orchestrator.
      }
    }
  }

  private emitVerification(event: VerificationEvent): void {
    for (const listener of this.verificationListeners) {
      try {
        listener(event);
      } catch {
        // A listener throwing must not break the orchestrator.
      }
    }
  }
}

/**
 * Create a {@link Messaging} orchestrator over the injected ports + collaborators
 * (design Component 5). Subscribes to the Realtime_Client immediately; call
 * {@link Messaging.dispose} to detach.
 */
export function createMessaging(deps: MessagingDeps, options: MessagingOptions): Messaging {
  return new DefaultMessaging(deps, options);
}
