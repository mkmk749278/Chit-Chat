/**
 * Tests for the encrypted persistent store and its CryptoBox.
 *
 * Run in Node against Node's WebCrypto with in-memory storage fakes (the same platform-agnostic
 * code runs on-device over expo-secure-store / AsyncStorage / msrcrypto). The decisive case is
 * "relaunch": a second store opened over the SAME backing storage must return the SAME identity
 * and deviceId — that is the property whose absence caused the device-churn delivery bug.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { IdentityRecord } from '@chat-app/crypto';

import { createCryptoBox, REQUIRED_KEY_LENGTH } from './crypto-box';
import {
  createPersistentKeyStore,
  createPersistentSignalProtocolStore,
  createPersistentVault,
  type BlobStorage,
  type PersistentVaultDeps,
  type SecureKeyStorage,
} from './persistent-store';

const webcrypto = globalThis.crypto;
const getRandomValues = <T extends ArrayBufferView>(array: T): T =>
  webcrypto.getRandomValues(array as unknown as ArrayBufferView) as unknown as T;
const cryptoBox = createCryptoBox({ subtle: webcrypto.subtle, getRandomValues });

/** A Map-backed storage fake shared across "relaunches" (the device's persistent disk). */
function fakeStorage(): SecureKeyStorage & BlobStorage {
  const map = new Map<string, string>();
  return {
    async getItem(key) {
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
  };
}

function deps(secure: SecureKeyStorage, blob: BlobStorage): PersistentVaultDeps {
  return { secure, blob, crypto: cryptoBox, getRandomValues };
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

function sampleIdentity(uid: string): IdentityRecord {
  return {
    uid,
    registrationId: 4242,
    identityKeyPublic: bytes(1, 2, 3, 4),
    identityKeyPrivate: bytes(5, 6, 7, 8),
    signedPreKey: {
      keyId: 0,
      publicKey: bytes(9, 9, 9),
      privateKey: bytes(8, 8, 8),
      signature: bytes(7, 7, 7),
    },
    oneTimePreKeys: [
      { keyId: 1, publicKey: bytes(11), privateKey: bytes(12) },
      { keyId: 2, publicKey: bytes(21), privateKey: bytes(22) },
    ],
    createdAt: 1_700_000_000_000,
  };
}

test('CryptoBox round-trips and rejects tampering and wrong keys', async () => {
  const key = getRandomValues(new Uint8Array(REQUIRED_KEY_LENGTH));
  const blob = await cryptoBox.encrypt('hello üñîçödé 🔐', key);
  assert.equal(await cryptoBox.decrypt(blob, key), 'hello üñîçödé 🔐');

  const wrongKey = getRandomValues(new Uint8Array(REQUIRED_KEY_LENGTH));
  await assert.rejects(() => cryptoBox.decrypt(blob, wrongKey));

  // Tamper a DEFINITE payload byte: the first base64 char after the "v1:" prefix maps fully
  // into the IV's first byte (its 6 bits are not padding bits), so swapping it to a char
  // guaranteed to differ always changes a real byte and the MAC always rejects. Rewriting the
  // trailing base64 char instead is flaky — base64 padding discards the last char's low bits,
  // so ~1/16 of the time the "tampered" string decodes to the identical bytes.
  const prefix = 'v1:';
  const body = blob.slice(prefix.length);
  const tampered = `${prefix}${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`;
  await assert.rejects(() => cryptoBox.decrypt(tampered, key));
});

test('identity and deviceId survive a relaunch (the churn fix)', async () => {
  const secure = fakeStorage();
  const blob = fakeStorage();
  const uid = 'user-1';

  // First launch: generate + persist identity, register a device.
  const vault1 = createPersistentVault(uid, deps(secure, blob));
  const store1 = createPersistentKeyStore(vault1);
  assert.equal(await store1.loadIdentity(uid), null);
  await store1.saveIdentity(sampleIdentity(uid));
  await store1.saveDeviceId('device-abc');
  store1.destroy(); // app closed

  // Second launch over the same disk: identity + deviceId are reused (no re-registration).
  const vault2 = createPersistentVault(uid, deps(secure, blob));
  const store2 = createPersistentKeyStore(vault2);
  const reloaded = await store2.loadIdentity(uid);
  assert.ok(reloaded !== null);
  assert.equal(reloaded.registrationId, 4242);
  assert.deepEqual([...reloaded.identityKeyPrivate], [5, 6, 7, 8]);
  assert.equal(await store2.loadDeviceId(), 'device-abc');
});

test('the on-disk blob is encrypted (no plaintext identity)', async () => {
  const secure = fakeStorage();
  const blob = fakeStorage();
  const uid = 'user-2';
  const store = createPersistentKeyStore(createPersistentVault(uid, deps(secure, blob)));
  await store.saveIdentity(sampleIdentity(uid));
  await store.saveDeviceId('secret-device-id');

  const stored = await blob.getItem('chat.vault.blob.v1.user-2');
  assert.ok(stored !== null);
  assert.ok(stored.startsWith('v1:'));
  assert.ok(!stored.includes('secret-device-id'));
  assert.ok(!stored.includes('registrationId'));
});

test('sequence counters and message rows persist and advance monotonically', async () => {
  const secure = fakeStorage();
  const blob = fakeStorage();
  const uid = 'user-3';
  const store1 = createPersistentKeyStore(createPersistentVault(uid, deps(secure, blob)));
  assert.equal(await store1.nextSeq('peer'), 1);
  assert.equal(await store1.nextSeq('peer'), 2);
  await store1.appendMessage({
    id: 'm1',
    remoteUid: 'peer',
    direction: 'out',
    seq: 1,
    plaintext: 'hi',
    status: 'sent',
    createdAt: 1,
  });
  store1.destroy();

  const store2 = createPersistentKeyStore(createPersistentVault(uid, deps(secure, blob)));
  assert.equal(await store2.nextSeq('peer'), 3); // continues, does not reset
  await store2.updateMessageStatus('m1', 'received');
});

test('signal sessions and prekey consumption survive a relaunch', async () => {
  const secure = fakeStorage();
  const blob = fakeStorage();
  const uid = 'user-4';
  const identity = sampleIdentity(uid);

  const vault1 = createPersistentVault(uid, deps(secure, blob));
  await createPersistentKeyStore(vault1).saveIdentity(identity);
  const signal1 = createPersistentSignalProtocolStore(vault1, identity);

  // Seeded from the identity's published one-time prekeys.
  assert.ok((await signal1.loadPreKey(1)) !== null);
  const peer = { uid: 'peer', deviceId: 'd1' };
  await signal1.storeSession(peer, bytes(99, 98, 97));
  await signal1.removePreKey(1); // consumed by an inbound prekey message
  vault1.release();

  // Relaunch: the session is restored and the consumed prekey stays gone.
  const vault2 = createPersistentVault(uid, deps(secure, blob));
  const signal2 = createPersistentSignalProtocolStore(vault2, identity);
  assert.deepEqual([...((await signal2.loadSession(peer)) ?? [])], [99, 98, 97]);
  assert.equal(await signal2.loadPreKey(1), null);
  assert.ok((await signal2.loadPreKey(2)) !== null);
});

test('remote identity trust is TOFU and detects a changed key', async () => {
  const secure = fakeStorage();
  const blob = fakeStorage();
  const uid = 'user-5';
  const identity = sampleIdentity(uid);
  const signal = createPersistentSignalProtocolStore(createPersistentVault(uid, deps(secure, blob)), identity);
  const peer = { uid: 'peer', deviceId: 'd1' };

  assert.equal(await signal.isTrustedIdentity(peer, bytes(1, 2, 3)), true); // unseen → trusted
  assert.equal(await signal.saveIdentity(peer, bytes(1, 2, 3)), false); // first save, unchanged
  assert.equal(await signal.saveIdentity(peer, bytes(1, 2, 3)), false); // same key, unchanged
  assert.equal(await signal.saveIdentity(peer, bytes(9, 9, 9)), true); // changed key reported
});

test('wipe erases identity and key so a fresh launch starts clean', async () => {
  const secure = fakeStorage();
  const blob = fakeStorage();
  const uid = 'user-6';
  const vault = createPersistentVault(uid, deps(secure, blob));
  await createPersistentKeyStore(vault).saveIdentity(sampleIdentity(uid));
  await vault.wipe();

  assert.equal(await blob.getItem('chat.vault.blob.v1.user-6'), null);
  assert.equal(await secure.getItem('chat.vault.dek.v1.user-6'), null);

  const fresh = createPersistentKeyStore(createPersistentVault(uid, deps(secure, blob)));
  assert.equal(await fresh.loadIdentity(uid), null);
});

test('a corrupt blob surfaces an error rather than silently resetting', async () => {
  const secure = fakeStorage();
  const blob = fakeStorage();
  const uid = 'user-7';
  await createPersistentKeyStore(createPersistentVault(uid, deps(secure, blob))).saveIdentity(sampleIdentity(uid));

  // Corrupt the stored ciphertext; the MAC must fail and the error must surface.
  await blob.setItem('chat.vault.blob.v1.user-7', 'v1:AAAAAAAAAAAAAAAAAAAAAA==');
  const store = createPersistentKeyStore(createPersistentVault(uid, deps(secure, blob)));
  await assert.rejects(() => store.loadIdentity(uid));
});
