/**
 * `@chat-app/crypto` — `ShadowSequenceAllocator` (Shadow Chat, design Component 3).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Component 3: ShadowSequenceAllocator"
 * and "Key Functions with Formal Specifications" → `ShadowSequenceAllocator.next`.
 *
 * A shadow message and a surface message between the same two UIDs share ONE server-side
 * conversation on the (frozen) backend. To keep the two streams from contaminating each other in
 * the shared ack-matching key (`${recipientUid}:${seq}`) and reducer key (`${direction}:${seq}`),
 * shadow sequence numbers are offset by {@link SHADOW_SEQ_OFFSET} (`1e9`) so they are always
 * disjoint from surface seqs (which stay below the offset), and they are drawn from a DEDICATED
 * per-thread counter in the `KeyStore` (conversation key `shadow:${threadId}`) so they stay
 * strictly contiguous within the thread and gap detection remains well defined (Requirements 4.1,
 * 4.2, 4.3, 4.5, 4.6, 9.3).
 *
 * No `KeyStore` port change is needed: `nextSeq` already accepts an arbitrary conversation key, so
 * the adapter persists `shadow:${threadId}` exactly like any other `conversation_seq` row. The real
 * `KeyStore.nextSeq` issues `1` as its first value for a fresh conversation key, so the first
 * shadow allocation for any thread is exactly `SHADOW_SEQ_OFFSET + 1`.
 */

import type { KeyStore } from './ports';
import type { SequenceAllocator } from './sequence-allocator';

/**
 * The offset that separates shadow sequence numbers from surface sequence numbers in the shared
 * acknowledgement and reducer key spaces. Every surface seq is `< SHADOW_SEQ_OFFSET` and every
 * shadow seq is `>= SHADOW_SEQ_OFFSET`, making the two spaces disjoint (design Correctness
 * Property 2). `1e9` is far above any realistic surface message count yet keeps `1e9 + n` an exact
 * JS safe integer for any plausible `n`.
 */
export const SHADOW_SEQ_OFFSET = 1_000_000_000; // 1e9

/**
 * Allocates strictly increasing, contiguous shadow sequence numbers for ONE shadow thread.
 *
 * Backed by a dedicated per-thread counter in the injected {@link KeyStore} (conversation key
 * `shadow:${threadId}`): the store yields `1, 2, 3, …` for that key and this allocator returns
 * `SHADOW_SEQ_OFFSET + n`, so the first issued value is `SHADOW_SEQ_OFFSET + 1` and each successive
 * value increases by exactly 1 (design Correctness Property 3). It implements the existing
 * {@link SequenceAllocator} contract so `Messaging` can use it interchangeably with the surface
 * allocator. The `recipientUid` argument is ignored — the thread, not the UID, is the keyspace
 * (Requirement 4.5).
 */
export class ShadowSequenceAllocator implements SequenceAllocator {
  /** The dedicated `KeyStore` conversation key for this thread's contiguous counter. */
  private readonly counterKey: string;

  /**
   * @param keyStore - the on-device store that owns the persisted per-thread counter. Injected so
   *   the allocator stays platform-agnostic (SQLCipher on mobile, in-memory on web) and
   *   unit-testable with a fake store.
   * @param threadId - the shadow thread this allocator issues sequence numbers for. Must be a
   *   non-empty string.
   * @throws {TypeError} if `threadId` is empty.
   */
  constructor(
    private readonly keyStore: KeyStore,
    private readonly threadId: string,
  ) {
    if (threadId.length === 0) {
      throw new TypeError('ShadowSequenceAllocator requires a non-empty threadId');
    }
    this.counterKey = `shadow:${threadId}`;
  }

  /**
   * Allocate the next shadow sequence number for this thread: `SHADOW_SEQ_OFFSET + n`, where `n`
   * is the next value of the dedicated `shadow:${threadId}` counter. Successive calls return
   * strictly increasing, +1-contiguous values starting at `SHADOW_SEQ_OFFSET + 1`. `recipientUid`
   * is ignored. If the underlying `KeyStore.nextSeq` read/persist fails, no counter value is
   * consumed by this allocator and the error propagates so the caller can fail without creating a
   * sequence gap (Requirement 4.6).
   *
   * @param _recipientUid - ignored; the counter is keyed on the thread, not the recipient.
   */
  async next(_recipientUid: string): Promise<number> {
    const n = await this.keyStore.nextSeq(this.counterKey);
    return SHADOW_SEQ_OFFSET + n;
  }
}
