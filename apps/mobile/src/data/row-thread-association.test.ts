/**
 * Tests for the durable vault-backed {@link createVaultRowThreadAssociation} (Shadow Chat Invites,
 * Req 14): record / resolve / forget per-thread row ids, round-tripping through a fake encrypted
 * vault that commits ONE serialized blob per mutate (modelling the production AES blob).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVaultRowThreadAssociation } from './row-thread-association';

interface DocShape {
  shadowRowThreads?: Record<string, string[]>;
}

/** A minimal fake of the encrypted PersistentVault: one committed JSON blob, atomic mutate. */
function fakeVault(initial: DocShape = {}) {
  let committed = JSON.stringify(initial);
  return {
    async read<T>(fn: (doc: DocShape) => T): Promise<T> {
      return fn(JSON.parse(committed) as DocShape);
    },
    async mutate<T>(fn: (doc: DocShape) => T): Promise<T> {
      const working = JSON.parse(committed) as DocShape;
      const result = fn(working);
      committed = JSON.stringify(working);
      return result;
    },
  };
}

test('record then rowIdsForThread returns exactly the rows for that thread', async () => {
  const assoc = createVaultRowThreadAssociation(fakeVault() as never);
  await assoc.record('r1', 'thread-A');
  await assoc.record('r2', 'thread-A');
  await assoc.record('r3', 'thread-B');
  assert.deepEqual((await assoc.rowIdsForThread('thread-A')).sort(), ['r1', 'r2']);
  assert.deepEqual(await assoc.rowIdsForThread('thread-B'), ['r3']);
  assert.deepEqual(await assoc.rowIdsForThread('unknown'), []);
});

test('record is idempotent and moves a re-tagged row to its new thread', async () => {
  const assoc = createVaultRowThreadAssociation(fakeVault() as never);
  await assoc.record('r1', 'thread-A');
  await assoc.record('r1', 'thread-A'); // idempotent
  assert.deepEqual(await assoc.rowIdsForThread('thread-A'), ['r1']);
  await assoc.record('r1', 'thread-B'); // move
  assert.deepEqual(await assoc.rowIdsForThread('thread-A'), []);
  assert.deepEqual(await assoc.rowIdsForThread('thread-B'), ['r1']);
});

test('forgetThread drops only that thread and is idempotent', async () => {
  const assoc = createVaultRowThreadAssociation(fakeVault() as never);
  await assoc.record('r1', 'thread-A');
  await assoc.record('r2', 'thread-B');
  await assoc.forgetThread('thread-A');
  assert.deepEqual(await assoc.rowIdsForThread('thread-A'), []);
  assert.deepEqual(await assoc.rowIdsForThread('thread-B'), ['r2']);
  await assoc.forgetThread('thread-A'); // idempotent no-op
  await assoc.forgetThread('never-existed'); // safe
});

test('durability: a fresh association over the same vault sees previously recorded rows', async () => {
  const vault = fakeVault();
  await createVaultRowThreadAssociation(vault as never).record('r1', 'thread-A');
  const reopened = createVaultRowThreadAssociation(vault as never);
  assert.deepEqual(await reopened.rowIdsForThread('thread-A'), ['r1']);
});
