import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { KeyStore } from './ports';
import { KeyStoreSequenceAllocator } from './sequence-allocator';

/**
 * A minimal {@link KeyStore} stub exposing only `nextSeq`, which is all the allocator
 * touches. Backed by a per-recipient counter so the strict-monotonicity property can be
 * exercised without a real store.
 */
function fakeKeyStore(): KeyStore {
  const counters = new Map<string, number>();
  return {
    async nextSeq(recipientUid: string): Promise<number> {
      const next = (counters.get(recipientUid) ?? 0) + 1;
      counters.set(recipientUid, next);
      return next;
    },
  } as unknown as KeyStore;
}

// Feature: phase1-client-messaging, Property 5: Per-conversation sequence monotonicity.

test('successive allocations for one recipient are strictly increasing (Property 5)', async () => {
  const allocator = new KeyStoreSequenceAllocator(fakeKeyStore());
  let previous = -Infinity;
  for (let i = 0; i < 100; i += 1) {
    const seq = await allocator.next('bob');
    assert.ok(seq > previous, `seq ${seq} not greater than previous ${previous}`);
    previous = seq;
  }
});

test('sequences for distinct recipients are independent', async () => {
  const allocator = new KeyStoreSequenceAllocator(fakeKeyStore());
  assert.equal(await allocator.next('bob'), 1);
  assert.equal(await allocator.next('carol'), 1);
  assert.equal(await allocator.next('bob'), 2);
  assert.equal(await allocator.next('carol'), 2);
  assert.equal(await allocator.next('bob'), 3);
});

test('delegates to KeyStore.nextSeq with the recipient uid', async () => {
  const calls: string[] = [];
  const store = {
    async nextSeq(recipientUid: string): Promise<number> {
      calls.push(recipientUid);
      return 7;
    },
  } as unknown as KeyStore;

  const allocator = new KeyStoreSequenceAllocator(store);
  const seq = await allocator.next('dave');

  assert.equal(seq, 7);
  assert.deepEqual(calls, ['dave']);
});
