import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import {
  ShadowSecretStore,
  createConversationRegistry,
  hashAlias,
  normalizeAlias,
  type AppMode,
  type ConversationRegistry,
  type RenderableMessage,
  type ShadowThreadRef,
} from '@chat-app/crypto';

import {
  createInMemoryShadowSecretPersistence,
  createMobileShadowSearchHandler,
  deriveSurfaceChatList,
  isEventNotifiable,
} from './shadow-search';

/**
 * Mobile adapter tests for Shadow Chat search-bar interception + default-view exclusion (tasks 8.2,
 * 8.3, 8.4). Runs the MOBILE binding end-to-end through the shared decision path: a real
 * `ShadowSecretStore` over the in-memory persistence, the shared `ConversationRegistry`, and the
 * shared handler. Asserts `/alias` opens the correct shadow thread in real mode; that a wrong/
 * non-existent alias and decoy mode are indistinguishable from an ordinary search; and that shadow
 * threads never appear in the chat list, notifications, or previews (Requirements 1.3, 1.4, 1.5,
 * 7.5, 7.6, 8.3, 8.4). Includes a >=100-iteration property for indistinguishability.
 *
 * This module is RN-free, so it compiles and runs under the mobile `node --test` runner — the same
 * shared `createShadowSearchHandler` the web adapter uses, proving the single cross-platform path
 * (C2).
 */

const ALIAS = '/contact1';
const PEER = 'peer-uid-bob';
const THREAD_ID = 'd'.repeat(64);
const ALIAS_KEY = Uint8Array.from([5, 6, 7, 8, 9, 10]);

async function provisionStore(): Promise<ShadowSecretStore> {
  const persistence = createInMemoryShadowSecretPersistence();
  await persistence.saveMasterSecret(Uint8Array.from([1, 2, 3, 4]));
  await persistence.saveAliasKey(ALIAS_KEY);
  const aliasHash = await hashAlias(ALIAS, ALIAS_KEY);
  assert.ok(aliasHash !== null);
  await persistence.saveAliasEntry({ aliasHash, ref: { peerUid: PEER, threadId: THREAD_ID } });
  return new ShadowSecretStore(persistence);
}

interface Harness {
  registry: ConversationRegistry;
  opened: ShadowThreadRef[];
  searched: string[];
  handle: (input: string) => Promise<{ kind: string }>;
}

async function harness(getMode: () => AppMode | null): Promise<Harness> {
  const store = await provisionStore();
  const registry = createConversationRegistry({ platform: 'mobile' });
  const opened: ShadowThreadRef[] = [];
  const searched: string[] = [];
  const handle = createMobileShadowSearchHandler({
    store,
    registry,
    getMode,
    onOpenShadowThread: (ref) => opened.push(ref),
    onOrdinarySearch: (q) => searched.push(q),
  });
  return { registry, opened, searched, handle };
}

const outMsg = (seq: number, text: string): RenderableMessage => ({
  id: `out-${seq}`,
  seq,
  direction: 'out',
  text,
  status: 'sending',
});

test('mobile: a valid alias in real mode opens the correct shadow thread (Req 1.3)', async () => {
  const h = await harness(() => 'real');
  const result = await h.handle(ALIAS);
  assert.deepEqual(result, { kind: 'shadow', threadId: THREAD_ID, peerUid: PEER });
  assert.deepEqual(h.opened, [{ threadId: THREAD_ID, peerUid: PEER }]);
  assert.deepEqual(h.searched, []);
  assert.deepEqual(deriveSurfaceChatList(h.registry), []);
});

test('mobile: a wrong alias is indistinguishable from an ordinary search (Req 1.4, 1.5)', async () => {
  const h = await harness(() => 'real');
  const result = await h.handle('/wrongalias');
  assert.deepEqual(result, { kind: 'search', query: '/wrongalias' });
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.searched, ['/wrongalias']);
});

test('mobile: decoy mode never resolves — same alias behaves like a normal search (Req 8.6)', async () => {
  let mode: AppMode | null = 'decoy';
  const h = await harness(() => mode);
  const decoy = await h.handle(ALIAS);
  assert.deepEqual(decoy, { kind: 'search', query: ALIAS });
  assert.deepEqual(h.opened, []);
  mode = 'real';
  const real = await h.handle(ALIAS);
  assert.equal(real.kind, 'shadow');
  assert.deepEqual(h.opened, [{ threadId: THREAD_ID, peerUid: PEER }]);
});

test('mobile: chat list excludes shadow threads and isEventNotifiable is false for shadow (Req 7.5, 7.6, 8.3)', () => {
  const registry = createConversationRegistry({ platform: 'mobile' });
  registry.openShadowThread(THREAD_ID, PEER);
  registry.apply({ type: 'message-appended', message: outMsg(1, 'surface'), remoteUid: 'alice' });
  registry.apply({
    type: 'message-appended',
    message: outMsg(1_000_000_001, 'shadow'),
    remoteUid: PEER,
    threadId: THREAD_ID,
  });

  const list = deriveSurfaceChatList(registry);
  assert.deepEqual(list.map((e) => e.remoteUid), ['alice']);
  assert.ok(!JSON.stringify(list).includes('shadow'), 'no shadow preview leaks into the surface list');

  assert.equal(
    isEventNotifiable(registry, { type: 'message-appended', message: outMsg(2, 'hi'), remoteUid: 'alice' }),
    true,
  );
  assert.equal(
    isEventNotifiable(registry, {
      type: 'message-appended',
      message: outMsg(1_000_000_002, 'secret'),
      remoteUid: PEER,
      threadId: THREAD_ID,
    }),
    false,
  );
});

test('Property: in real mode, only the correctly-bound alias resolves; everything else is a search', async () => {
  // Feature: shadow-chat, Correctness Property 4 (alias indistinguishability) via the mobile adapter.
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 32 }), async (input) => {
      const h = await harness(() => 'real');
      const result = await h.handle(input);
      const normalized = normalizeAlias(input);
      if (normalized === ALIAS) {
        assert.deepEqual(result, { kind: 'shadow', threadId: THREAD_ID, peerUid: PEER });
      } else {
        assert.deepEqual(result, { kind: 'search', query: input });
      }
    }),
    { numRuns: 120 },
  );
});
