/**
 * `@chat-app/crypto` — `ConversationReducer` (Phase 1, design Component 7: UI).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Components and Interfaces" → "Client Component 7: UI (Sign_In_Screen +
 *   Conversation_Screen)".
 *
 * A pure, platform-agnostic reducer that maps the conversation's incoming events
 * (message arrivals, status updates, composer edits, connection changes, the web
 * ephemerality acknowledgment, and inbound delivery errors) onto a single
 * `ConversationState` snapshot. Both the Mobile_App (FlatList) and the Web_App
 * (virtual list) consume this exact reducer so render logic is identical across
 * platforms (Requirement 6.7).
 *
 * The reducer guarantees, for any arrival order and any duplication of events:
 *   - each message appears exactly once, keyed by `(remoteUid?/direction/seq)`, and
 *     the list is ordered chronologically by `createdAt` with a stable `seq` tiebreak
 *     (Requirements 6.2, 6.9, 2.1, 2.2);
 *   - `composer.canSend` is `true` only when the trimmed composer text is non-empty
 *     and its length is within 1..4096 (Requirements 6.3, 6.4);
 *   - inbound delivery-error entries carry `text === null` while failed outbound
 *     sends retain their text (Requirements 6.8, 6.9);
 *   - on web, messaging stays gated until the ephemerality warning is acknowledged
 *     (Requirements 7.7, 8.3).
 *
 * It performs no I/O, mutation, or other side effects: every event yields a brand-new
 * state value and the input `state` is never mutated, which keeps the reducer fully
 * unit- and property-testable and safe to drive React/React Native render cycles.
 */

import type { ConnectionStatus, MessageStatus } from '@chat-app/types';

/** Maximum composer length, inclusive, in characters (Requirement 6.3). */
export const COMPOSER_MAX_LENGTH = 4096;

/** Minimum composer length, inclusive, in characters (Requirement 6.3). */
export const COMPOSER_MIN_LENGTH = 1;

/**
 * A single message as rendered in the Conversation_Screen message list. Each entry is
 * uniquely identified within the list by its `(direction, seq)` pair so an inbound and
 * an outbound message may share a sequence number without colliding (Requirement 6.2).
 */
export interface RenderableMessage {
  /** Stable client-side identifier for the row (e.g. a UUID). */
  id: string;
  /** Per-conversation monotonic sequence number used for ordering (6.2). */
  seq: number;
  /** `out` for messages this device sent, `in` for messages it received. */
  direction: 'out' | 'in';
  /**
   * Wall-clock creation time in unix-ms, used as the PRIMARY render-ordering key (P2). Sourced
   * from `MessageRow.createdAt` for outbound messages and from the receive time for inbound
   * messages (both already exist in `messaging.ts`). Ordering by `createdAt` makes a
   * cross-direction back-and-forth and backfilled store-and-forward messages render
   * chronologically, instead of by the per-direction `seq` (which jumbles a real conversation).
   *
   * OPTIONAL at the type level for backward compatibility: an absent or non-finite value sorts as
   * if `0`, so legacy rows keep a deterministic position via the `seq`/`messageKey` tiebreak
   * (Requirements 2.1, 2.2).
   */
  createdAt?: number;
  /**
   * Decrypted text for display, or `null` for an inbound delivery-error entry whose
   * ciphertext could not be decrypted (Requirements 5.5, 6.9).
   */
  text: string | null;
  /** Lifecycle status driving the per-message indicator (6.5, 6.8, 6.9). */
  status: MessageStatus;
  /** Short diagnostic reason for a `failed` message (e.g. "no server ack"); optional. */
  error?: string;
  /**
   * Emoji reactions attached to this message (deduped), or absent when none. Applied from an
   * inbound `reaction-applied` event carrying a reaction E2E payload (Requirement 3.1).
   */
  reactions?: string[];
  /** `true` once an `message-edited` event has superseded this message's text (Req 3.2). */
  edited?: boolean;
  /**
   * `true` once a `message-deleted` tombstone has removed this message's content. The UI shows
   * a "message deleted" placeholder; distinct from `text === null` with a `delivery-error`
   * status, which means the ciphertext could not be decrypted (Requirements 3.3, 6.9).
   */
  deleted?: boolean;
  /**
   * `true` for a view-once message. On the recipient the UI gates it behind "tap to view" and
   * removes it (delete-on-display) once shown; on the sender it is just labelled (Req 4.3).
   */
  viewOnce?: boolean;
}

/**
 * The complete render state for the Conversation_Screen. Produced exclusively by
 * {@link reduce}; treated as immutable by consumers.
 */
export interface ConversationState {
  /** Connection indicator state surfaced by the Realtime_Client (4.7, 6.6). */
  connection: ConnectionStatus;
  /** Messages rendered chronologically by `createdAt` (stable `seq` tiebreak), each exactly once (6.2, 2.1, 2.2). */
  messages: RenderableMessage[];
  /**
   * Inbound sequence numbers that immediately follow a detected gap — i.e. for each `s`
   * in this list, at least one inbound `seq` between the previous received message and `s`
   * has not (yet) arrived. The UI renders a "messages may be missing" marker above the
   * message with that `seq` (Requirement 2.2).
   *
   * Derived purely from the set of received inbound seqs, so it is independent of arrival
   * order and self-correcting: once a missing message later arrives (store-and-forward
   * backfill) the gap simply disappears (Requirements 2.1–2.3). Only gaps strictly between
   * the lowest and highest received inbound seq are reported, so joining a conversation
   * mid-stream never produces a spurious leading gap.
   */
  missingBefore: number[];
  /**
   * Active disappearing-message timer for the conversation, in milliseconds; `0` means
   * disabled. Set by a `timer-changed` event so both peers agree on the same TTL (Req 4.1).
   * The actual scheduled deletion of expired messages is a store concern (task 4.2).
   */
  disappearingTtlMs: number;
  /** Composer text plus its derived send-enablement (6.3, 6.4). */
  composer: { text: string; canSend: boolean };
  /**
   * Whether the web ephemerality warning has been acknowledged. On web this gates all
   * messaging until `true`; on mobile it is left `true` so messaging is never gated
   * (Requirements 7.7, 8.3).
   */
  webWarningAcknowledged: boolean;
}

/**
 * Events fed to the {@link reduce} function. The union is discriminated on `type`.
 *
 * - `message-appended`        — a sent or received message enters the list (6.2).
 * - `status-updated`          — an existing message changes lifecycle status (6.5, 6.8).
 * - `composer-changed`        — the user edited the composer text (6.3, 6.4).
 * - `connection-changed`      — the Realtime_Client reported a new status (6.6).
 * - `web-warning-acknowledged`— the user acknowledged the web ephemerality warning (7.7, 8.3).
 * - `inbound-delivery-error`  — a received envelope failed decryption (5.5, 6.9).
 * - `reaction-applied`        — attach an emoji reaction to a target message (Req 3.1).
 * - `message-edited`          — supersede a target message's text (Req 3.2).
 * - `message-deleted`         — tombstone a target message's content (Req 3.3).
 *
 * The reaction/edit/delete events address their target by its LOCAL `(targetDirection,
 * targetSeq)`; the Messaging layer maps the on-wire sender-relative reference onto local
 * direction before dispatching. An event whose target is not in the list is ignored (3.5).
 *
 * Shadow Chat (design Component 5): every event that scopes to a single conversation carries an
 * OPTIONAL `threadId`. When present the event belongs to a shadow thread; when absent it belongs to
 * the surface chat (Shadow Chat, Req 5.2, 7.2). The pure {@link reduce} function deliberately
 * IGNORES `threadId` — it is read only by the `ConversationRegistry`, which routes each event to the
 * correct per-thread {@link ConversationState} before calling `reduce`. Adding it here therefore
 * does not change `reduce`'s behaviour for any existing or shadow event; it is purely a routing tag.
 */
export type ConversationEvent =
  | { type: 'message-appended'; message: RenderableMessage; remoteUid?: string; threadId?: string }
  | {
      type: 'status-updated';
      id: string;
      status: MessageStatus;
      remoteUid?: string;
      error?: string;
      threadId?: string;
    }
  | { type: 'composer-changed'; text: string }
  | { type: 'connection-changed'; connection: ConnectionStatus }
  | { type: 'web-warning-acknowledged' }
  | {
      type: 'inbound-delivery-error';
      id: string;
      seq: number;
      remoteUid?: string;
      /**
       * Receive time in unix-ms (P2). Stamped so a failed-decrypt row sorts chronologically in
       * place rather than jumping to the top of the list. Optional/absent sorts as if `0`.
       */
      createdAt?: number;
      threadId?: string;
    }
  | {
      type: 'reaction-applied';
      targetDirection: 'in' | 'out';
      targetSeq: number;
      emoji: string;
      remoteUid?: string;
      threadId?: string;
    }
  | {
      type: 'message-edited';
      targetDirection: 'in' | 'out';
      targetSeq: number;
      body: string;
      remoteUid?: string;
      threadId?: string;
    }
  | {
      type: 'message-deleted';
      targetDirection: 'in' | 'out';
      targetSeq: number;
      remoteUid?: string;
      threadId?: string;
    }
  | { type: 'timer-changed'; ttlMs: number; remoteUid?: string; threadId?: string }
  | { type: 'messages-expired'; ids: string[]; remoteUid?: string; threadId?: string };

/**
 * The reducer contract consumed by the platform UIs (design Component 7).
 */
export interface ConversationReducer {
  reduce(state: ConversationState, event: ConversationEvent): ConversationState;
}

/**
 * Compute whether the send control should be enabled for the given composer text.
 *
 * The send control is enabled only when the text, after trimming surrounding
 * whitespace, is non-empty and its length lies within the inclusive 1..4096 range
 * (Requirements 6.3, 6.4). Length is measured on the trimmed text so leading/trailing
 * whitespace neither enables an otherwise-empty message nor pushes a valid message
 * past the cap.
 */
export function canSendComposerText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= COMPOSER_MIN_LENGTH && trimmed.length <= COMPOSER_MAX_LENGTH;
}

/**
 * The initial, empty conversation state.
 *
 * @param platform - `'web'` starts gated (`webWarningAcknowledged: false`) so messaging
 *   is disabled until the ephemerality warning is acknowledged; `'mobile'` is never
 *   gated, so it starts acknowledged (Requirements 7.7, 8.3).
 */
export function initialConversationState(platform: 'mobile' | 'web'): ConversationState {
  return {
    connection: 'disconnected',
    messages: [],
    missingBefore: [],
    disappearingTtlMs: 0,
    composer: { text: '', canSend: false },
    webWarningAcknowledged: platform !== 'web',
  };
}

/**
 * Dedupe key for a rendered message. Inbound and outbound messages are keyed
 * separately so the same per-conversation `seq` for each direction does not collide
 * (Requirement 6.2). The conversation is 1:1, so `direction` plus `seq` uniquely
 * identifies a message within a single conversation's list.
 */
function messageKey(message: Pick<RenderableMessage, 'direction' | 'seq'>): string {
  return `${message.direction}:${message.seq}`;
}

/**
 * The render-ordering key for a message: its `createdAt` when finite, else `0` (P2). Absent or
 * non-finite timestamps (legacy rows) collapse to `0` so they retain a deterministic position via
 * the `seq`/`messageKey` tiebreak rather than sorting unpredictably (Requirements 2.1, 2.2).
 */
function orderKey(message: RenderableMessage): number {
  return typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)
    ? message.createdAt
    : 0;
}

/**
 * Insert or replace a message in the list, keeping it deduplicated by `(direction, seq)` (P2) and
 * ordered by `createdAt` ascending with a stable, total tiebreak. A repeated arrival for an
 * existing key replaces the stored entry rather than adding a duplicate row, so the list contains
 * each `(direction, seq)` exactly once regardless of arrival order or duplication (Requirement
 * 6.2 / 2.3).
 *
 * Primary order is wall-clock `createdAt` so a cross-direction back-and-forth renders
 * chronologically (Requirement 2.1). When two messages share the same `createdAt` (same-ms
 * send/receive, or legacy rows with no timestamp), the prior `seq`-then-`direction` ordering breaks
 * the tie, producing a deterministic total order independent of arrival order (Requirement 2.2).
 */
function upsertMessage(
  messages: readonly RenderableMessage[],
  incoming: RenderableMessage,
): RenderableMessage[] {
  const key = messageKey(incoming);
  const next = messages.filter((existing) => messageKey(existing) !== key);
  next.push(incoming);
  next.sort((a, b) => {
    const byTime = orderKey(a) - orderKey(b);
    if (byTime !== 0) {
      return byTime;
    }
    // Stable, total tiebreak when timestamps tie: fall back to the prior seq-then-direction
    // ordering so the comparator is deterministic for equal createdAt (Requirement 2.2).
    return a.seq === b.seq ? messageKey(a).localeCompare(messageKey(b)) : a.seq - b.seq;
  });
  return next;
}

/**
 * Derive the inbound sequence numbers that immediately follow a gap (Requirement 2).
 *
 * Computed from the SET of received inbound seqs (a `delivery-error` entry still counts as
 * received — the message arrived, it just couldn't be decrypted), so the result depends only
 * on which messages are present, not the order they arrived in. A seq `s` is reported when the
 * previous present inbound seq is not `s - 1`, meaning at least one message between them is
 * missing. Only gaps strictly between the lowest and highest received inbound seq are reported,
 * so a recipient who joins mid-stream is not shown a spurious leading gap, and backfilled
 * messages clear the gap automatically (Requirements 2.1, 2.3).
 */
function computeMissingBefore(messages: readonly RenderableMessage[]): number[] {
  const inboundSeqs = messages
    .filter((m) => m.direction === 'in')
    .map((m) => m.seq);
  if (inboundSeqs.length < 2) {
    return [];
  }
  const sorted = [...new Set(inboundSeqs)].sort((a, b) => a - b);
  const followsGap: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      followsGap.push(sorted[i]);
    }
  }
  return followsGap;
}

/**
 * Apply `transform` to the message matching `(direction, seq)`, returning a new list. If no
 * message matches, the original list is returned unchanged — so a reaction/edit/delete that
 * references an unknown message is silently ignored (Requirement 3.5). The matched entry is
 * replaced with a fresh object, never mutated.
 */
function transformMessage(
  messages: readonly RenderableMessage[],
  direction: 'in' | 'out',
  seq: number,
  transform: (message: RenderableMessage) => RenderableMessage,
): RenderableMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.direction === direction && message.seq === seq) {
      changed = true;
      return transform(message);
    }
    return message;
  });
  return changed ? next : (messages as RenderableMessage[]);
}

/**
 * Pure conversation reducer (Requirements 6.2–6.9, 7.7, 8.3).
 *
 * Returns a new {@link ConversationState} for each event without mutating `state`.
 * Events that target a message not present in the list (`status-updated`,
 * `inbound-delivery-error` for an unknown id) leave the message list unchanged so the
 * reducer tolerates out-of-order or duplicate events gracefully.
 */
export function reduce(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case 'message-appended': {
      const messages = upsertMessage(state.messages, event.message);
      return {
        ...state,
        messages,
        missingBefore: computeMissingBefore(messages),
      };
    }

    case 'status-updated':
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === event.id
            ? { ...message, status: event.status, ...(event.error !== undefined ? { error: event.error } : {}) }
            : message,
        ),
      };

    case 'composer-changed':
      return {
        ...state,
        composer: { text: event.text, canSend: canSendComposerText(event.text) },
      };

    case 'connection-changed':
      return { ...state, connection: event.connection };

    case 'web-warning-acknowledged':
      return { ...state, webWarningAcknowledged: true };

    case 'inbound-delivery-error': {
      // Render the inbound entry with no plaintext and a delivery-error status
      // (Requirements 5.5, 6.9). Deduped/ordered like any inbound message (6.2). The entry
      // still occupies its seq, so it counts as "received" for gap detection (Requirement 2).
      const messages = upsertMessage(state.messages, {
        id: event.id,
        seq: event.seq,
        direction: 'in',
        text: null,
        status: 'delivery-error',
        ...(event.createdAt !== undefined ? { createdAt: event.createdAt } : {}),
      });
      return {
        ...state,
        messages,
        missingBefore: computeMissingBefore(messages),
      };
    }

    case 'reaction-applied':
      // Attach the emoji to the target message (deduped). Unknown target → ignored (3.5).
      // A deleted message accepts no reactions.
      return {
        ...state,
        messages: transformMessage(state.messages, event.targetDirection, event.targetSeq, (m) =>
          m.deleted === true || (m.reactions ?? []).includes(event.emoji)
            ? m
            : { ...m, reactions: [...(m.reactions ?? []), event.emoji] },
        ),
      };

    case 'message-edited':
      // Supersede the target's text and mark it edited. A deleted message is not editable.
      return {
        ...state,
        messages: transformMessage(state.messages, event.targetDirection, event.targetSeq, (m) =>
          m.deleted === true ? m : { ...m, text: event.body, edited: true },
        ),
      };

    case 'message-deleted':
      // Tombstone the target: drop its content, reactions, and edited/error flags; mark it
      // deleted (3.3). Built explicitly so no stale fields linger on the tombstone.
      return {
        ...state,
        messages: transformMessage(state.messages, event.targetDirection, event.targetSeq, (m) => ({
          id: m.id,
          seq: m.seq,
          direction: m.direction,
          text: null,
          status: m.status,
          deleted: true,
          // Preserve the ordering key so the tombstone stays in chronological place (P2).
          ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
        })),
      };

    case 'timer-changed':
      // Both peers converge on the same disappearing-message TTL (Req 4.1); negative values
      // are clamped to 0 (disabled).
      return { ...state, disappearingTtlMs: Math.max(0, event.ttlMs) };

    case 'messages-expired': {
      // A disappearing message reached its expiry and was purged from the store; remove it from
      // the list entirely (not a tombstone — it should leave no trace) (Req 4.2). Unknown ids are
      // ignored. The gap markers are recomputed so a removed inbound seq doesn't read as a gap.
      const remove = new Set(event.ids);
      const messages = state.messages.filter((m) => !remove.has(m.id));
      if (messages.length === state.messages.length) {
        return state;
      }
      return { ...state, messages, missingBefore: computeMissingBefore(messages) };
    }

    default: {
      // Exhaustiveness guard: a new event variant must be handled explicitly.
      const _exhaustive: never = event;
      return state;
    }
  }
}

/**
 * Default {@link ConversationReducer} implementation wrapping the pure {@link reduce}
 * function, for consumers that prefer an object with a `reduce` method (design
 * Component 7) over the free function.
 */
export const conversationReducer: ConversationReducer = { reduce };
