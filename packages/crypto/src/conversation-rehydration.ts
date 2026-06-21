/**
 * `@chat-app/crypto` — relaunch rehydration core (Phase 2 CC4 + Shadow Chat).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Component 5: ConversationRegistry —
 * per-thread state" + Correctness Property 8 (thread isolation / no cross-thread bleed), and the
 * Phase 1 relaunch rehydration requirement (Req 6.7 — a rehydrated conversation is byte-for-byte
 * what a live session would have produced).
 *
 * ## Why this module exists
 *
 * On app launch the platform reloads every persisted {@link MessageRow} and must rebuild each
 * conversation's render {@link ConversationState} by replaying the rows through the SAME pure
 * {@link reduce} a live session uses. Two conversations between the same two UIDs share one server
 * conversation but MUST stay completely separate on the client: a SURFACE chat (seq `< 1e9`) and any
 * number of SHADOW threads (seq `>= 1e9`, distinguished by their device-local `threadId`). Rebuilding
 * them with one pure helper guarantees the rehydrated state matches the live state exactly and — the
 * regression this fixes — keeps shadow rows OUT of the surface conversation so a restart can never
 * leak a shadow message into the normal chat (the whole point of the feature, design §9.2).
 *
 * The helper is pure and deterministic (the clock is injected); the platform adapter handles the I/O
 * of loading rows, resolving which shadow threads are known/active, and applying the per-conversation
 * disappearing-message timer (a side effect kept out of this pure core).
 */

import {
  initialConversationState,
  reduce,
  type ConversationEvent,
  type ConversationState,
} from './conversation-reducer';
import type { MessageRow } from './ports';
import { SHADOW_SEQ_OFFSET } from './shadow-sequence-allocator';

/** A conversation's reduced render state plus the newest message timestamp (for list ordering). */
export interface ReducedRows {
  /** The fully-reduced render state, ready to hand to the Conversation_Screen. */
  state: ConversationState;
  /** Newest surviving message timestamp (unix ms), or `0` when the conversation has no rows. */
  lastAt: number;
}

/** Tuning + injected determinism for {@link reduceRowsToState}. */
export interface ReduceRowsOptions {
  /** Wall clock (unix ms) used to drop already-expired disappearing messages. */
  now: number;
  /** Platform whose initial-state gating applies (`'web'` starts gated; `'mobile'` is not). */
  platform: 'mobile' | 'web';
  /**
   * The peer UID to stamp on each rebuilt event. Defaults to each row's own `remoteUid` (the surface
   * case). A shadow thread passes its resolved `peerUid` so the events carry the real contact rather
   * than relying on the row — the pure {@link reduce} ignores `remoteUid` for state, so this only
   * affects which peer the (caller-consumed) events name.
   */
  remoteUid?: string;
}

/**
 * Rebuild ONE conversation's {@link ConversationState} by replaying `rows` through the pure
 * {@link reduce}, exactly as a live session would have (Req 6.7). Rows are applied oldest-first so
 * ordering/gap detection matches live arrival semantics; an already-expired disappearing message is
 * skipped (the store erases it on launch — don't flash it first, Req 4.2); a row still `sending` at
 * relaunch is surfaced as `failed` (its ack timer died with the previous process), text retained.
 *
 * This is shared by BOTH the surface and the shadow rehydration paths so a shadow thread renders
 * byte-for-byte like the surface chat — the ONLY difference is which rows the caller feeds in.
 */
export function reduceRowsToState(
  rows: readonly MessageRow[],
  options: ReduceRowsOptions,
): ReducedRows {
  let state = initialConversationState(options.platform);
  let lastAt = 0;
  const ordered = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  for (const row of ordered) {
    if (row.expiresAt !== undefined && Number.isFinite(row.expiresAt) && options.now >= row.expiresAt) {
      continue; // already past expiry — the purge engine erases it on launch (Req 4.2)
    }
    lastAt = Math.max(lastAt, row.createdAt);
    // A row still `sending` never got its server ack (the ack timer died with the previous process),
    // so surface it as `failed` — text retained — rather than a spinner that can never resolve.
    const status = row.status === 'sending' ? 'failed' : row.status;
    const remoteUid = options.remoteUid ?? row.remoteUid;
    const event: ConversationEvent =
      row.direction === 'in' && row.plaintext === null && status === 'delivery-error'
        ? { type: 'inbound-delivery-error', id: row.id, seq: row.seq, remoteUid }
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
            remoteUid,
          };
    state = reduce(state, event);
  }
  return { state, lastAt };
}

/**
 * Partition persisted `rows` into SURFACE rows (the normal chat) and SHADOW rows (a hidden thread),
 * so the two never cross-contaminate on relaunch (Correctness Property 8). A row is SHADOW when its
 * sequence number is in the shadow space (`>= SHADOW_SEQ_OFFSET`) — disjoint from surface seqs by
 * construction (the shadow sequence allocator always offsets by `+1e9`). Surface rows are returned
 * grouped by `remoteUid`; shadow rows are returned in one flat list for the caller to bucket by
 * `threadId` via its device-local row→thread association (a `MessageRow` carries no `threadId`).
 *
 * Returning shadow rows separately — rather than dropping them into the surface conversation — is the
 * fix that stops a restarted client showing shadow messages in the normal chat.
 */
export function partitionPersistedRows(rows: readonly MessageRow[]): {
  surfaceByPeer: Map<string, MessageRow[]>;
  shadowRows: MessageRow[];
} {
  const surfaceByPeer = new Map<string, MessageRow[]>();
  const shadowRows: MessageRow[] = [];
  for (const row of rows) {
    if (row.seq >= SHADOW_SEQ_OFFSET) {
      shadowRows.push(row);
      continue;
    }
    const list = surfaceByPeer.get(row.remoteUid) ?? [];
    list.push(row);
    surfaceByPeer.set(row.remoteUid, list);
  }
  return { surfaceByPeer, shadowRows };
}
