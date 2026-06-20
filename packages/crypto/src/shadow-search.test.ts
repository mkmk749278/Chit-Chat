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


/* ------------------------------------------------------------------------------------------------
 * Task 14.2 — optional per-chat PIN re-entry in the shared search resolver (Property 11,
 * Requirements 12.2, 12.3, 12.4, 12.7). A matched shadow thread MAY carry a hash-only `pinVerifier`;
 * when present, `createShadowSearchHandler` must require a successful verification through the
 * INJECTED `requestPinAndVerify` seam (off the UI thread) before opening the thread. A correct PIN
 * opens it; a wrong PIN, a thrown verification error, or a missing seam all yield the GENERIC
 * `{ kind: 'denied' }` (no threadId/peerUid/query — no shadow-specific signal), open nothing, and
 * emit no ordinary-search signal. A no-PIN match opens directly without prompting.
 * ---------------------------------------------------------------------------------------------- */

const PIN_VERIFIER = 'pbkdf2$100000$c2FsdA==$dmVyaWZpZXI=';

/** A single stored alias→thread mapping whose thread carries an optional per-chat `pinVerifier`. */
async function contact1EntriesWithPin(): Promise<AliasEntry<ShadowThreadRef>[]> {
  const aliasHash = await hashAlias('/contact1', ALIAS_KEY);
  assert.ok(aliasHash !== null);
  return [{ aliasHash, ref: { peerUid: PEER, threadId: THREAD_ID, pinVerifier: PIN_VERIFIER } }];
}

test('resolveSearchInput surfaces the matched thread pinVerifier on a PIN-set alias (Req 12.2)', async () => {
  const store = storeWith(await contact1EntriesWithPin());
  const result = await resolveSearchInput('/contact1', 'real', store);
  assert.deepEqual(result, {
    kind: 'shadow',
    threadId: THREAD_ID,
    peerUid: PEER,
    pinVerifier: PIN_VERIFIER,
  });
});

test('PIN-set alias: a correct PIN (seam resolves true) opens the thread (Req 12.2)', async () => {
  const registry = new DefaultConversationRegistry();
  const opened: ShadowThreadRef[] = [];
  const searched: string[] = [];
  const verifyCalls: ShadowThreadRef[] = [];
  const handler = createShadowSearchHandler({
    store: storeWith(await contact1EntriesWithPin()),
    registry,
    getMode: () => 'real',
    onOpenShadowThread: (ref) => opened.push(ref),
    onOrdinarySearch: (q) => searched.push(q),
    requestPinAndVerify: async (ref) => {
      verifyCalls.push(ref);
      return true;
    },
  });

  const result = await handler('/contact1');

  // The thread opens and the original shadow resolution (incl. pinVerifier) is returned.
  assert.deepEqual(result, {
    kind: 'shadow',
    threadId: THREAD_ID,
    peerUid: PEER,
    pinVerifier: PIN_VERIFIER,
  });
  assert.deepEqual(opened, [{ threadId: THREAD_ID, peerUid: PEER, pinVerifier: PIN_VERIFIER }]);
  assert.deepEqual(searched, []);
  // Verification ran through the INJECTED seam (off-thread), receiving the matched ref incl. its
  // hash-only pinVerifier — proof the gating is delegated, not done inline.
  assert.deepEqual(verifyCalls, [{ threadId: THREAD_ID, peerUid: PEER, pinVerifier: PIN_VERIFIER }]);
  // The thread is now open in the registry yet still excluded from the surface chat list.
  assert.deepEqual(registry.listSurfaceConversations(), []);
  assert.deepEqual(
    registry.getState({ kind: 'shadow', threadId: THREAD_ID, peerUid: PEER }).messages,
    [],
  );
});

test('PIN-set alias: a wrong PIN (seam resolves false) is a generic denial, opens nothing (Req 12.3, 12.4, 12.7)', async () => {
  const registry = new DefaultConversationRegistry();
  const opened: ShadowThreadRef[] = [];
  const searched: string[] = [];
  let verified = false;
  const handler = createShadowSearchHandler({
    store: storeWith(await contact1EntriesWithPin()),
    registry,
    getMode: () => 'real',
    onOpenShadowThread: (ref) => opened.push(ref),
    onOrdinarySearch: (q) => searched.push(q),
    requestPinAndVerify: async () => {
      verified = true;
      return false;
    },
  });

  const result = await handler('/contact1');

  // GENERIC failure — no threadId, peerUid, query, or any shadow-identifying field.
  assert.deepEqual(result, { kind: 'denied' });
  assert.equal(verified, true, 'the injected verification seam must have been consulted');
  // Nothing opened, and crucially NO ordinary-search signal either (Req 12.7).
  assert.deepEqual(opened, []);
  assert.deepEqual(searched, []);
  // The shadow thread was never created in the registry.
  assert.deepEqual(registry.listSurfaceConversations(), []);
});

test('PIN-set alias: a thrown verification error fails closed to a generic denial (Req 12.3, 12.7)', async () => {
  const registry = new DefaultConversationRegistry();
  const opened: ShadowThreadRef[] = [];
  const searched: string[] = [];
  const handler = createShadowSearchHandler({
    store: storeWith(await contact1EntriesWithPin()),
    registry,
    getMode: () => 'real',
    onOpenShadowThread: (ref) => opened.push(ref),
    onOrdinarySearch: (q) => searched.push(q),
    requestPinAndVerify: async () => {
      throw new Error('verifier provider exploded');
    },
  });

  const result = await handler('/contact1');

  assert.deepEqual(result, { kind: 'denied' });
  assert.deepEqual(opened, []);
  assert.deepEqual(searched, []);
});

test('PIN-set alias: an OMITTED verification seam fails closed (denied, opens nothing) (Req 12.3)', async () => {
  const registry = new DefaultConversationRegistry();
  const opened: ShadowThreadRef[] = [];
  const searched: string[] = [];
  const handler = createShadowSearchHandler({
    store: storeWith(await contact1EntriesWithPin()),
    registry,
    getMode: () => 'real',
    onOpenShadowThread: (ref) => opened.push(ref),
    onOrdinarySearch: (q) => searched.push(q),
    // requestPinAndVerify intentionally omitted: a PIN-protected thread cannot be verified.
  });

  const result = await handler('/contact1');

  assert.deepEqual(result, { kind: 'denied' });
  assert.deepEqual(opened, []);
  assert.deepEqual(searched, []);
});

test('a no-PIN alias opens directly WITHOUT invoking the verification seam (Req 12.2)', async () => {
  const registry = new DefaultConversationRegistry();
  const opened: ShadowThreadRef[] = [];
  let promptCount = 0;
  const handler = createShadowSearchHandler({
    store: storeWith(await contact1Entries()),
    registry,
    getMode: () => 'real',
    onOpenShadowThread: (ref) => opened.push(ref),
    onOrdinarySearch: () => undefined,
    requestPinAndVerify: async () => {
      promptCount += 1;
      return true;
    },
  });

  const result = await handler('/contact1');

  assert.deepEqual(result, { kind: 'shadow', threadId: THREAD_ID, peerUid: PEER });
  assert.deepEqual(opened, [{ threadId: THREAD_ID, peerUid: PEER }]);
  assert.equal(promptCount, 0, 'a thread with no per-chat PIN must never prompt for one');
});

test('the generic denial is byte-for-byte identical regardless of WHY the PIN failed (indistinguishable)', async () => {
  // Build three PIN-set handlers whose only difference is the failure mode of the seam.
  const base = {
    store: storeWith(await contact1EntriesWithPin()),
    registry: new DefaultConversationRegistry(),
    getMode: () => 'real' as const,
    onOpenShadowThread: () => undefined,
    onOrdinarySearch: () => undefined,
  };
  const falseResult = await createShadowSearchHandler({
    ...base,
    requestPinAndVerify: async () => false,
  })('/contact1');
  const throwResult = await createShadowSearchHandler({
    ...base,
    requestPinAndVerify: async () => {
      throw new Error('boom');
    },
  })('/contact1');
  const omittedResult = await createShadowSearchHandler({ ...base })('/contact1');

  assert.deepEqual(falseResult, { kind: 'denied' });
  assert.deepEqual(throwResult, falseResult);
  assert.deepEqual(omittedResult, falseResult);
});
