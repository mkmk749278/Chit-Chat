import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import {
  DefaultIdentityManager,
  IdentityGenerationError,
  MAX_ONE_TIME_PREKEYS,
  type GeneratedKeyPair,
  type LibsignalKeyGen,
} from './identity-manager';
import type { IdentityRecord, KeyStore } from './ports';

/** Deterministic key generator producing distinct, recognisable byte material. */
class FakeKeyGen implements LibsignalKeyGen {
  private counter = 0;
  identityKeyPairCalls = 0;
  failAt: 'identity' | 'registration' | 'signed' | 'onetime' | null = null;
  private preKeyCalls = 0;

  private nextBytes(tag: number): Uint8Array {
    this.counter += 1;
    // 16 distinct bytes (24-char base64) so a private value can never be a coincidental
    // short substring of the public bundle JSON in the Property-4 scan; the leading `tag`
    // keeps public (0x10/0x20) and private (0x11/0x21) material distinguishable.
    const bytes = new Uint8Array(16);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (tag * 31 + this.counter * 7 + i * 13) & 0xff;
    }
    bytes[0] = tag;
    return bytes;
  }
  async generateIdentityKeyPair(): Promise<GeneratedKeyPair> {
    this.identityKeyPairCalls += 1;
    if (this.failAt === 'identity') throw new Error('boom identity');
    return { publicKey: this.nextBytes(0x10), privateKey: this.nextBytes(0x11) };
  }
  async generateRegistrationId(): Promise<number> {
    if (this.failAt === 'registration') throw new Error('boom reg');
    return 7;
  }
  async generatePreKeyPair(): Promise<GeneratedKeyPair> {
    this.preKeyCalls += 1;
    // The first prekey pair is the signed prekey; later ones are one-time prekeys.
    if (this.failAt === 'signed' && this.preKeyCalls === 1) throw new Error('boom signed');
    if (this.failAt === 'onetime' && this.preKeyCalls > 1) throw new Error('boom onetime');
    return { publicKey: this.nextBytes(0x20), privateKey: this.nextBytes(0x21) };
  }
  async signWithIdentity(): Promise<Uint8Array> {
    return this.nextBytes(0x30);
  }
}

function fakeKeyStore(): KeyStore & { saved: IdentityRecord[] } {
  const map = new Map<string, IdentityRecord>();
  const saved: IdentityRecord[] = [];
  const store = {
    async saveIdentity(record: IdentityRecord): Promise<void> {
      saved.push(record);
      map.set(record.uid, record);
    },
    async loadIdentity(uid: string): Promise<IdentityRecord | null> {
      return map.get(uid) ?? null;
    },
  } as unknown as KeyStore;
  return Object.assign(store, { saved });
}

const isBase64 = (s: string): boolean => /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length > 0;

test('Property 7: well-formed public prekey bundle for any batch size', async () => {
  // Feature: phase1-client-messaging, Property 7: Well-formed public prekey bundle
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: MAX_ONE_TIME_PREKEYS }), async (count) => {
      const mgr = new DefaultIdentityManager(fakeKeyStore(), new FakeKeyGen(), {
        oneTimePreKeyCount: count,
      });
      const bundle = await mgr.ensureIdentity('alice');

      assert.ok(Number.isInteger(bundle.registrationId) && bundle.registrationId >= 1);
      assert.equal(bundle.oneTimePreKeys.length, count);
      assert.ok(count >= 1 && count <= MAX_ONE_TIME_PREKEYS);
      const ids = bundle.oneTimePreKeys.map((k) => k.keyId);
      assert.ok(ids.every((id) => Number.isInteger(id) && id >= 0));
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(isBase64(bundle.identityKey));
      assert.ok(isBase64(bundle.signedPreKey.publicKey));
      assert.ok(isBase64(bundle.signedPreKey.signature));
      assert.ok(bundle.oneTimePreKeys.every((k) => isBase64(k.publicKey)));
    }),
    { numRuns: 150 },
  );
});

test('Property 8: identity generation atomicity (failure persists nothing)', async () => {
  // Feature: phase1-client-messaging, Property 8: Identity generation atomicity
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('identity', 'registration', 'signed', 'onetime'),
      fc.integer({ min: 1, max: 20 }),
      async (failAt, count) => {
        const store = fakeKeyStore();
        const keyGen = new FakeKeyGen();
        keyGen.failAt = failAt as FakeKeyGen['failAt'];
        const mgr = new DefaultIdentityManager(store, keyGen, { oneTimePreKeyCount: count });
        await assert.rejects(() => mgr.ensureIdentity('alice'), IdentityGenerationError);
        assert.equal(store.saved.length, 0);
        assert.equal(await store.loadIdentity('alice'), null);
      },
    ),
    { numRuns: 120 },
  );
});

test('Property 9: identity reuse idempotence', async () => {
  // Feature: phase1-client-messaging, Property 9: Identity reuse idempotence
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), async (uid) => {
      const store = fakeKeyStore();
      const keyGen = new FakeKeyGen();
      const mgr = new DefaultIdentityManager(store, keyGen, { oneTimePreKeyCount: 3 });
      const first = await mgr.ensureIdentity(uid);
      const second = await mgr.ensureIdentity(uid);
      assert.deepEqual(second, first);
      assert.equal(keyGen.identityKeyPairCalls, 1);
      assert.equal(store.saved.length, 1);
    }),
    { numRuns: 120 },
  );
});

test('Property 4: only public key material leaves the device', async () => {
  // Feature: phase1-client-messaging, Property 4: Public keys only leave the device
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 25 }), async (count) => {
      const store = fakeKeyStore();
      const mgr = new DefaultIdentityManager(store, new FakeKeyGen(), { oneTimePreKeyCount: count });
      const bundle = await mgr.ensureIdentity('alice');

      // The exposed bundle is what the Device_Registrar transmits. None of the PRIVATE
      // halves stored in the IdentityRecord may appear anywhere in it.
      const serialized = JSON.stringify(bundle);
      const record = store.saved[0]!;
      const privateBlobs = [
        record.identityKeyPrivate,
        record.signedPreKey.privateKey,
        ...record.oneTimePreKeys.map((k) => k.privateKey),
      ].map((b) => Buffer.from(b).toString('base64'));

      for (const priv of privateBlobs) {
        assert.ok(!serialized.includes(priv), 'no private key material in the public bundle');
      }
    }),
    { numRuns: 120 },
  );
});
