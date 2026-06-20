import { describe, expect, test } from 'vitest';

import {
  ShadowSecretStore,
  createConversationRegistry,
  hashSecret,
  type AppMode,
  type ConversationRegistry,
  type ShadowThreadRef,
} from '@chat-app/crypto';

import {
  bindWebShadowChat,
  createInMemoryShadowSecretPersistence,
  createWebShadowSearchHandler,
  deriveSurfaceChatList,
  isValidAlias,
  verifyWebPin,
} from './shadow-search';

/**
 * Web adapter tests for the Shadow Chat long-press creation flow + per-chat-PIN re-entry seam
 * (task 15.2). These exercise the WEB binding end-to-end against a real `ShadowSecretStore` backed
 * by the in-memory persistence and the shared `ConversationRegistry`:
 *   - creation binds an alias-discriminated thread, opens it, and never touches the surface chat;
 *   - creation is inert in any non-`real` mode (Requirement 11.5);
 *   - an invalid alias binds nothing (Requirement 11.3);
 *   - re-entry opens a no-PIN thread directly, prompts + opens a PIN thread iff the PIN verifies,
 *     and a wrong PIN does not open (Requirements 12.1–12.4).
 */

const MY_UID = 'demo-uid-me';
const PEER = 'demo-uid-bob';

/** Provision the in-memory store with a real master secret + alias key (no aliases yet). */
function provisionStore(): ShadowSecretStore {
  const persistence = createInMemoryShadowSecretPersistence();
  void persistence.saveMasterSecret(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
  void persistence.saveAliasKey(Uint8Array.from([9, 10, 11, 12, 13, 14, 15, 16]));
  return new ShadowSecretStore(persistence);
}

interface CreationHarness {
  store: ShadowSecretStore;
  registry: ConversationRegistry;
  opened: ShadowThreadRef[];
  bind: (alias: string, pin?: string) => Promise<ShadowThreadRef | null>;
}

function creationHarness(getMode: () => AppMode | null): CreationHarness {
  const store = provisionStore();
  const registry = createConversationRegistry({ platform: 'web' });
  const opened: ShadowThreadRef[] = [];
  const bind = (alias: string, pin?: string): Promise<ShadowThreadRef | null> =>
    bindWebShadowChat({ store, registry, getMode, myUid: MY_UID, onOpenShadowThread: (ref) => opened.push(ref) }, PEER, alias, pin);
  return { store, registry, opened, bind };
}

describe('isValidAlias (inline validation, Req 11.3)', () => {
  test('accepts a normalisable alias and rejects invalid input', () => {
    expect(isValidAlias('/notes2')).toBe(true);
    expect(isValidAlias('  /Work  ')).toBe(true);
    expect(isValidAlias('notes')).toBe(false); // no leading slash
    expect(isValidAlias('/two words')).toBe(false);
    expect(isValidAlias('/')).toBe(false);
  });
});

describe('bindWebShadowChat (long-press creation, Req 11)', () => {
  test('real mode binds, opens the thread, and leaves the surface chat untouched (Req 11.4, 11.7, 11.8)', async () => {
    const h = creationHarness(() => 'real');
    const ref = await h.bind('/secret');

    expect(ref).not.toBeNull();
    expect(ref?.peerUid).toBe(PEER);
    expect(ref?.threadId).toMatch(/^[0-9a-f]{64}$/);
    // Navigation + registry open happened.
    expect(h.opened).toEqual([ref]);
    // No surface conversation was created — the created thread is hidden (Req 7.5, 11.10).
    expect(deriveSurfaceChatList(h.registry)).toEqual([]);
  });

  test('distinct aliases for the same contact yield distinct threads (Req 1.7, alias discrimination)', async () => {
    const h = creationHarness(() => 'real');
    const a = await h.bind('/one');
    const b = await h.bind('/two');
    expect(a?.threadId).not.toBe(b?.threadId);
  });

  test('non-real mode binds nothing and opens nothing (Req 11.5)', async () => {
    for (const mode of ['decoy', null] as const) {
      const h = creationHarness(() => mode);
      const ref = await h.bind('/secret');
      expect(ref).toBeNull();
      expect(h.opened).toEqual([]);
      expect(deriveSurfaceChatList(h.registry)).toEqual([]);
    }
  });

  test('an invalid alias binds nothing (Req 11.3)', async () => {
    const h = creationHarness(() => 'real');
    await expect(h.bind('not-an-alias')).rejects.toThrow();
    expect(h.opened).toEqual([]);
  });
});

describe('per-chat-PIN re-entry seam (Req 12.1–12.4)', () => {
  test('a no-PIN thread opens directly without prompting (Req 12.1)', async () => {
    const store = provisionStore();
    const registry = createConversationRegistry({ platform: 'web' });
    const opened: ShadowThreadRef[] = [];
    // Bind WITHOUT a pin.
    await bindWebShadowChat({ store, registry, getMode: () => 'real', myUid: MY_UID, onOpenShadowThread: () => {} }, PEER, '/open');

    let prompted = 0;
    const handle = createWebShadowSearchHandler({
      store,
      registry,
      getMode: () => 'real',
      onOpenShadowThread: (ref) => opened.push(ref),
      onOrdinarySearch: () => {},
      requestPinAndVerify: async () => {
        prompted += 1;
        return true;
      },
    });

    const result = await handle('/open');
    expect(result.kind).toBe('shadow');
    expect(prompted).toBe(0); // never prompted (no per-chat PIN)
    expect(opened).toHaveLength(1);
  });

  test('a PIN thread prompts and opens only when the PIN verifies (Req 12.2, 12.3)', async () => {
    const store = provisionStore();
    const registry = createConversationRegistry({ platform: 'web' });
    const opened: ShadowThreadRef[] = [];
    await bindWebShadowChat({ store, registry, getMode: () => 'real', myUid: MY_UID, onOpenShadowThread: () => {} }, PEER, '/locked', '4242');

    const makeHandler = (verify: (ref: ShadowThreadRef) => Promise<boolean>) =>
      createWebShadowSearchHandler({
        store,
        registry,
        getMode: () => 'real',
        onOpenShadowThread: (ref) => opened.push(ref),
        onOrdinarySearch: () => {},
        requestPinAndVerify: verify,
      });

    // Wrong PIN: prompt fired, but nothing opens (generic failure shown by the prompt UI, Req 12.4).
    const wrong = await makeHandler(async (ref) => verifyWebPin('0000', ref.pinVerifier as string))('/locked');
    expect(wrong.kind).toBe('shadow-locked');
    expect(opened).toHaveLength(0);

    // Correct PIN: opens the thread.
    const right = await makeHandler(async (ref) => verifyWebPin('4242', ref.pinVerifier as string))('/locked');
    expect(right.kind).toBe('shadow');
    expect(opened).toHaveLength(1);
  });

  test('verifyWebPin matches the stored verifier and rejects a wrong PIN (Req 12.3)', async () => {
    const verifier = await hashSecret('1234');
    expect(await verifyWebPin('1234', verifier)).toBe(true);
    expect(await verifyWebPin('9999', verifier)).toBe(false);
  });
});
