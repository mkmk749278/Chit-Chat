/**
 * `@chat-app/crypto` — `SessionManager.getSafetyNumber` (Phase 2, Requirement 1.2/1.3).
 *
 * Verifies the session manager derives the conversation safety number from the local identity
 * key pair and the peer's stored identity key, that the result is symmetric across the two
 * devices (Req 1.2), changes when an identity key changes (Req 1.3), and is `null` until the
 * peer's key is known (no session / no inbound message yet).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ClaimedPreKeyBundle } from '@chat-app/types';

import type { SignalAddress, SignalProtocolStore } from './ports';
import { createSessionManager, type EncryptedMessage, type LibsignalEngine } from './session-manager';

/** A minimal in-memory {@link SignalProtocolStore} that holds an identity key pair + peer keys. */
function fakeStore(localPublic: Uint8Array): SignalProtocolStore & {
  peers: Map<string, Uint8Array>;
} {
  const peers = new Map<string, Uint8Array>();
  const key = (a: SignalAddress): string => `${a.uid}:${a.deviceId}`;
  return {
    peers,
    async getIdentityKeyPair() {
      return { publicKey: localPublic, privateKey: new Uint8Array([9, 9, 9]) };
    },
    async getLocalRegistrationId() {
      return 1;
    },
    async loadSession() {
      return null;
    },
    async storeSession() {},
    async loadPreKey() {
      return null;
    },
    async removePreKey() {},
    async loadSignedPreKey() {
      return null;
    },
    async saveIdentity() {
      return false;
    },
    async isTrustedIdentity() {
      return true;
    },
    async loadIdentityKey(addr: SignalAddress) {
      return peers.get(key(addr)) ?? null;
    },
  };
}

/** Engine that records the peer identity key on establish (mirrors libsignal trusting it). */
function recordingEngine(store: { peers: Map<string, Uint8Array> }, peerKey: Uint8Array): LibsignalEngine {
  return {
    async processPreKeyBundle(address: SignalAddress): Promise<void> {
      store.peers.set(`${address.uid}:${address.deviceId}`, peerKey);
    },
    async encrypt(): Promise<EncryptedMessage> {
      return { type: 1, ciphertext: new Uint8Array() };
    },
    async decrypt(): Promise<Uint8Array> {
      return new Uint8Array();
    },
  };
}

const bundle = (deviceId: string): ClaimedPreKeyBundle => ({
  deviceId,
  registrationId: 1,
  identityKey: Buffer.from([1]).toString('base64'),
  signedPreKey: { keyId: 1, publicKey: Buffer.from([2]).toString('base64'), signature: Buffer.from([3]).toString('base64') },
  oneTimePreKey: { keyId: 2, publicKey: Buffer.from([4]).toString('base64') },
});

test('getSafetyNumber is null before the peer identity key is known', async () => {
  const store = fakeStore(new Uint8Array([1, 2, 3, 4]));
  const sessions = createSessionManager(store, recordingEngine(store, new Uint8Array([5, 6, 7, 8])));
  assert.equal(await sessions.getSafetyNumber('alice', 'bob'), null);
});

test('getSafetyNumber derives a 60-digit number once a session exists', async () => {
  const store = fakeStore(new Uint8Array([1, 2, 3, 4]));
  const sessions = createSessionManager(store, recordingEngine(store, new Uint8Array([5, 6, 7, 8])));
  await sessions.establishSession('bob', bundle('dev-bob'));
  const safety = await sessions.getSafetyNumber('alice', 'bob');
  assert.notEqual(safety, null);
  assert.equal(safety?.raw.length, 60);
  assert.match(safety?.raw ?? '', /^[0-9]{60}$/);
});

test('both devices compute the SAME safety number (symmetry, Req 1.2)', async () => {
  const aliceKey = new Uint8Array([1, 2, 3, 4]);
  const bobKey = new Uint8Array([5, 6, 7, 8]);

  // Alice's device: local = aliceKey, peer = bobKey.
  const aliceStore = fakeStore(aliceKey);
  const alice = createSessionManager(aliceStore, recordingEngine(aliceStore, bobKey));
  await alice.establishSession('bob', bundle('dev-bob'));

  // Bob's device: local = bobKey, peer = aliceKey.
  const bobStore = fakeStore(bobKey);
  const bob = createSessionManager(bobStore, recordingEngine(bobStore, aliceKey));
  await bob.establishSession('alice', bundle('dev-alice'));

  const fromAlice = await alice.getSafetyNumber('alice', 'bob');
  const fromBob = await bob.getSafetyNumber('bob', 'alice');
  assert.equal(fromAlice?.raw, fromBob?.raw);
});

test('a changed peer identity key changes the safety number (Req 1.3)', async () => {
  const localKey = new Uint8Array([1, 2, 3, 4]);
  const store1 = fakeStore(localKey);
  const s1 = createSessionManager(store1, recordingEngine(store1, new Uint8Array([5, 6, 7, 8])));
  await s1.establishSession('bob', bundle('dev-bob'));

  const store2 = fakeStore(localKey);
  const s2 = createSessionManager(store2, recordingEngine(store2, new Uint8Array([9, 9, 9, 9])));
  await s2.establishSession('bob', bundle('dev-bob'));

  const a = await s1.getSafetyNumber('alice', 'bob');
  const b = await s2.getSafetyNumber('alice', 'bob');
  assert.notEqual(a?.raw, b?.raw);
});
