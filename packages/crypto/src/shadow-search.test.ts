import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DefaultConversationRegistry } from './conversation-registry';
import { hashAlias, type AliasEntry } from './shadow-chat';
import type { ShadowContext, ShadowThreadRef } from './shadow-secret-store';
import {
  createShadowSearchHandler,
  resolveSearchInput,
  type SearchResolution,
  type ShadowSearchStore,
} from './shadow-search';
import type { AppMode } from './app-lock';

/**
 * `@chat-app/crypto` — unit tests for the shared search-bar alias resolution (Shadow Chat, design
 * "Alias interception (UI adapter)"; tasks 8.1, 8.2, 8.4). Asserts that a valid alias opens the
 * correct shadow thread ONLY in real mode, that a wrong/non-existent alias, a decoy/null/locked
 * mode, an unprovisioned device, and an internal store error are ALL indistinguishable from an
 * ordinary search (identical `{ kind: 'search', query }` shape), and that the shared handler opens
 * the thread in the registry + navigates on a hit, else runs the ordinary search callback
 * (Requirements 1.1–1.6, 8.1, 8.4, 8.6).
 */

const ALIAS_KEY = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1]);
const MASTER = Uint8Array.from([1, 2, 3, 4, 5]);
const THREAD_ID = 'a'.repeat(64);
const PEER = 'peer-bob';

/** A fully-provisioned in-memory store backed by the given alias entries. */
function storeWith(entries: ReadonlyArray<AliasEntry<ShadowThreadRef>>): ShadowSearchStore {
  const context: ShadowContext = { masterSecret: MASTER, aliasKey: ALIAS_KEY };
  return {
    async getShadowContext(mode: AppMode | null): Promise<ShadowContext | null> {
      return mode === 'real' ? context : null;
    },
    async listAliasEntries(mode: AppMode | null): Promise<ReadonlyArray<AliasEntry<ShadowThreadRef>>> {
      return mode === 'real' ? entries.slice() : [];
    },
  };
}

/** Build the single stored alias→thread mapping used across most tests ("/contact1" → thread). */
async function contact1Entries(): Promise<AliasEntry<ShadowThreadRef>[]> {
  const aliasHash = await hashAlias('/contact1', ALIAS_KEY);
  assert.ok(aliasHash !== null);
  return [{ aliasHash, ref: { peerUid: PEER, threadId: THREAD_ID } }];
}

test('a valid alias in REAL mode resolves to its shadow thread (Req 1.3)', async () => {
  const store = storeWith(await contact1Entries());
  const result = await resolveSearchInput('/contact1', 'real', store);
  assert.deepEqual(result, { kind: 'shadow', threadId: THREAD_ID, peerUid: PEER });
});

test('the SAME alias in DECOY mode is an ordinary search (Req 8.6)', async () => {
  const store = storeWith(await contact1Entries());
  const result = await resolveSearchInput('/contact1', 'decoy', store);
  assert.deepEqual(result, { kind: 'search', query: '/contact1' });
});

test('the SAME alias in NULL (locked) mode is an ordinary search (Req 8.6)', async () => {
  const store = storeWith(await contact1Entries());
  const result = await resolveSearchInput('/contact1', null, store);
  assert.deepEqual(result, { kind: 'search', query: '/contact1' });
});

test('a wrong/non-existent alias in real mode is indistinguishable from an ordinary search (Req 1.4, 1.5)', async () => {
  const store = storeWith(await contact1Entries());
  const wrong = await resolveSearchInput('/contact2', 'real', store);
  // Identical shape and query to the decoy-mode result for the REAL alias — no shadow signal.
  assert.deepEqual(wrong, { kind: 'search', query: '/contact2' });
});

test('a non-alias input never consults the secret store and is an ordinary search', async () => {
  let consulted = false;
  const store: ShadowSearchStore = {
    async getShadowContext() {
      consulted = true;
      return { masterSecret: MASTER, aliasKey: ALIAS_KEY };
    },
    async listAliasEntries() {
      consulted = true;
      return [];
    },
  };
  const result = await resolveSearchInput('hello world', 'real', store);
  assert.deepEqual(result, { kind: 'search', query: 'hello world' });
  assert.equal(consulted, false, 'an ordinary query must not touch the shadow secret store');
});

test('an unprovisioned device (null context) in real mode falls through to search', async () => {
  const store: ShadowSearchStore = {
    async getShadowContext() {
      return null; // not provisioned
    },
    async listAliasEntries() {
      return [];
    },
  };
  const result = await resolveSearchInput('/contact1', 'real', store);
  assert.deepEqual(result, { kind: 'search', query: '/contact1' });
});

test('an internal store error in real mode fails closed to an ordinary search (no leak)', async () => {
  const store: ShadowSearchStore = {
    async getShadowContext(): Promise<ShadowContext | null> {
      throw new Error('persistence exploded');
    },
    async listAliasEntries() {
      return [];
    },
  };
  const result = await resolveSearchInput('/contact1', 'real', store);
  assert.deepEqual(result, { kind: 'search', query: '/contact1' });
});

test('a grammatically invalid alias (just "/") is an ordinary search', async () => {
  const store = storeWith(await contact1Entries());
  const result = await resolveSearchInput('/', 'real', store);
  assert.deepEqual(result, { kind: 'search', query: '/' });
});

test('createShadowSearchHandler opens the thread + navigates on a hit (Req 1.3, 8.1)', async () => {
  const registry = new DefaultConversationRegistry();
  const opened: ShadowThreadRef[] = [];
  const searched: string[] = [];
  const handler = createShadowSearchHandler({
    store: storeWith(await contact1Entries()),
    registry,
    getMode: () => 'real',
    onOpenShadowThread: (ref) => opened.push(ref),
    onOrdinarySearch: (q) => searched.push(q),
  });

  const result = await handler('/contact1');

  assert.deepEqual(result, { kind: 'shadow', threadId: THREAD_ID, peerUid: PEER });
  assert.deepEqual(opened, [{ threadId: THREAD_ID, peerUid: PEER }]);
  assert.deepEqual(searched, []);
  // The thread is now open in the registry, so subsequent inbound shadow events are accepted, yet
  // it is still excluded from the surface chat list.
  assert.deepEqual(registry.listSurfaceConversations(), []);
  assert.deepEqual(registry.getState({ kind: 'shadow', threadId: THREAD_ID, peerUid: PEER }).messages, []);
});

test('createShadowSearchHandler runs the ordinary search on a miss and opens no thread (Req 1.5)', async () => {
  const registry = new DefaultConversationRegistry();
  const opened: ShadowThreadRef[] = [];
  const searched: string[] = [];
  const handler = createShadowSearchHandler({
    store: storeWith(await contact1Entries()),
    registry,
    getMode: () => 'real',
    onOpenShadowThread: (ref) => opened.push(ref),
    onOrdinarySearch: (q) => searched.push(q),
  });

  const result = await handler('/nope');

  assert.deepEqual(result, { kind: 'search', query: '/nope' });
  assert.deepEqual(opened, []);
  assert.deepEqual(searched, ['/nope']);
});

test('createShadowSearchHandler in decoy mode never opens a thread (Req 8.6)', async () => {
  const registry = new DefaultConversationRegistry();
  let mode: AppMode | null = 'decoy';
  const opened: ShadowThreadRef[] = [];
  const searched: string[] = [];
  const handler = createShadowSearchHandler({
    store: storeWith(await contact1Entries()),
    registry,
    getMode: () => mode,
    onOpenShadowThread: (ref) => opened.push(ref),
    onOrdinarySearch: (q) => searched.push(q),
  });

  // Same real alias text, but decoy mode: indistinguishable from a normal search.
  const decoyResult = await handler('/contact1');
  assert.deepEqual(decoyResult, { kind: 'search', query: '/contact1' });
  assert.deepEqual(opened, []);
  assert.deepEqual(searched, ['/contact1']);

  // Switching to real mode resolves the identical text — proof the only differentiator is the mode.
  mode = 'real';
  const realResult = await handler('/contact1');
  assert.equal((realResult as Extract<SearchResolution, { kind: 'shadow' }>).kind, 'shadow');
  assert.deepEqual(opened, [{ threadId: THREAD_ID, peerUid: PEER }]);
});
