import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InMemoryRowThreadAssociation,
  type RowThreadAssociation,
} from './row-thread-association';

/**
 * Unit tests for the device-local {@link RowThreadAssociation} (Shadow Chat Invites, design
 * Component C; Requirement 14; task 3.2).
 *
 * Covers: record-then-resolve returns exactly the recorded ids; multiple threads stay disjoint;
 * an unknown thread resolves to `[]`; re-recording the same id is idempotent (no duplicate);
 * `forgetThread` removes only that thread's ids and leaves others intact; and a resolve after
 * `forgetThread` returns `[]`.
 */

/** Resolve a thread's row ids as a sorted array so equality assertions ignore resolution order. */
async function sorted(assoc: RowThreadAssociation, threadId: string): Promise<string[]> {
  return (await assoc.rowIdsForThread(threadId)).slice().sort();
}

test('record then rowIdsForThread returns exactly those ids (Req 14.1, 14.2)', async () => {
  const assoc = new InMemoryRowThreadAssociation();
  await assoc.record('row-1', 'thread-a');
  await assoc.record('row-2', 'thread-a');
  await assoc.record('row-3', 'thread-a');
  assert.deepEqual(await sorted(assoc, 'thread-a'), ['row-1', 'row-2', 'row-3']);
});

test('multiple threads stay disjoint (Req 14.2)', async () => {
  const assoc = new InMemoryRowThreadAssociation();
  await assoc.record('row-1', 'thread-a');
  await assoc.record('row-2', 'thread-b');
  await assoc.record('row-3', 'thread-a');
  await assoc.record('row-4', 'thread-b');
  assert.deepEqual(await sorted(assoc, 'thread-a'), ['row-1', 'row-3']);
  assert.deepEqual(await sorted(assoc, 'thread-b'), ['row-2', 'row-4']);
});

test('an unknown thread resolves to [] (Req 14.2)', async () => {
  const assoc = new InMemoryRowThreadAssociation();
  await assoc.record('row-1', 'thread-a');
  assert.deepEqual(await assoc.rowIdsForThread('thread-unknown'), []);
});

test('re-recording the same id is idempotent — no duplicate (Req 14.1)', async () => {
  const assoc = new InMemoryRowThreadAssociation();
  await assoc.record('row-1', 'thread-a');
  await assoc.record('row-1', 'thread-a');
  await assoc.record('row-1', 'thread-a');
  assert.deepEqual(await assoc.rowIdsForThread('thread-a'), ['row-1']);
});

test('re-recording an id under a new thread moves it (no stale membership)', async () => {
  const assoc = new InMemoryRowThreadAssociation();
  await assoc.record('row-1', 'thread-a');
  await assoc.record('row-1', 'thread-b');
  assert.deepEqual(await assoc.rowIdsForThread('thread-a'), []);
  assert.deepEqual(await assoc.rowIdsForThread('thread-b'), ['row-1']);
});

test('forgetThread removes only that thread and leaves others intact (Req 14.2)', async () => {
  const assoc = new InMemoryRowThreadAssociation();
  await assoc.record('row-1', 'thread-a');
  await assoc.record('row-2', 'thread-a');
  await assoc.record('row-3', 'thread-b');
  await assoc.forgetThread('thread-a');
  assert.deepEqual(await assoc.rowIdsForThread('thread-a'), []);
  assert.deepEqual(await sorted(assoc, 'thread-b'), ['row-3']);
});

test('rowIdsForThread after forget returns [] (Req 14.2)', async () => {
  const assoc = new InMemoryRowThreadAssociation();
  await assoc.record('row-1', 'thread-a');
  await assoc.forgetThread('thread-a');
  assert.deepEqual(await assoc.rowIdsForThread('thread-a'), []);
});

test('forgetThread is idempotent and safe on an unknown thread', async () => {
  const assoc = new InMemoryRowThreadAssociation();
  await assoc.record('row-1', 'thread-a');
  await assoc.forgetThread('thread-unknown'); // no-op, must not throw
  await assoc.forgetThread('thread-a');
  await assoc.forgetThread('thread-a'); // second forget is a no-op
  assert.deepEqual(await assoc.rowIdsForThread('thread-a'), []);
});

test('a thread can be re-used after being forgotten (no resurrection of old ids)', async () => {
  const assoc = new InMemoryRowThreadAssociation();
  await assoc.record('row-old', 'thread-a');
  await assoc.forgetThread('thread-a');
  await assoc.record('row-new', 'thread-a');
  assert.deepEqual(await assoc.rowIdsForThread('thread-a'), ['row-new']);
});
