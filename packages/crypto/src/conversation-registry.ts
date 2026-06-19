/**
 * `@chat-app/crypto` — `ConversationRegistry` (Shadow Chat, design Component 5).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Component 5: ConversationRegistry —
 * per-thread state" and Correctness Property 8 (thread isolation / no cross-thread bleed).
 *
 * A shadow message and a surface message between the same two UIDs share ONE server-side
 * conversation, but the client must keep their rendered state completely separate: separate history,
 * separate gap detection, separate reactions/edits/deletes/timers, and shadow threads must never
 * leak into the default chat list, notifications, or previews. The registry achieves this by holding
 * one {@link ConversationState} per conversation — keyed `surface:${remoteUid}` or
 * `shadow:${threadId}` — and dispatching each {@link ConversationEvent} through the EXISTING,
 * UNCHANGED pure {@link reduce}. Because each conversation has its own state, gap detection
 * (`computeMissingBefore`) operates only on that thread's sequence numbers and a reaction/edit/
 * delete/timer attaches only within the thread it is tagged for (Requirements 7.1–7.8).
 *
 * The pure reducer is deliberately ignorant of `threadId`: it is the registry, and only the
 * registry, that reads the optional `threadId` on an event and routes it to the correct per-thread
 * state. `conversation-reducer.ts` is NOT modified.
 *
 * ## Routing
 *
 * Each conversation-scoped event carries an optional `threadId` (present ⇒ shadow) and, for the
 * message/reaction/edit/delete/timer/error events, a `remoteUid` (the peer). {@link apply} routes:
 *   - `threadId` present ⇒ the shadow conversation `shadow:${threadId}`;
 *   - else `remoteUid` present ⇒ the surface conversation `surface:${remoteUid}` (unchanged path).
 *
 * The three purely conversation-UI events that carry NEITHER a `remoteUid` nor a `threadId`
 * (`composer-changed`, `connection-changed`, `web-warning-acknowledged`) are not per-conversation
 * routable from the event alone. They are therefore OUT OF SCOPE for the registry's per-conversation
 * message routing: the registry focuses on per-CONVERSATION message/reaction/edit/delete/timer
 * routing, and a platform adapter that needs to drive composer/connection/web-warning state applies
 * those directly to the specific {@link ConversationState} it is rendering (via {@link getState} +
 * `reduce`) rather than through this router. {@link apply} silently ignores such untagged events.
 *
 * ## Shadow-thread creation vs. unknown-thread rejection (the `getState`/`apply` tension)
 *
 * {@link getState} creates an empty state on first access (it is an explicit accessor — the caller
 * has named the conversation it wants). {@link apply}, by contrast, must NOT auto-create a shadow
 * thread for an arbitrary INBOUND event, or a peer could conjure a thread on our device merely by
 * tagging a `threadId` (Requirement 7.8). The two are reconciled as follows:
 *   - **Surface** conversations auto-create on first {@link apply} (existing Phase 1/2 behaviour).
 *   - **Shadow** threads are created EXPLICITLY: either by {@link openShadowThread} (the UI opens the
 *     thread via the `/alias` flow), or by the first LOCALLY-INITIATED outbound send into the thread
 *     (an outbound `message-appended` — the user sending the first shadow message). Both are
 *     locally-initiated, so they cannot be forced by a remote peer.
 *   - Any OTHER shadow-tagged event (an inbound message, a status update, a reaction/edit/delete/
 *     timer, a delivery error) whose thread has not been opened is REJECTED: {@link apply} throws an
 *     {@link UnknownShadowThreadError} and leaves every conversation's state unmodified. This holds
 *     Requirement 7.8 without breaking 7.1/7.2 (a thread you have opened or are opening accepts its
 *     events normally).
 */

import {
  initialConversationState,
  reduce,
  type ConversationEvent,
  type ConversationState,
} from './conversation-reducer';

/**
 * Identifies which conversation a stream of events belongs to (design Component 5). A surface
 * conversation is keyed solely by the peer's `remoteUid`; a shadow conversation is keyed by its
 * server-opaque `threadId` and additionally carries the `peerUid` it belongs to (the two real users
 * whose shared master secret derived the thread id).
 */
export type ConversationKey =
  | { kind: 'surface'; remoteUid: string }
  | { kind: 'shadow'; threadId: string; peerUid: string };

/**
 * A single entry in the DEFAULT (surface) chat list. Shadow threads are NEVER represented here, so
 * the chat list, notifications, and previews built from {@link ConversationRegistry.listSurfaceConversations}
 * cannot reveal that a shadow thread exists (Requirements 7.5, 7.6, design §9.2).
 */
export interface SurfaceListEntry {
  /** The peer this surface conversation is with. */
  remoteUid: string;
  /** The conversation's current immutable render state. */
  state: ConversationState;
}

/** Construction options for {@link DefaultConversationRegistry}. */
export interface ConversationRegistryOptions {
  /**
   * Platform whose initial {@link ConversationState} gating applies to every conversation this
   * registry creates (`'web'` starts gated behind the ephemerality acknowledgment; `'mobile'` is
   * never gated — see {@link initialConversationState}). Defaults to `'mobile'`.
   */
  platform?: 'mobile' | 'web';
}

/**
 * Thrown by {@link ConversationRegistry.apply} when an event tagged with a `threadId` is routed to a
 * shadow thread that has not been opened (Requirement 7.8). The registry leaves every conversation's
 * state unmodified before throwing, so a rejected event has no observable effect. A shadow thread is
 * opened explicitly via {@link ConversationRegistry.openShadowThread} or by the first locally-initiated
 * outbound send; an INBOUND event for an unknown thread is rejected rather than auto-creating it.
 */
export class UnknownShadowThreadError extends Error {
  /** The unknown shadow thread id the rejected event was tagged with. */
  readonly threadId: string;

  constructor(threadId: string) {
    super(`ConversationRegistry: no open shadow thread for threadId "${threadId}"`);
    this.name = 'UnknownShadowThreadError';
    this.threadId = threadId;
  }
}

/**
 * Per-thread conversation state store reusing the pure {@link reduce} (design Component 5).
 */
export interface ConversationRegistry {
  /**
   * Open (or no-op if already open) the shadow thread `threadId` with peer `peerUid`, creating an
   * empty {@link ConversationState} for it. This is the EXPLICIT, locally-initiated creation point
   * for a shadow thread — the UI calls it when the user opens the thread via the `/alias` flow — so
   * that subsequent inbound shadow events are accepted by {@link apply} rather than rejected (7.8).
   * Idempotent: re-opening an already-open thread does not reset its state.
   */
  openShadowThread(threadId: string, peerUid: string): void;
  /**
   * Route a (possibly `threadId`-tagged) {@link ConversationEvent} to the correct per-thread state
   * and apply it via the pure {@link reduce}. Surface events auto-create their conversation; a shadow
   * event for an unopened thread is rejected unless it is the first locally-initiated outbound send
   * (see the module doc). Untagged conversation-UI events (composer/connection/web-warning) are out
   * of the registry's routing scope and ignored.
   *
   * @throws {UnknownShadowThreadError} when a shadow-tagged event targets an unopened thread.
   */
  apply(event: ConversationEvent): void;
  /** Current immutable snapshot for one conversation, creating an empty one on first access. */
  getState(key: ConversationKey): ConversationState;
  /** Chat-list entries for the DEFAULT (surface) view ONLY — shadow threads are never included. */
  listSurfaceConversations(): SurfaceListEntry[];
  /** Whether a notification/preview may be shown for an event — `false` for any shadow event. */
  isNotifiable(event: ConversationEvent): boolean;
}

/** An entry held in the registry's map: the conversation's key plus its current render state. */
interface RegistryEntry {
  key: ConversationKey;
  state: ConversationState;
}

/** Derive the routable shadow threadId for an event, or `undefined` when it is a surface event. */
function eventThreadId(event: ConversationEvent): string | undefined {
  const threadId = (event as { threadId?: unknown }).threadId;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : undefined;
}

/** Read an event's `remoteUid`, when it carries one (absent for composer/connection/web-warning). */
function eventRemoteUid(event: ConversationEvent): string | undefined {
  const remoteUid = (event as { remoteUid?: unknown }).remoteUid;
  return typeof remoteUid === 'string' && remoteUid.length > 0 ? remoteUid : undefined;
}

/** The string map-key for a conversation key. */
function mapKeyFor(key: ConversationKey): string {
  return key.kind === 'surface' ? `surface:${key.remoteUid}` : `shadow:${key.threadId}`;
}

/**
 * Whether `event` is a LOCALLY-INITIATED creation of a shadow thread, i.e. the user sending the
 * first shadow message into it. This is the only shadow event that may auto-create a thread in
 * {@link apply}; everything else for an unopened thread is rejected (7.8). An outbound
 * `message-appended` is locally initiated (the optimistic row for our own send); an INBOUND
 * `message-appended` is not, and a reaction/edit/delete/timer can only follow an already-open thread.
 */
function isLocalShadowThreadCreation(event: ConversationEvent): boolean {
  return event.type === 'message-appended' && event.message.direction === 'out';
}

/**
 * Default {@link ConversationRegistry}: a `Map<string, RegistryEntry>` keyed by `surface:${remoteUid}`
 * / `shadow:${threadId}`, dispatching through the pure {@link reduce}. The reducer is never modified;
 * each conversation simply has its own state, which is what makes thread isolation (Property 8) and
 * per-thread gap detection hold.
 */
export class DefaultConversationRegistry implements ConversationRegistry {
  private readonly conversations = new Map<string, RegistryEntry>();
  private readonly platform: 'mobile' | 'web';

  constructor(options: ConversationRegistryOptions = {}) {
    this.platform = options.platform ?? 'mobile';
  }

  /** @inheritdoc */
  openShadowThread(threadId: string, peerUid: string): void {
    if (threadId.length === 0) {
      throw new TypeError('ConversationRegistry.openShadowThread requires a non-empty threadId');
    }
    const mapKey = `shadow:${threadId}`;
    if (this.conversations.has(mapKey)) {
      return; // idempotent — never reset an already-open thread's state.
    }
    this.conversations.set(mapKey, {
      key: { kind: 'shadow', threadId, peerUid },
      state: initialConversationState(this.platform),
    });
  }

  /** @inheritdoc */
  apply(event: ConversationEvent): void {
    const threadId = eventThreadId(event);
    const remoteUid = eventRemoteUid(event);

    if (threadId !== undefined) {
      // Shadow event: route to `shadow:${threadId}`. Reject (without mutating anything) when the
      // thread is not open, unless this is the first locally-initiated outbound send (7.8).
      const mapKey = `shadow:${threadId}`;
      let entry = this.conversations.get(mapKey);
      if (entry === undefined) {
        if (isLocalShadowThreadCreation(event) && remoteUid !== undefined) {
          entry = {
            key: { kind: 'shadow', threadId, peerUid: remoteUid },
            state: initialConversationState(this.platform),
          };
          this.conversations.set(mapKey, entry);
        } else {
          throw new UnknownShadowThreadError(threadId);
        }
      }
      entry.state = reduce(entry.state, event);
      return;
    }

    if (remoteUid !== undefined) {
      // Surface event: auto-create on first access (existing Phase 1/2 behaviour).
      const mapKey = `surface:${remoteUid}`;
      let entry = this.conversations.get(mapKey);
      if (entry === undefined) {
        entry = {
          key: { kind: 'surface', remoteUid },
          state: initialConversationState(this.platform),
        };
        this.conversations.set(mapKey, entry);
      }
      entry.state = reduce(entry.state, event);
      return;
    }

    // Untagged conversation-UI event (composer-changed / connection-changed /
    // web-warning-acknowledged): out of the registry's per-conversation routing scope (see module
    // doc). The platform adapter applies these directly to the ConversationState it is rendering.
  }

  /** @inheritdoc */
  getState(key: ConversationKey): ConversationState {
    const mapKey = mapKeyFor(key);
    const existing = this.conversations.get(mapKey);
    if (existing !== undefined) {
      return existing.state;
    }
    const entry: RegistryEntry = { key, state: initialConversationState(this.platform) };
    this.conversations.set(mapKey, entry);
    return entry.state;
  }

  /** @inheritdoc */
  listSurfaceConversations(): SurfaceListEntry[] {
    const entries: SurfaceListEntry[] = [];
    for (const entry of this.conversations.values()) {
      if (entry.key.kind === 'surface') {
        entries.push({ remoteUid: entry.key.remoteUid, state: entry.state });
      }
    }
    return entries;
  }

  /** @inheritdoc */
  isNotifiable(event: ConversationEvent): boolean {
    return eventThreadId(event) === undefined;
  }
}

/**
 * Construct a {@link ConversationRegistry} (factory mirroring `createMessaging`). `platform` defaults
 * to `'mobile'`; pass `'web'` to start each conversation gated behind the ephemerality acknowledgment.
 */
export function createConversationRegistry(
  options: ConversationRegistryOptions = {},
): ConversationRegistry {
  return new DefaultConversationRegistry(options);
}
