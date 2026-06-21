import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  partitionPersistedRows,
  reduceRowsToState,
} from './conversation-rehydration';
import type { MessageRow } from './ports';
import { SHADOW_SEQ_OFFSET } from './shadow-sequence-allocator';

const row = (over: Partial<MessageRow> & Pick<MessageRow, 'id' | 'seq'>): MessageRow => ({
  remoteUid: 'peer',
  direction: 'in',
  plaintext: `m${over.seq}`,
  status: 'received',
  createdAt: over.seq, // default createdAt tracks seq so ordering is deterministic
  ...over,
});

// --- partitionPersistedRows: surface vs shadow split (Property 8) -----------------------------

test('partition splits rows by the +1e9 shadow sequence space', () => {
  const rows: MessageRow[] = [
    row({ id: 's1', seq: 1, remoteUid: 'alice' }),
    row({ id: 's2', seq: 2, remoteUid: 'alice' }),
    row({ id: 'h1', seq: SHADOW_SEQ_OFFSET + 1, remoteUid: 'alice' }),
    row({ id: 'h2', seq: SHADOW_SEQ_OFFSET + 2, remoteUid: 'alice' }),
    row({ id: 's3', seq: 3, remoteUid: 'bob' }),
  ];
  const { surfaceByPeer, shadowRows } = partitionPersistedRows(rows);

  // Shadow rows (seq >= 1e9) are NEVER placed in any surface bucket — the leak this fixes.
  assert.deepEqual(
    surfaceByPeer.get('alice')?.map((r) => r.id),
    ['s1', 's2'],
  );
  assert.deepEqual(
    surfaceByPeer.get('bob')?.map((r) => r.id),
    ['s3'],
  );
  assert.deepEqual(shadowRows.map((r) => r.id), ['h1', 'h2']);
});

test('partition: a shadow-only peer produces no surface bucket', () => {
  const rows: MessageRow[] = [row({ id: 'h1', seq: SHADOW_SEQ_OFFSET + 1, remoteUid: 'eve' })];
  const { surfaceByPeer, shadowRows } = partitionPersistedRows(rows);
  assert.equal(surfaceByPeer.has('eve'), false);
  assert.deepEqual(shadowRows.map((r) => r.id), ['h1']);
});

// --- reduceRowsToState: byte-for-byte live behaviour (Req 6.7) --------------------------------

test('reduceRowsToState replays rows oldest-first and reports the newest timestamp', () => {
  const rows: MessageRow[] = [
    row({ id: 'b', seq: 2, createdAt: 200, plaintext: 'second' }),
    row({ id: 'a', seq: 1, createdAt: 100, plaintext: 'first' }),
  ];
  const { state, lastAt } = reduceRowsToState(rows, { now: 1_000, platform: 'mobile' });
  assert.deepEqual(state.messages.map((m) => m.text), ['first', 'second']);
  assert.equal(lastAt, 200);
});

test('reduceRowsToState surfaces a still-sending row as failed (ack timer died)', () => {
  const rows: MessageRow[] = [
    row({ id: 'o1', seq: 1, direction: 'out', plaintext: 'hi', status: 'sending' }),
  ];
  const { state } = reduceRowsToState(rows, { now: 1_000, platform: 'mobile' });
  assert.equal(state.messages[0]?.status, 'failed');
  assert.equal(state.messages[0]?.text, 'hi'); // text retained
});

test('reduceRowsToState skips already-expired disappearing messages', () => {
  const rows: MessageRow[] = [
    row({ id: 'gone', seq: 1, createdAt: 1, expiresAt: 50, plaintext: 'expired' }),
    row({ id: 'kept', seq: 2, createdAt: 2, plaintext: 'kept' }),
  ];
  const { state } = reduceRowsToState(rows, { now: 100, platform: 'mobile' });
  assert.deepEqual(state.messages.map((m) => m.text), ['kept']);
});

test('reduceRowsToState rebuilds an inbound delivery-error row', () => {
  const rows: MessageRow[] = [
    row({ id: 'e1', seq: 5, direction: 'in', plaintext: null, status: 'delivery-error' }),
  ];
  const { state } = reduceRowsToState(rows, { now: 1_000, platform: 'mobile' });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.status, 'delivery-error');
  assert.equal(state.messages[0]?.text, null);
});

test('reduceRowsToState builds an isolated shadow state from shadow seqs', () => {
  const rows: MessageRow[] = [
    row({ id: 'h1', seq: SHADOW_SEQ_OFFSET + 1, direction: 'out', plaintext: 'shadow hi', status: 'sent', createdAt: 10 }),
    row({ id: 'h2', seq: SHADOW_SEQ_OFFSET + 2, direction: 'in', plaintext: 'shadow hello', createdAt: 20 }),
  ];
  // A shadow thread passes its resolved peerUid; the +1e9 seqs reduce just like surface seqs.
  const { state, lastAt } = reduceRowsToState(rows, { now: 1_000, platform: 'mobile', remoteUid: 'peer' });
  assert.deepEqual(state.messages.map((m) => m.text), ['shadow hi', 'shadow hello']);
  assert.equal(lastAt, 20);
});

test('reduceRowsToState on no rows yields the empty initial state', () => {
  const { state, lastAt } = reduceRowsToState([], { now: 1_000, platform: 'mobile' });
  assert.deepEqual(state.messages, []);
  assert.equal(lastAt, 0);
});
