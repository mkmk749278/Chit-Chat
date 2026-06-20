/**
 * Tests for the local "Clear chat" history purge (surface conversation only).
 *
 * These assert the core guarantee the UI relies on: clearing a conversation purges EXACTLY the rows
 * belonging to that conversation (rows whose `remoteUid` equals the conversation id) and NEVER any
 * row from another conversation, and that a store error is swallowed (fail-soft). They run under
 * `node --test` against the pure `clear-chat` module (no React Native), with a minimal in-memory fake
 * of the narrow `KeyStore` surface the purge uses.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { KeyStore, MessageRow } from '@chat-app/crypto';

import { clearConversationHistory, selectClearableRowIds } from './clear-chat';

const row = (id: string, remoteUid: string, seq: number): MessageRow => ({
  id,
  remoteUid,
  direction: 'out',
  seq,
  plaintext: `m${seq}`,
  status: 'sent',
  createdAt: seq,
});

/** A minimal fake of the two `KeyStore` methods the purge uses, recording purge calls. */
function fakeStore(rows: MessageRow[]): {
  store: Pick<KeyStore, 'loadMessages' | 'purgeMessages'>;
  purged: string[][];
  remaining: () => MessageRow[];
} {
  const purged: string[][] = [];
  const store: Pick<KeyStore, 'loadMessages' | 'purgeMessages'> = {
    async loadMessages() {
      return rows.map((r) => ({ ...r }));
    },
    async purgeMessages(ids: string[]) {
      purged.push([...ids]);
      for (const id of ids) {
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) {
          rows.splice(i, 1);
        }
      }
    },
  };
  return { store, purged, remaining: () => rows };
}

test('selectClearableRowIds returns only the target conversation rows, in order', () => {
  const rows = [row('a1', 'A', 1), row('b1', 'B', 1), row('a2', 'A', 2), row('c1', 'C', 1)];
  assert.deepEqual(selectClearableRowIds(rows, 'A'), ['a1', 'a2']);
  assert.deepEqual(selectClearableRowIds(rows, 'B'), ['b1']);
  assert.deepEqual(selectClearableRowIds(rows, 'Z'), []);
});

test('clearChatHistory purges exactly the target conversation ids and nothing else', async () => {
  const rows = [row('a1', 'A', 1), row('a2', 'A', 2), row('b1', 'B', 1), row('b2', 'B', 2)];
  const { store, purged, remaining } = fakeStore(rows);

  await clearConversationHistory(store, 'A');

  // Purged with EXACTLY the two A ids in a single call.
  assert.equal(purged.length, 1);
  assert.deepEqual([...purged[0]].sort(), ['a1', 'a2']);
  // Only B's rows survive.
  assert.deepEqual(
    remaining()
      .map((r) => r.id)
      .sort(),
    ['b1', 'b2'],
  );
});

test('clearChatHistory is a no-op (no purge call) when the conversation has no rows', async () => {
  const rows = [row('b1', 'B', 1)];
  const { store, purged, remaining } = fakeStore(rows);

  await clearConversationHistory(store, 'A');

  assert.deepEqual(purged, []);
  assert.deepEqual(remaining().map((r) => r.id), ['b1']);
});

test('clearChatHistory is fail-soft when the store throws', async () => {
  const failing: Pick<KeyStore, 'loadMessages' | 'purgeMessages'> = {
    async loadMessages(): Promise<MessageRow[]> {
      throw new Error('store unavailable');
    },
    async purgeMessages(): Promise<void> {
      /* never reached */
    },
  };
  // Must not throw.
  await clearConversationHistory(failing, 'A');
});
