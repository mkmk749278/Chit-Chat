/**
 * `@chat-app/crypto` — `SequenceAllocator` (Phase 1, design Component 5).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Components and Interfaces" → "Client Component 5: Messaging" → `SequenceAllocator`,
 *   and "Data Models" → the `conversation_seq` table.
 *
 * Allocates strictly increasing, per-conversation sequence numbers for outbound
 * messages (Requirements 5.3, 6.2). The monotonic counter is owned by the
 * `KeyStore` (`conversation_seq.last_send_seq`), so the allocator is a thin,
 * stateless delegator: it holds no in-memory counter of its own. This keeps the
 * sequence durable across app restarts — on relaunch the next allocation continues
 * from the persisted value rather than restarting from zero — and ensures a single
 * source of truth per conversation even if multiple allocator instances exist.
 */

import type { KeyStore } from './ports';

/**
 * Issues strictly increasing per-conversation sequence numbers (Requirements 5.3,
 * 6.2). Each call to {@link SequenceAllocator.next} returns a value strictly greater
 * than every value previously returned for the same `recipientUid`, so messages in a
 * conversation can be ordered and de-duplicated deterministically.
 */
export interface SequenceAllocator {
  /**
   * Allocate the next sequence number for the conversation with `recipientUid`.
   * Successive calls for the same recipient yield strictly increasing values;
   * sequences for distinct recipients are independent.
   */
  next(recipientUid: string): Promise<number>;
}

/**
 * Default {@link SequenceAllocator} backed by an injected {@link KeyStore}.
 *
 * Delegates straight to `KeyStore.nextSeq`, which atomically increments and persists
 * the per-conversation counter (`conversation_seq.last_send_seq`) and returns the
 * newly allocated value. Because the counter lives in the store rather than in this
 * object, allocations remain strictly increasing across process restarts and across
 * allocator instances that share the same store.
 */
export class KeyStoreSequenceAllocator implements SequenceAllocator {
  /**
   * @param keyStore - the on-device store that owns the persisted per-conversation
   *   counter. Injected so the allocator stays platform-agnostic (SQLCipher on
   *   mobile, in-memory on web) and unit-testable with a fake store.
   */
  constructor(private readonly keyStore: KeyStore) {}

  /** @inheritdoc */
  next(recipientUid: string): Promise<number> {
    return this.keyStore.nextSeq(recipientUid);
  }
}
