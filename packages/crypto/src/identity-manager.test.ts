import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DefaultIdentityManager,
  IdentityGenerationError,
  type GeneratedKeyPair,
  type LibsignalKeyGen,
} from './identity-manager';
import type { IdentityRecord, KeyStore } from './ports';

/** Deterministic key generator producing distinct, recognisable byte material. */
class FakeKeyGen implements LibsignalKeyGen {
  private counter = 0;
  identityKeyPairCalls = 0;
  /** Step name at which to throw, to exercise generation atomicity. */
  failAt: 'identity' | 'registration' | 'signed' | 'onetime' | null = null;
  registrationId = 7;

  private nextBytes(tag: number): Uint8Array {
    this.counter += 1;
    return Uint8Array.from([tag, this.counter, this.counter + 1]);
  }

  async generateIdentityKeyPair(): Promise<GeneratedKeyPair> {
    this.identityKeyPairCalls += 1;
    if (this.failAt === 'identity') throw new Error('boom identity');
    return { publicKey: this.nextBytes(0x10), privateKey: this.nextBytes(0x11) };
  }
  async generateRegistrationId(): Promise<number> {
    if (this.failAt === 'registration') throw new Error('boom reg');
    return this.registrationId;
  }
  async generatePreKeyPair(): Promise<GeneratedKeyPair> {
    if (this.failAt === 'signed' || this.failAt === 'onetime') {
      // Fail on the first prekey pair (signed) or, for 'onetime', allow signed then fail.
      if (this.failAt === 'signed') throw new Error('boom signed');
    }
    return { publicKey: this.nextBytes(0x20), privateKey: this.nextBytes(0x21) };
  }
  async signWithIdentity(): Promise<Uint8Array> {
    return this.nextBytes(0x30);
  }
}

/** In-memory KeyStore stub covering only what the IdentityManager touches. */
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

// Feature: phase1-client-messaging, Property 7: Well-formed public prekey bundle.

test('exposed bundle is well-formed: regId>=1, batch 1..200, unique non-negative ids, base64 (Property 7)', async () => {
  const mgr = new DefaultIdentityManager(fakeKeyStore(), new FakeKeyGen(), {
    oneTimePreKeyCount: 5,
  });
  const bundle = await mgr.ensureIdentity('alice');

  assert.ok(Number.isInteger(bundle.registrationId) && bundle.registrationId >= 1);
  assert.ok(isBase64(bundle.identityKey));
  assert.ok(isBase64(bundle.signedPreKey.publicKey));
  assert.ok(isBase64(bundle.signedPreKey.signature));

  assert.equal(bundle.oneTimePreKeys.length, 5);
  assert.ok(bundle.oneTimePreKeys.length >= 1 && bundle.oneTimePreKeys.length <= 200);
  const ids = bundle.oneTimePreKeys.map((k) => k.keyId);
  assert.ok(ids.every((id) => Number.isInteger(id) && id >= 0));
  assert.equal(new Set(ids).size, ids.length, 'one-time key ids are unique within the batch');
  assert.ok(bundle.oneTimePreKeys.every((k) => isBase64(k.publicKey)));
});

test('the exposed bundle carries no private key material (2.4, 2.5, 8.1)', async () => {
  const store = fakeKeyStore();
  const mgr = new DefaultIdentityManager(store, new FakeKeyGen(), { oneTimePreKeyCount: 3 });
  const bundle = await mgr.ensureIdentity('alice');

  const serialized = JSON.stringify(bundle);
  // The stored record holds private halves; none of their base64 may appear in the bundle.
  const record = store.saved[0]!;
  const privB64 = Buffer.from(record.identityKeyPrivate).toString('base64');
  assert.ok(!serialized.includes(privB64));
  assert.ok(!serialized.includes('private'));
  assert.ok(!serialized.includes('privateKey'));
});

// Feature: phase1-client-messaging, Property 8: Identity generation atomicity.

test('a generation failure persists nothing (Property 8)', async () => {
  for (const failAt of ['identity', 'registration', 'signed'] as const) {
    const store = fakeKeyStore();
    const keyGen = new FakeKeyGen();
    keyGen.failAt = failAt;
    const mgr = new DefaultIdentityManager(store, keyGen, { oneTimePreKeyCount: 3 });

    await assert.rejects(() => mgr.ensureIdentity('alice'), IdentityGenerationError);
    assert.equal(store.saved.length, 0, `failAt=${failAt} must persist nothing`);
    assert.equal(await store.loadIdentity('alice'), null);
  }
});

test('an out-of-range registration id is rejected as a generation error (2.3)', async () => {
  const store = fakeKeyStore();
  const keyGen = new FakeKeyGen();
  keyGen.registrationId = 0; // invalid (< 1)
  const mgr = new DefaultIdentityManager(store, keyGen);

  await assert.rejects(() => mgr.ensureIdentity('alice'), IdentityGenerationError);
  assert.equal(store.saved.length, 0);
});

// Feature: phase1-client-messaging, Property 9: Identity reuse idempotence.

test('ensureIdentity reuses a stored identity without regenerating (Property 9)', async () => {
  const store = fakeKeyStore();
  const keyGen = new FakeKeyGen();
  const mgr = new DefaultIdentityManager(store, keyGen, { oneTimePreKeyCount: 4 });

  const first = await mgr.ensureIdentity('alice');
  const second = await mgr.ensureIdentity('alice');

  assert.deepEqual(second, first);
  assert.equal(keyGen.identityKeyPairCalls, 1, 'identity key pair generated exactly once');
  assert.equal(store.saved.length, 1, 'persisted exactly once');
});

test('a second IdentityManager over the same store loads, not regenerates', async () => {
  const store = fakeKeyStore();
  const first = await new DefaultIdentityManager(store, new FakeKeyGen()).ensureIdentity('alice');

  const freshKeyGen = new FakeKeyGen();
  const reloaded = await new DefaultIdentityManager(store, freshKeyGen).ensureIdentity('alice');

  assert.equal(reloaded.registrationId, first.registrationId);
  assert.equal(reloaded.identityKey, first.identityKey);
  assert.equal(freshKeyGen.identityKeyPairCalls, 0, 'no regeneration when a stored identity exists');
});

test('constructor rejects an out-of-range one-time prekey count (2.2)', () => {
  assert.throws(() => new DefaultIdentityManager(fakeKeyStore(), new FakeKeyGen(), {
    oneTimePreKeyCount: 0,
  }), RangeError);
  assert.throws(() => new DefaultIdentityManager(fakeKeyStore(), new FakeKeyGen(), {
    oneTimePreKeyCount: 201,
  }), RangeError);
});

test('getPublicBundle throws before an identity is established', async () => {
  const mgr = new DefaultIdentityManager(fakeKeyStore(), new FakeKeyGen());
  await assert.rejects(() => mgr.getPublicBundle(), /No identity established/);
});
