import { beforeEach, describe, expect, test } from 'vitest';

import {
  ShadowSecretStore,
  createConversationRegistry,
  hashAlias,
  type AppMode,
  type ConversationRegistry,
  type RenderableMessage,
  type ShadowThreadRef,
} from '@chat-app/crypto';

import {
  createInMemoryShadowSecretPersistence,
  createWebShadowSearchHandler,
  deriveSurfaceChatList,
  isEventNotifiable,
} from './shadow-search';

/**
 * Web adapter tests for Shadow Chat search-bar interception + default-view exclusion (tasks 8.1,
 * 8.3, 8.4). These run the WEB binding end-to-end: a real `ShadowSecretStore` backed by the
 * in-memory persistence, the shared `ConversationRegistry`, and the shared search handler. They
 * assert that `/alias` opens the correct shadow thread in real mode; that a wrong/non-existent alias
 * and decoy mode are indistinguishable from an ordinary search (identical returned action, no shadow
 * signal); and that shadow threads never appear in the chat list, notifications, or previews
 * (Requirements 1.3, 1.4, 1.5, 7.5, 7.6, 8.3, 8.4).
 */

const ALIAS = '/contact1';
const PEER = 'peer-uid-bob';
const THREAD_ID = 'c'.repeat(64);

/** Provision the in-memory store with a real master secret, alias key, and one bound alias. */
async function provisionStore(): Promise<ShadowSecretStore> {
  const persistence = createInMemoryShadowSecretPersistence();
  const aliasKey = Uint8Array.from([5, 6, 7, 8, 9, 10]);
  await persistence.saveMasterSecret(Uint8Array.from([1, 2, 3, 4]));
  await persistence.saveAliasKey(aliasKey);
  const aliasHash = await hashAlias(ALIAS, aliasKey);
  expect(aliasHash).not.toBeNull();
  await persistence.saveAliasEntry({ aliasHash: aliasHash as string, ref: { peerUid: PEER, threadId: THREAD_ID } });
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
  const registry = createConversationRegistry({ platform: 'web' });
  const opened: ShadowThreadRef[] = [];
  const searched: string[] = [];
  const handle = createWebShadowSearchHandler({
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

describe('web shadow search interception (task 8.1)', () => {
  test('a valid alias in real mode opens the correct shadow thread (Req 1.3)', async () => {
    const h = await harness(() => 'real');
    const result = await h.handle(ALIAS);

    expect(result.kind).toBe('shadow');
    expect(h.opened).toEqual([{ threadId: THREAD_ID, peerUid: PEER }]);
    expect(h.searched).toEqual([]);
    // The thread is open in the registry (so inbound shadow events are accepted) but excluded from
    // the surface chat list.
    expect(deriveSurfaceChatList(h.registry)).toEqual([]);
  });

  test('a wrong alias in real mode is indistinguishable from an ordinary search (Req 1.4, 1.5)', async () => {
    const h = await harness(() => 'real');
    const result = await h.handle('/wrongalias');

    expect(result).toEqual({ kind: 'search', query: '/wrongalias' });
    expect(h.opened).toEqual([]);
    expect(h.searched).toEqual(['/wrongalias']);
  });

  test('decoy mode never resolves — same alias behaves exactly like a normal search (Req 8.6)', async () => {
    let mode: AppMode | null = 'decoy';
    const h = await harness(() => mode);

    const decoy = await h.handle(ALIAS);
    expect(decoy).toEqual({ kind: 'search', query: ALIAS });
    expect(h.opened).toEqual([]);
    expect(h.searched).toEqual([ALIAS]);

    // The ONLY differentiator is the mode: in real mode the identical text resolves.
    mode = 'real';
    const real = await h.handle(ALIAS);
    expect(real.kind).toBe('shadow');
    expect(h.opened).toEqual([{ threadId: THREAD_ID, peerUid: PEER }]);
  });

  test('an ordinary query is passed straight through to the search path', async () => {
    const h = await harness(() => 'real');
    const result = await h.handle('hello there');
    expect(result).toEqual({ kind: 'search', query: 'hello there' });
    expect(h.opened).toEqual([]);
    expect(h.searched).toEqual(['hello there']);
  });
});

describe('web default-view exclusion (task 8.3)', () => {
  let registry: ConversationRegistry;
  beforeEach(() => {
    registry = createConversationRegistry({ platform: 'web' });
  });

  test('chat list is driven by the registry surface view and excludes shadow threads (Req 7.5, 8.3)', () => {
    registry.openShadowThread(THREAD_ID, PEER);
    registry.apply({ type: 'message-appended', message: outMsg(1, 'surface'), remoteUid: 'alice' });
    registry.apply({ type: 'message-appended', message: outMsg(1_000_000_001, 'shadow'), remoteUid: PEER, threadId: THREAD_ID });

    const list = deriveSurfaceChatList(registry);
    expect(list.map((e) => e.remoteUid)).toEqual(['alice']);
    // The shadow message text never appears in any surface preview.
    expect(JSON.stringify(list)).not.toContain('shadow');
  });

  test('isEventNotifiable is false for shadow events and true for surface (Req 7.6, 8.3)', () => {
    const surface = { type: 'message-appended', message: outMsg(1, 'hi'), remoteUid: 'alice' } as const;
    const shadow = {
      type: 'message-appended',
      message: outMsg(1_000_000_001, 'secret'),
      remoteUid: PEER,
      threadId: THREAD_ID,
    } as const;
    expect(isEventNotifiable(registry, surface)).toBe(true);
    expect(isEventNotifiable(registry, shadow)).toBe(false);
  });
});
