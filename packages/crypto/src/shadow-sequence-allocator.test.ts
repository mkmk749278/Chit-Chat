import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { KeyStore } from './ports';
import { SHADOW_SEQ_OFFSET, ShadowSequenceAllocator } from './shadow-sequence-allocator';

/**
 * Tests for the {@link ShadowSequenceAllocator} (Shadow Chat, design Component 3). Covers the
 * `SHADOW_SEQ_OFFSET + 1` first value, strict +1 contiguity, independence from `recipientUid`,
 * persistence across allocator instances sharing one store, and error propagation with no counter
 * consumption (Requirements 4.1, 4.2, 4.5, 4.6, 9.3).
 */

/**
 * A minimal in-memory {@link KeyStore} stub exposing only `nextSeq`, keyed by the conversation key
 * (here `shadow:${threadId}`). Mirrors the real stores, whose first issued value for a fresh key is
 * `1`. `calls` records every conversation key passed, so tests can assert which key was used.
 */
function fakeKeyStore(): { store: KeyStore; calls: string[] } {
  const counters = new Map<string, number>();
  const calls: string[] = [];
  const store = {
    async nextSeq(conversationKey: string): Promise<number> {
      calls.push(conversationKey);
      const next = (counters.get(conversationKey) ?? 0) + 1;
      counters.set(conversationKey, next);
      return next;
    },
  } as unknown as KeyStore;
  return { store, calls };
}

test('the first allocation for a thread is SHADOW_SEQ_OFFSET + 1 (Req 4.1)', async () => {
  const { store } = fakeKeyStore();
  const allocator = new ShadowSequenceAllocator(store, 'thread-a');
  assert.equal(await allocator.next('bob'), SHADOW_SEQ_OFFSET + 1);
});

test('successive allocations increase by exactly 1 (contiguity, Req 4.2)', async () => {
  const { store } = fakeKeyStore();
  const allocator = new ShadowSequenceAllocator(store, 'thread-a');
  let previous = await allocator.next('bob');
  assert.equal(previous, SHADOW_SEQ_OFFSET + 1);
  for (let i = 0; i < 50; i += 1) {
    const seq = await allocator.next('bob');
    assert.equal(seq, previous + 1, `expected contiguity at iteration ${i}`);
    previous = seq;
  }
});

test('every allocated shadow seq is >= SHADOW_SEQ_OFFSET (disjoint from surface, Req 4.3)', async () => {
  const { store } = fakeKeyStore();
  const allocator = new ShadowSequenceAllocator(store, 'thread-a');
  for (let i = 0; i < 20; i += 1) {
    const seq = await allocator.next('bob');
    assert.ok(seq >= SHADOW_SEQ_OFFSET, `seq ${seq} below the offset`);
  }
});

test('the issued value does not depend on the recipient uid (Req 4.5)', async () => {
  const { store, calls } = fakeKeyStore();
  const allocator = new ShadowSequenceAllocator(store, 'thread-a');
  // Different recipient uids on each call still advance the SAME per-thread counter.
  assert.equal(await allocator.next('bob'), SHADOW_SEQ_OFFSET + 1);
  assert.equal(await allocator.next('carol'), SHADOW_SEQ_OFFSET + 2);
  assert.equal(await allocator.next(''), SHADOW_SEQ_OFFSET + 3);
  // The counter was keyed on the thread, never the recipient uid.
  assert.deepEqual(calls, ['shadow:thread-a', 'shadow:thread-a', 'shadow:thread-a']);
});

test('distinct threads draw from independent counters (Req 4.2/9.3)', async () => {
  const { store } = fakeKeyStore();
  const a = new ShadowSequenceAllocator(store, 'thread-a');
  const b = new ShadowSequenceAllocator(store, 'thread-b');
  assert.equal(await a.next('peer'), SHADOW_SEQ_OFFSET + 1);
  assert.equal(await b.next('peer'), SHADOW_SEQ_OFFSET + 1);
  assert.equal(await a.next('peer'), SHADOW_SEQ_OFFSET + 2);
  assert.equal(await b.next('peer'), SHADOW_SEQ_OFFSET + 2);
});

test('the counter persists across allocator instances sharing one store (Req 9.3)', async () => {
  const { store } = fakeKeyStore();
  const first = new ShadowSequenceAllocator(store, 'thread-a');
  assert.equal(await first.next('peer'), SHADOW_SEQ_OFFSET + 1);
  assert.equal(await first.next('peer'), SHADOW_SEQ_OFFSET + 2);

  // A brand-new allocator over the same store must CONTINUE the counter, not reset it.
  const second = new ShadowSequenceAllocator(store, 'thread-a');
  assert.equal(await second.next('peer'), SHADOW_SEQ_OFFSET + 3);
});

test('a KeyStore failure propagates and consumes no counter value (Req 4.6)', async () => {
  const counters = new Map<string, number>();
  let failNext = false;
  const store = {
    async nextSeq(conversationKey: string): Promise<number> {
      if (failNext) {
        // Fail BEFORE touching the counter — no value is consumed.
        throw new Error('keystore unavailable');
      }
      const next = (counters.get(conversationKey) ?? 0) + 1;
      counters.set(conversationKey, next);
      return next;
    },
  } as unknown as KeyStore;

  const allocator = new ShadowSequenceAllocator(store, 'thread-a');
  assert.equal(await allocator.next('peer'), SHADOW_SEQ_OFFSET + 1);

  failNext = true;
  await assert.rejects(() => allocator.next('peer'), /keystore unavailable/);

  // No gap: the next successful allocation continues from where it left off (2, not 3).
  failNext = false;
  assert.equal(await allocator.next('peer'), SHADOW_SEQ_OFFSET + 2);
});

test('the constructor rejects an empty threadId', () => {
  const { store } = fakeKeyStore();
  assert.throws(() => new ShadowSequenceAllocator(store, ''), TypeError);
});
