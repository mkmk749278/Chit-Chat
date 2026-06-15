import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  initialConversationState,
  reduce,
  type ConversationEvent,
  type ConversationState,
} from './conversation-reducer';

/**
 * Message-gap detection tests (Phase 2, Requirement 2). The gap markers are derived purely
 * from the set of received inbound seqs, so these prove the two correctness properties: a
 * skipped seq surfaces a gap, and an out-of-order/backfilled arrival never leaves a false gap
 * once the conversation is complete.
 */

const inbound = (seq: number): ConversationEvent => ({
  type: 'message-appended',
  message: { id: `in-${seq}`, seq, direction: 'in', text: `m${seq}`, status: 'received' },
});

const outbound = (seq: number): ConversationEvent => ({
  type: 'message-appended',
  message: { id: `out-${seq}`, seq, direction: 'out', text: `s${seq}`, status: 'sent' },
});

const apply = (events: ConversationEvent[]): ConversationState =>
  events.reduce(reduce, initialConversationState('mobile'));

test('contiguous inbound messages report no gap', () => {
  const state = apply([inbound(1), inbound(2), inbound(3)]);
  assert.deepEqual(state.missingBefore, []);
});

test('a skipped seq is reported as a gap before the following message', () => {
  const state = apply([inbound(1), inbound(4)]); // 2 and 3 missing
  assert.deepEqual(state.missingBefore, [4]);
});

test('multiple separate gaps are each reported', () => {
  const state = apply([inbound(1), inbound(3), inbound(6)]); // gaps before 3 and before 6
  assert.deepEqual(state.missingBefore, [3, 6]);
});

test('backfill clears the gap regardless of arrival order', () => {
  const withGap = apply([inbound(1), inbound(3)]);
  assert.deepEqual(withGap.missingBefore, [3]);
  const backfilled = reduce(withGap, inbound(2)); // the missing message finally arrives
  assert.deepEqual(backfilled.missingBefore, []);
});

test('out-of-order arrival never produces a false gap once complete', () => {
  // Same three messages, shuffled arrival order — all must end with no gap.
  const orders: number[][] = [
    [1, 2, 3],
    [3, 1, 2],
    [2, 3, 1],
    [3, 2, 1],
  ];
  for (const order of orders) {
    const state = apply(order.map(inbound));
    assert.deepEqual(state.missingBefore, [], `order ${order.join(',')} should have no gap`);
  }
});

test('joining mid-stream (first seq > 1) is not a leading gap', () => {
  const state = apply([inbound(5), inbound(6), inbound(7)]);
  assert.deepEqual(state.missingBefore, []);
});

test('outbound seqs do not affect inbound gap detection', () => {
  // Outbound 1..3 present; inbound only 1 and 3 → gap is purely about inbound.
  const state = apply([outbound(1), outbound(2), outbound(3), inbound(1), inbound(3)]);
  assert.deepEqual(state.missingBefore, [3]);
});

test('a delivery-error entry counts as received (no false gap)', () => {
  const state = apply([
    inbound(1),
    { type: 'inbound-delivery-error', id: 'err-2', seq: 2 },
    inbound(3),
  ]);
  assert.deepEqual(state.missingBefore, []);
});

test('duplicate arrivals do not create spurious gaps', () => {
  const state = apply([inbound(1), inbound(2), inbound(2), inbound(3)]);
  assert.deepEqual(state.missingBefore, []);
});
