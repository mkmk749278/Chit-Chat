import fc from 'fast-check';
import { afterEach, describe, expect, test } from 'vitest';

import type { IdentityRecord, MessageRow, SignalAddress } from '@chat-app/crypto';

import { InMemoryKeyStore, registerSessionEndWipe } from './in-memory-key-store';

/**
 * Property 19 — Web session-end wipe (task 7.3, Requirements 7.2, 7.4).
 *
 * Runs in jsdom so the real `window` unload lifecycle (`pagehide` / `beforeunload`) and
 * the web-storage APIs are present. Verifies that the in-memory KeyStore holds material
 * in JS memory only (never web storage) and that `destroy()` — and the unload wiring —
 * make all identity/session material unretrievable within the same event cycle.
 */

const bytes = (...v: number[]): Uint8Array => Uint8Array.from(v);

function makeIdentity(uid: string): IdentityRecord {
  return {
    uid,
    registrationId: 7,
    identityKeyPublic: bytes(1, 2, 3),
    identityKeyPrivate: bytes(4, 5, 6),
    signedPreKey: {
      keyId: 0,
      publicKey: bytes(7, 8),
      privateKey: bytes(9, 10),
      signature: bytes(11, 12),
    },
    oneTimePreKeys: [{ keyId: 1, publicKey: bytes(13), privateKey: bytes(14) }],
    createdAt: 1000,
  };
}

const addr = (uid: string): SignalAddress => ({ uid, deviceId: 'device-1' });

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('InMemoryKeyStore session-end wipe', () => {
  test('holds material in memory only — never touches web storage (7.2)', async () => {
    const store = new InMemoryKeyStore();
    await store.saveIdentity(makeIdentity('alice'));
    await store.saveDeviceId('dev-1');
    await store.saveSession(addr('bob'), bytes(20, 21, 22));

    // Nothing was written to any persistent web-storage mechanism.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  test('destroy() makes all identity/session/deviceId material unretrievable (7.4)', async () => {
    const store = new InMemoryKeyStore();
    await store.saveIdentity(makeIdentity('alice'));
    await store.saveDeviceId('dev-1');
    await store.saveSession(addr('bob'), bytes(20, 21, 22));

    // Present before the wipe.
    expect(await store.loadIdentity('alice')).not.toBeNull();
    expect(await store.loadDeviceId()).toBe('dev-1');
    expect(await store.loadSession(addr('bob'))).not.toBeNull();

    store.destroy();

    expect(await store.loadIdentity('alice')).toBeNull();
    expect(await store.loadDeviceId()).toBeNull();
    expect(await store.loadSession(addr('bob'))).toBeNull();
    // Writes after destroy are rejected so wiped material cannot be repopulated in place.
    await expect(store.saveDeviceId('again')).rejects.toThrow();
  });

  test('pagehide and beforeunload each trigger the wipe within the event cycle (7.4)', async () => {
    for (const eventType of ['pagehide', 'beforeunload'] as const) {
      const store = new InMemoryKeyStore();
      await store.saveIdentity(makeIdentity('alice'));
      const unregister = registerSessionEndWipe(store);

      window.dispatchEvent(new Event(eventType));

      // Synchronously wiped by the time the dispatch returns.
      expect(await store.loadIdentity('alice')).toBeNull();
      unregister();
    }
  });

  test('unregister removes the unload listeners (no wipe after teardown)', async () => {
    const store = new InMemoryKeyStore();
    await store.saveIdentity(makeIdentity('alice'));
    const unregister = registerSessionEndWipe(store);
    unregister();

    window.dispatchEvent(new Event('pagehide'));
    // Listener removed → still retrievable.
    expect(await store.loadIdentity('alice')).not.toBeNull();
  });

  test('Property 19: for any saved material, destroy() leaves nothing retrievable', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 20 }),
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 20 }),
        async (uids, sessionUids) => {
          const store = new InMemoryKeyStore();
          for (const uid of uids) {
            await store.saveIdentity(makeIdentity(uid));
          }
          for (const uid of sessionUids) {
            await store.saveSession(addr(uid), bytes(1, 2, 3));
          }
          await store.saveDeviceId('dev');

          store.destroy();

          for (const uid of uids) {
            expect(await store.loadIdentity(uid)).toBeNull();
          }
          for (const uid of sessionUids) {
            expect(await store.loadSession(addr(uid))).toBeNull();
          }
          expect(await store.loadDeviceId()).toBeNull();
          // And no web storage was ever used along the way.
          expect(window.localStorage.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
