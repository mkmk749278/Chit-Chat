import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import type { KeyStore } from './ports';
import { KeyStoreSequenceAllocator } from './sequence-allocator';

/** In-memory KeyStore stub exposing only the `nextSeq` the allocator uses. */
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

test('Property 5: per-conversation sequence monotonicity', async () => {
  // Feature: phase1-client-messaging, Property 5: Per-conversation sequence monotonicity
  await fc.assert(
    // A sequence of recipient ids drawn from a small pool exercises interleaved
    // allocations across several conversations.
    fc.asyncProperty(
      fc.array(fc.constantFrom('alice', 'bob', 'carol', 'dave'), { minLength: 1, maxLength: 200 }),
      async (calls) => {
        const allocator = new KeyStoreSequenceAllocator(fakeKeyStore());
        const lastByRecipient = new Map<string, number>();
        for (const recipient of calls) {
          const seq = await allocator.next(recipient);
          const previous = lastByRecipient.get(recipient) ?? -Infinity;
          assert.ok(seq > previous, `seq ${seq} not strictly greater than ${previous}`);
          lastByRecipient.set(recipient, seq);
        }
      },
    ),
    { numRuns: 200 },
  );
});
