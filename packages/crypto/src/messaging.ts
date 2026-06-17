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

import type { ConversationEvent } from './conversation-reducer';
import { decodeContentPayload, encodeContentPayload, type ContentPayload } from './content-payload';
import { msUntilNextExpiry, selectExpired, type ExpiringEntry } from './disappearing-timer';
import type { EnvelopeCodec } from './envelope-codec';
import type { MessageRow, Unsubscribe } from './ports';
import type { Scheduler, TimerHandle } from './realtime-client';
import type { SequenceAllocator } from './sequence-allocator';
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
}

export interface Messaging {
  /**
   * Send `plaintext` to `recipientUid`. Establishes a libsignal session first if needed,
   * allocates the next sequence number, encrypts, builds the envelope, and transmits — or
   * holds the frame for flush-on-reconnect while disconnected (Requirements 5.2, 5.10).
   * Never throws for an expected delivery problem (offline, no recipient device, encrypt
   * failure); those surface as a `failed` message with its text retained (5.9).
   */
  send(recipientUid: string, plaintext: string, options?: SendOptions): Promise<void>;
  /**
   * React to a prior message with an emoji (Requirement 3.1). `target` identifies the message
   * by its LOCAL direction + seq; the reaction rides as an E2E content payload and the peer
   * renders it against the same message.
   */
  react(recipientUid: string, target: MessageTarget, emoji: string): Promise<void>;
  /**
   * Edit a prior message's text (Requirement 3.2); the latest text supersedes the original.
   * Typically `target.direction === 'out'` (you edit your own messages).
   */
  editMessage(recipientUid: string, target: MessageTarget, body: string): Promise<void>;
  /**
   * Delete (tombstone) a prior message (Requirement 3.3); both sides replace its content with a
   * deleted placeholder. Typically `target.direction === 'out'`.
   */
  deleteMessage(recipientUid: string, target: MessageTarget): Promise<void>;
  /**
   * Set the conversation's disappearing-message timer (Req 4.1). `ttlMs` is the message
   * lifetime in milliseconds; `0` disables it. Sent as an E2E payload so both peers converge
   * on the same timer; applied optimistically locally.
   */
  setDisappearingTimer(recipientUid: string, ttlMs: number): Promise<void>;
  /**
   * Seed the in-memory disappearing-timer for a conversation WITHOUT sending or persisting it
   * (Req 4.1). Used on relaunch to restore a previously-agreed timer so messages sent in the new
   * session are stamped with the right expiry, without re-notifying the peer.
   */
  primeConversationTtl(recipientUid: string, ttlMs: number): void;
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

  private readonly updateListeners = new Set<(event: ConversationEvent) => void>();
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
    // Allocate the per-conversation sequence number up front so the row and the envelope
    // share one strictly-increasing seq (Requirements 5.3, 6.2).
    const seq = await this.sequence.next(recipientUid);
    const id = this.generateId();
    const viewOnce = options?.viewOnce === true;

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
    // the sender's clock starts at send time.
    this.stampExpiry(row);
    await this.store.appendMessage(row);
    this.emitUpdate({
      type: 'message-appended',
      message: {
        id,
        seq,
        direction: 'out',
        text: plaintext,
        status: 'sending',
        ...(viewOnce ? { viewOnce: true } : {}),
      },
      remoteUid: recipientUid,
    });

    // Resolve the local routing identity; without it the message cannot be addressed (5.9).
    const sender = await this.sender.resolveSender();
    if (sender === null) {
      await this.markFailed(id, recipientUid, 'not registered (no device id)');
      return;
    }

    // Establish a libsignal session on first send to this recipient (5.1, 5.2). A claim
    // miss (no recipient device) or any establish/encrypt failure transmits nothing and
    // retains the text as `failed` (Requirements 5.9; design Scenarios 6, 11).
    let body;
    try {
      if (!(await this.sessions.hasSession(recipientUid))) {
        const bundle = await this.keyClaimer.claim(recipientUid);
        if (bundle === null) {
          await this.markFailed(id, recipientUid, 'recipient has no published keys');
          return;
        }
        await this.sessions.establishSession(recipientUid, bundle);
      }
      body = await this.sessions.encrypt(
        recipientUid,
        // Wrap plain text in the versioned content payload (Phase 2). The recipient decodes it
        // back to text; a legacy peer that decodes the JSON as a bare string still shows it.
        encodeContentPayload({ type: 'text', body: plaintext, ...(viewOnce ? { viewOnce: true } : {}) }),
      );
    } catch (err) {
      // A short reason is surfaced for diagnosis; the raw error (which may carry sensitive
      // material, 8.5) is never logged or transmitted.
      const reason = err instanceof Error ? err.message.slice(0, 80) : 'unknown';
      await this.markFailed(id, recipientUid, `encrypt failed: ${reason}`);
      return;
    }

    // Build the wire frame once. The codec has no plaintext field, so plaintext cannot be
    // serialized to the socket (Requirements 5.3, 5.7, 8.2).
    const envelope = this.codec.encode(
      { senderUid: sender.uid, recipientUid, senderDeviceId: sender.deviceId, seq },
      body,
    );
    const frame: ClientToServerFrame = { kind: 'send', envelope };

    const entry: PendingSend = { id, recipientUid, seq, frame, state: 'queued', ackTimer: null };
    this.pending.set(pendingKey(recipientUid, seq), entry);

    // Transmit now if connected, else hold for flush-on-reconnect (5.10).
    if (this.realtime.getStatus() === 'connected') {
      this.transmit(entry);
    }
  }

  /** @inheritdoc */
  async onEnvelope(envelope: CiphertextEnvelope): Promise<void> {
    const id = this.generateId();
    let plaintext: string;
    try {
      plaintext = await this.sessions.decrypt(envelope);
    } catch {
      // Decryption failed: render no plaintext and mark delivery-error (Requirements 5.5, 6.9).
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
      this.emitUpdate({ type: 'inbound-delivery-error', id, seq: envelope.seq, remoteUid: envelope.senderUid });
      return;
    }

    // The decrypted plaintext is a versioned content payload (Phase 2). Decoding is total and
    // backward-compatible: a legacy Phase 1 bare-string plaintext decodes as text (Req 3.1).
    const payload = decodeContentPayload(plaintext);
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
        this.stampExpiry(row);
        await this.store.appendMessage(row);
        this.emitUpdate({
          type: 'message-appended',
          message: {
            id,
            seq: envelope.seq,
            direction: 'in',
            text: payload.body,
            status: 'received',
            ...(viewOnce ? { viewOnce: true } : {}),
          },
          remoteUid,
        });
        return;
      }
      // Reaction/edit/delete reference a message in the SENDER's frame; flip `targetOutbound`
      // to THIS device's local direction (a message the peer sent is inbound here). An unknown
      // target is ignored by the reducer and the store (Req 3.5). The store write keeps the
      // mutation durable so it survives a relaunch alongside the base message rows.
      case 'reaction': {
        const targetDirection = payload.targetOutbound ? 'in' : 'out';
        await this.store.applyReaction(remoteUid, targetDirection, payload.targetSeq, payload.emoji);
        this.emitUpdate({
          type: 'reaction-applied',
          targetDirection,
          targetSeq: payload.targetSeq,
          emoji: payload.emoji,
          remoteUid,
        });
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
        });
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
        });
        return;
      }
      case 'timer':
        // Per-conversation disappearing timer: converge both peers on the same TTL (Req 4.1) and
        // keep the in-memory copy so subsequently-received messages are stamped for purge (4.2).
        this.conversationTtls.set(remoteUid, Math.max(0, payload.ttlMs));
        await this.store.setConversationTimer(remoteUid, Math.max(0, payload.ttlMs));
        this.emitUpdate({ type: 'timer-changed', ttlMs: payload.ttlMs, remoteUid });
        return;
      case 'unsupported':
        // A payload type this client version does not understand; ignore (forward-compat).
        return;
      default: {
        const _exhaustive: never = payload;
        void _exhaustive;
        return;
      }
    }
  }

  /** @inheritdoc */
  async react(recipientUid: string, target: MessageTarget, emoji: string): Promise<void> {
    // Persist first so the reaction survives a relaunch even if the network send fails.
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
      },
    );
  }

  /** @inheritdoc */
  async editMessage(recipientUid: string, target: MessageTarget, body: string): Promise<void> {
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
      },
    );
  }

  /** @inheritdoc */
  async deleteMessage(recipientUid: string, target: MessageTarget): Promise<void> {
    await this.store.applyDelete(recipientUid, target.direction, target.seq);
    await this.sendControl(
      recipientUid,
      { type: 'delete', targetSeq: target.seq, targetOutbound: target.direction === 'out' },
      {
        type: 'message-deleted',
        targetDirection: target.direction,
        targetSeq: target.seq,
        remoteUid: recipientUid,
      },
    );
  }

  /** @inheritdoc */
  async setDisappearingTimer(recipientUid: string, ttlMs: number): Promise<void> {
    this.conversationTtls.set(recipientUid, Math.max(0, ttlMs));
    await this.store.setConversationTimer(recipientUid, Math.max(0, ttlMs));
    await this.sendControl(
      recipientUid,
      { type: 'timer', ttlMs },
      { type: 'timer-changed', ttlMs, remoteUid: recipientUid },
    );
  }

  /** @inheritdoc */
  primeConversationTtl(recipientUid: string, ttlMs: number): void {
    this.conversationTtls.set(recipientUid, Math.max(0, ttlMs));
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

  /** Route an inbound frame: `deliver` → decrypt+render; `ack` → resolve the matching send. */
  private handleFrame(frame: ServerToClientFrame): void {
    if (frame.kind === 'deliver') {
      // Fire-and-forget: onEnvelope persists + emits; a rejection cannot break the socket.
      void this.onEnvelope(frame.envelope);
      return;
    }
    if (frame.kind === 'ack') {
      void this.handleAck(frame.recipientUid, frame.seq, frame.nodes);
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
    void this.markFailed(entry.id, entry.recipientUid, 'no server ack (timeout)');
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
    optimistic: ConversationEvent,
  ): Promise<void> {
    // Optimistically apply locally so the sender sees their own reaction/edit/delete at once.
    this.emitUpdate(optimistic);
    const sender = await this.sender.resolveSender();
    if (sender === null) {
      return;
    }
    const seq = await this.sequence.next(recipientUid);
    let body;
    try {
      if (!(await this.sessions.hasSession(recipientUid))) {
        const bundle = await this.keyClaimer.claim(recipientUid);
        if (bundle === null) {
          return;
        }
        await this.sessions.establishSession(recipientUid, bundle);
      }
      body = await this.sessions.encrypt(recipientUid, encodeContentPayload(payload));
    } catch {
      return;
    }
    const id = this.generateId();
    const envelope = this.codec.encode(
      { senderUid: sender.uid, recipientUid, senderDeviceId: sender.deviceId, seq },
      body,
    );
    const entry: PendingSend = {
      id,
      recipientUid,
      seq,
      frame: { kind: 'send', envelope },
      state: 'queued',
      ackTimer: null,
    };
    this.pending.set(pendingKey(recipientUid, seq), entry);
    if (this.realtime.getStatus() === 'connected') {
      this.transmit(entry);
    }
  }

  /** Mark an outbound message `failed` (text retained) in the store and to listeners (5.9, 5.11, 6.8). */
  private async markFailed(id: string, remoteUid: string, reason?: string): Promise<void> {
    await this.store.updateMessageStatus(id, 'failed');
    this.emitUpdate({
      type: 'status-updated',
      id,
      status: 'failed',
      remoteUid,
      ...(reason !== undefined ? { error: reason } : {}),
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
}

/**
 * Create a {@link Messaging} orchestrator over the injected ports + collaborators
 * (design Component 5). Subscribes to the Realtime_Client immediately; call
 * {@link Messaging.dispose} to detach.
 */
export function createMessaging(deps: MessagingDeps, options: MessagingOptions): Messaging {
  return new DefaultMessaging(deps, options);
}
