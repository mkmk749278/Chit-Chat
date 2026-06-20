import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import {
  initialConversationState,
  reduce,
  type ConversationEvent,
  type ConversationState,
  type RenderableMessage,
} from './conversation-reducer';

/**
 * Property tests for the P2 time-ordered rendering change (Feature: ui-modernization-and-setup-fix,
 * Properties 1–4). Run under `node --test` + `fast-check`, min 100 runs each.
 *
 * The reducer now orders the rendered list by `createdAt` ascending with a stable `(seq, direction)`
 * tiebreak, while KEEPING dedup by `(direction, seq)` and gap detection derived from inbound `seq`
 * only. These properties pin all four invariants.
 */

const SEQ_MAX = 30;
const TIME_MAX = 1_000_000;

/** Mirror of the module's private `orderKey`: finite `createdAt`, else `0`. */
function orderKey(m: RenderableMessage): number {
  return typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) ? m.createdAt : 0;
}

/** Mirror of the module's private `messageKey`. */
function messageKey(m: Pick<RenderableMessage, 'direction' | 'seq'>): string {
  return `${m.direction}:${m.seq}`;
}

/**
 * A message arbitrary spanning both directions, with `createdAt` that may be absent or non-finite
 * (to exercise the "treat as 0" rule) and may collide with other messages (to exercise the
 * tiebreak). `id` carries the arrival ordinal so duplicate `(direction, seq)` arrivals are
 * distinguishable when reasoning about last-write-wins.
 */
function messageArb(seqMax = SEQ_MAX): fc.Arbitrary<RenderableMessage> {
  return fc
    .record({
      seq: fc.nat({ max: seqMax }),
      direction: fc.constantFrom<'in' | 'out'>('in', 'out'),
      createdAt: fc.option(
        fc.oneof(
          fc.integer({ min: 0, max: TIME_MAX }),
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        ),
        { nil: undefined },
      ),
    })
    .map(
      (m): RenderableMessage => ({
        id: `${m.direction}:${m.seq}`,
        seq: m.seq,
        direction: m.direction,
        text: `m${m.seq}`,
        status: m.direction === 'in' ? 'received' : 'sent',
        ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
      }),
    );
}

/** Reduce a list of `message-appended` events from messages, in arrival order. */
function appendAll(messages: readonly RenderableMessage[]): ConversationState {
  const events: ConversationEvent[] = messages.map((message) => ({ type: 'message-appended', message }));
  return events.reduce(reduce, initialConversationState('mobile'));
}

/**
 * The expected rendered list: dedup by `(direction, seq)` keeping the LAST arrival (upsert replaces),
 * then sort by `(orderKey asc, seq asc, messageKey asc)`.
 */
function expectedOrder(messages: readonly RenderableMessage[]): RenderableMessage[] {
  const byKey = new Map<string, RenderableMessage>();
  for (const m of messages) {
    byKey.set(messageKey(m), m); // last write wins
  }
  return [...byKey.values()].sort((a, b) => {
    const byTime = orderKey(a) - orderKey(b);
    if (byTime !== 0) {
      return byTime;
    }
    return a.seq === b.seq ? messageKey(a).localeCompare(messageKey(b)) : a.seq - b.seq;
  });
}

test('Property 1: chronological render order across both directions', () => {
  // Feature: ui-modernization-and-setup-fix, Property 1: Chronological render order across both directions
  fc.assert(
    fc.property(fc.array(messageArb(), { maxLength: 120 }), (messages) => {
      const state = appendAll(messages);

      // 1. The rendered list is non-decreasing in the time-ordering key.
      for (let i = 1; i < state.messages.length; i += 1) {
        assert.ok(
          orderKey(state.messages[i]!) >= orderKey(state.messages[i - 1]!),
          'non-decreasing createdAt',
        );
      }

      // 2. It is exactly the stable total order under (createdAt, seq, direction), regardless of
      //    arrival order / duplication.
      assert.deepEqual(state.messages, expectedOrder(messages));
    }),
    { numRuns: 200 },
  );
});

test('Property 1: arrival order does not change the rendered order', () => {
  // Feature: ui-modernization-and-setup-fix, Property 1: Chronological render order across both directions
  fc.assert(
    fc.property(
      fc.array(messageArb(), { maxLength: 80 }),
      fc.array(messageArb(), { maxLength: 80 }),
      (a, b) => {
        // Same multiset of (direction, seq, createdAt) facts, shuffled: only last-write-wins per key
        // matters, so reducing a permutation that preserves per-key last value yields the same order.
        const combined = [...a, ...b];
        const reversed = [...combined].reverse();
        // Reversing changes which arrival is "last" per key; compare each against its own expectation.
        assert.deepEqual(appendAll(combined).messages, expectedOrder(combined));
        assert.deepEqual(appendAll(reversed).messages, expectedOrder(reversed));
      },
    ),
    { numRuns: 150 },
  );
});

test('Property 2: dedup preserved under time ordering', () => {
  // Feature: ui-modernization-and-setup-fix, Property 2: Dedup preserved under time ordering
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          messageArb().map((message): ConversationEvent => ({ type: 'message-appended', message })),
          fc
            .record({ seq: fc.nat({ max: SEQ_MAX }), createdAt: fc.integer({ min: 0, max: TIME_MAX }) })
            .map(
              (e): ConversationEvent => ({
                type: 'inbound-delivery-error',
                id: `in:${e.seq}`,
                seq: e.seq,
                createdAt: e.createdAt,
              }),
            ),
        ),
        { maxLength: 150 },
      ),
      (events) => {
        const state = events.reduce(reduce, initialConversationState('mobile'));
        const keys = state.messages.map(messageKey);
        // Each (direction, seq) appears exactly once regardless of arrival order or event kind.
        assert.equal(new Set(keys).size, keys.length, 'no duplicate (direction, seq)');
      },
    ),
    { numRuns: 200 },
  );
});

test('Property 3: gap detection is invariant to the ordering change', () => {
  // Feature: ui-modernization-and-setup-fix, Property 3: Gap detection is invariant to the ordering change
  fc.assert(
    fc.property(
      // Distinct inbound seqs (each carrying an arbitrary, possibly out-of-order createdAt) plus some
      // outbound noise. Gap markers must depend only on the inbound seq set, never on createdAt/arrival.
      fc.uniqueArray(fc.nat({ max: SEQ_MAX }), { minLength: 0, maxLength: 20 }),
      fc.array(fc.nat({ max: SEQ_MAX }), { maxLength: 20 }),
      fc.array(fc.integer({ min: 0, max: TIME_MAX }), { minLength: 64, maxLength: 64 }),
      (inboundSeqs, outboundSeqs, times) => {
        let tick = 0;
        const time = (): number => times[tick++ % times.length]!;
        const inboundEvents: ConversationEvent[] = inboundSeqs.map((seq) => ({
          type: 'message-appended',
          message: { id: `in:${seq}`, seq, direction: 'in', text: 't', status: 'received', createdAt: time() },
        }));
        const outboundEvents: ConversationEvent[] = outboundSeqs.map((seq) => ({
          type: 'message-appended',
          message: { id: `out:${seq}`, seq, direction: 'out', text: 't', status: 'sent', createdAt: time() },
        }));
        // Interleave/shuffle by zipping; arrival order is varied deliberately.
        const events = [...outboundEvents, ...inboundEvents].sort(() => (time() % 2 === 0 ? -1 : 1));
        const state = events.reduce(reduce, initialConversationState('mobile'));

        // Expected gap markers: inbound seqs immediately following a gap, strictly between the lowest
        // and highest received inbound seq.
        const sorted = [...new Set(inboundSeqs)].sort((x, y) => x - y);
        const expected: number[] = [];
        for (let i = 1; i < sorted.length; i += 1) {
          if (sorted[i] !== sorted[i - 1]! + 1) {
            expected.push(sorted[i]!);
          }
        }
        assert.deepEqual(state.missingBefore, expected);
      },
    ),
    { numRuns: 200 },
  );
});

test('Property 4: shadow-thread ordering isolation', () => {
  // Feature: ui-modernization-and-setup-fix, Property 4: Shadow-thread ordering isolation
  const SHADOW_BASE = 1e9;
  fc.assert(
    fc.property(
      // Surface messages carry seq < 1e9; shadow messages carry seq >= 1e9. They route to distinct
      // per-thread reducer states (as the ConversationRegistry does), and must never cross.
      fc.array(
        fc.record({
          shadow: fc.boolean(),
          seq: fc.nat({ max: SEQ_MAX }),
          direction: fc.constantFrom<'in' | 'out'>('in', 'out'),
          createdAt: fc.integer({ min: 0, max: TIME_MAX }),
        }),
        { maxLength: 120 },
      ),
      (rows) => {
        const surface: RenderableMessage[] = [];
        const shadow: RenderableMessage[] = [];
        for (const r of rows) {
          const seq = r.shadow ? SHADOW_BASE + r.seq : r.seq;
          const m: RenderableMessage = {
            id: `${r.direction}:${seq}`,
            seq,
            direction: r.direction,
            text: 't',
            status: r.direction === 'in' ? 'received' : 'sent',
            createdAt: r.createdAt,
          };
          (r.shadow ? shadow : surface).push(m);
        }

        const surfaceState = appendAll(surface);
        const shadowState = appendAll(shadow);

        // No cross-thread leakage: each thread holds only its own seq band.
        assert.ok(surfaceState.messages.every((m) => m.seq < SHADOW_BASE), 'surface has no shadow seqs');
        assert.ok(shadowState.messages.every((m) => m.seq >= SHADOW_BASE), 'shadow has no surface seqs');

        // Each thread is chronologically ordered by createdAt.
        for (const s of [surfaceState, shadowState]) {
          for (let i = 1; i < s.messages.length; i += 1) {
            assert.ok(orderKey(s.messages[i]!) >= orderKey(s.messages[i - 1]!), 'chronological per thread');
          }
        }
        assert.deepEqual(surfaceState.messages, expectedOrder(surface));
        assert.deepEqual(shadowState.messages, expectedOrder(shadow));
      },
    ),
    { numRuns: 200 },
  );
});
