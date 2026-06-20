import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import type { KeyStore } from './ports';
import { SHADOW_SEQ_OFFSET, ShadowSequenceAllocator } from './shadow-sequence-allocator';

/**
 * Property tests for the {@link ShadowSequenceAllocator} (Shadow Chat, design Component 3).
 *
 * Feature: shadow-chat. Validates design Correctness Property 2 (surface/shadow sequence
 * disjointness) and Correctness Property 3 (per-thread contiguity). Each property runs >=100
 * randomised iterations and reports fast-check's counterexample on failure (Requirements 4.1, 4.2,
 * 4.3, 4.4, 4.5).
 */

/** In-memory KeyStore stub exposing only the `nextSeq` the allocator uses (first value = 1). */
function fakeKeyStore(): KeyStore {
  const counters = new Map<string, number>();
  return {
    async nextSeq(conversationKey: string): Promise<number> {
      const next = (counters.get(conversationKey) ?? 0) + 1;
      counters.set(conversationKey, next);
      return next;
    },
  } as unknown as KeyStore;
}

/** A non-empty threadId, and a small pool of recipient uids (including the empty string). */
const threadIdArb = fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.length >= 1);
const recipientArb = fc.constantFrom('alice', 'bob', 'carol', 'dave', '');

test('Property 2: every allocated shadow seq is >= SHADOW_SEQ_OFFSET (surface/shadow disjointness)', async () => {
  // Feature: shadow-chat, Correctness Property 2 (surface/shadow sequence disjointness).
  await fc.assert(
    fc.asyncProperty(
      threadIdArb,
      fc.array(recipientArb, { minLength: 1, maxLength: 200 }),
      async (threadId, recipients) => {
        const allocator = new ShadowSequenceAllocator(fakeKeyStore(), threadId);
        for (const recipient of recipients) {
          const seq = await allocator.next(recipient);
          // >= the offset, hence never collides with any surface seq < SHADOW_SEQ_OFFSET.
          assert.ok(seq >= SHADOW_SEQ_OFFSET, `seq ${seq} below the offset`);
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('Property 3: allocations for one thread are strictly +1 contiguous from SHADOW_SEQ_OFFSET + 1', async () => {
  // Feature: shadow-chat, Correctness Property 3 (shadow sequence contiguity within a thread).
  await fc.assert(
    fc.asyncProperty(
      threadIdArb,
      fc.array(recipientArb, { minLength: 1, maxLength: 200 }),
      async (threadId, recipients) => {
        const allocator = new ShadowSequenceAllocator(fakeKeyStore(), threadId);
        // Independent of the (arbitrary) recipient uids, the n-th call returns OFFSET + n.
        for (let i = 0; i < recipients.length; i += 1) {
          const seq = await allocator.next(recipients[i]);
          assert.equal(seq, SHADOW_SEQ_OFFSET + i + 1, `non-contiguous at call ${i}`);
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('Property 3: distinct threads keep independent contiguous counters', async () => {
  // Feature: shadow-chat, Correctness Property 3 (per-thread isolation of the counter).
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 32 }), { minLength: 2, maxLength: 5 }),
      fc.integer({ min: 1, max: 30 }),
      async (threadIds, perThreadCalls) => {
        const store = fakeKeyStore();
        const allocators = threadIds.map((id) => new ShadowSequenceAllocator(store, id));
        // Round-robin across threads; each thread must still see 1e9+1, 1e9+2, … in order.
        const seen = threadIds.map(() => 0);
        for (let round = 0; round < perThreadCalls; round += 1) {
          for (let t = 0; t < allocators.length; t += 1) {
            const seq = await allocators[t].next('peer');
            seen[t] += 1;
            assert.equal(seq, SHADOW_SEQ_OFFSET + seen[t], `thread ${t} broke contiguity`);
          }
        }
      },
    ),
    { numRuns: 150 },
  );
});
