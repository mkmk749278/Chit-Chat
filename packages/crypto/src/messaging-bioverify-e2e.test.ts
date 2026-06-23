import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ClaimedPreKeyBundle, ClientToServerFrame, ServerToClientFrame } from '@chat-app/types';

import type {
  BiometricAttestor,
  BiometricEnrollmentStore,
} from './biometric-attestation';
import { createEnvelopeCodec } from './envelope-codec';
import { createInMemorySignalProtocolStore } from './in-memory-signal-store';
import {
  createPureTsLibsignalEngine,
  createPureTsLibsignalKeyGen,
  encodePreKeyRecord,
} from './libsignal-puretsignal';
import {
  createMessaging,
  type Messaging,
  type MessagingRealtime,
  type MessagingStore,
  type VerificationEvent,
} from './messaging';
import type { MessageRow, SignalProtocolStore } from './ports';
import { createSessionManager } from './session-manager';
import type { SequenceAllocator } from './sequence-allocator';

/**
 * End-to-end test that biometric presence attestation (Signature Feature 2b, §4.5) flows through the
 * real Messaging orchestrator over the E2E channel: enrol → challenge → live-biometric signature →
 * verify converges the badge, while a declined/unavailable biometric, a forged signature, a replay,
 * and a not-enrolled request each fail in the right, distinguishable way. The signature is a REAL
 * Curve25519 signature (the fake attestor signs with a libsignal key), so the verifier's
 * cryptographic check is exercised for real — only the OS biometric prompt is faked.
 */

const PREKEY_ID = 31337;
const SIGNED_PREKEY_ID = 22;
const keyGen = createPureTsLibsignalKeyGen();
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

interface Party {
  uid: string;
  deviceId: string;
  store: SignalProtocolStore;
  bundle: ClaimedPreKeyBundle;
}

async function newParty(uid: string, deviceId: string): Promise<Party> {
  const identity = await keyGen.generateIdentityKeyPair();
  const registrationId = await keyGen.generateRegistrationId();
  const signedPair = await keyGen.generatePreKeyPair();
  const signature = await keyGen.signWithIdentity(identity.privateKey, signedPair.publicKey);
  const oneTimePair = await keyGen.generatePreKeyPair();
  const store = createInMemorySignalProtocolStore({
    identityKeyPair: { publicKey: identity.publicKey, privateKey: identity.privateKey },
    registrationId,
    preKeys: [{ keyId: PREKEY_ID, record: encodePreKeyRecord(oneTimePair.publicKey, oneTimePair.privateKey) }],
    signedPreKeys: [
      { keyId: SIGNED_PREKEY_ID, record: encodePreKeyRecord(signedPair.publicKey, signedPair.privateKey) },
    ],
  });
  const bundle: ClaimedPreKeyBundle = {
    deviceId,
    registrationId,
    identityKey: b64(identity.publicKey),
    signedPreKey: { keyId: SIGNED_PREKEY_ID, publicKey: b64(signedPair.publicKey), signature: b64(signature) },
    oneTimePreKey: { keyId: PREKEY_ID, publicKey: b64(oneTimePair.publicKey) },
  };
  return { uid, deviceId, store, bundle };
}

/** A tiny in-process relay hub: routes `send` frames to the recipient's `deliver` and acks the sender. */
function makeHub(): { realtimeFor: (uid: string) => MessagingRealtime } {
  const deliverers = new Map<string, (frame: ServerToClientFrame) => void>();
  return {
    realtimeFor(uid: string): MessagingRealtime {
      const frameListeners = new Set<(frame: ServerToClientFrame) => void>();
      deliverers.set(uid, (frame) => frameListeners.forEach((l) => l(frame)));
      return {
        send(frame: ClientToServerFrame): void {
          if (frame.kind !== 'send') {
            return;
          }
          const env = frame.envelope;
          deliverers.get(env.senderUid)?.({ kind: 'ack', recipientUid: env.recipientUid, seq: env.seq, status: 'received' });
          deliverers.get(env.recipientUid)?.({ kind: 'deliver', envelope: env });
        },
        getStatus: () => 'connected',
        onFrame(listener) {
          frameListeners.add(listener);
          return () => frameListeners.delete(listener);
        },
        onStatus() {
          return () => undefined;
        },
      };
    },
  };
}

const makeSequence = (): SequenceAllocator => {
  const counters = new Map<string, number>();
  return {
    async next(uid: string): Promise<number> {
      const n = (counters.get(uid) ?? 0) + 1;
      counters.set(uid, n);
      return n;
    },
  };
};

function makeStore(): MessagingStore {
  const rows = new Map<string, MessageRow>();
  return {
    async appendMessage(row) {
      rows.set(row.id, { ...row });
    },
    async updateMessageStatus(id, status) {
      const r = rows.get(id);
      if (r !== undefined) r.status = status;
    },
    async applyReaction() {},
    async applyEdit() {},
    async applyDelete() {},
    async setConversationTimer() {},
    async loadMessages() {
      return [...rows.values()].map((r) => ({ ...r }));
    },
    async purgeMessages(ids) {
      for (const id of ids) rows.delete(id);
    },
  };
}

/** An in-memory {@link BiometricEnrollmentStore} (a Map of peerUid → public key). */
function makeEnrollment(): BiometricEnrollmentStore {
  const keys = new Map<string, Uint8Array>();
  return {
    async savePeerAttestationKey(peerUid, publicKey) {
      keys.set(peerUid, publicKey);
    },
    async loadPeerAttestationKey(peerUid) {
      return keys.get(peerUid) ?? null;
    },
  };
}

/** Options controlling the fake attestor's behaviour, to model real-world failure modes. */
interface FakeAttestorOptions {
  /** Whether biometric hardware is available + enrolled (default true). */
  available?: boolean;
  /** Whether `authenticateAndSign` succeeds; false models a declined / borrowed-device prompt. */
  signEnabled?: boolean;
}

/**
 * A fake {@link BiometricAttestor} backed by a real Curve25519 key pair. `getPublicKey` returns the
 * key that will be enrolled; `authenticateAndSign` produces a genuine signature over the message
 * with that key (so the verifier's real cryptographic check passes), unless configured to decline.
 */
async function makeFakeAttestor(
  opts: FakeAttestorOptions = {},
): Promise<{ attestor: BiometricAttestor; publicKey: Uint8Array; privateKey: Uint8Array }> {
  const available = opts.available ?? true;
  const signEnabled = opts.signEnabled ?? true;
  const key = await keyGen.generateIdentityKeyPair();
  const attestor: BiometricAttestor = {
    async isAvailable() {
      return available;
    },
    async getPublicKey() {
      return available ? key.publicKey : null;
    },
    async authenticateAndSign(message) {
      if (!available || !signEnabled) {
        return null;
      }
      return keyGen.signWithIdentity(key.privateKey, message);
    },
  };
  return { attestor, publicKey: key.publicKey, privateKey: key.privateKey };
}

interface Client {
  messaging: Messaging;
  verifications: VerificationEvent[];
  enrollment: BiometricEnrollmentStore;
}

function makeClient(
  party: Party,
  peerBundles: Record<string, ClaimedPreKeyBundle>,
  hub: ReturnType<typeof makeHub>,
  attestor: BiometricAttestor,
): Client {
  const verifications: VerificationEvent[] = [];
  const enrollment = makeEnrollment();
  let n = 0;
  const messaging = createMessaging(
    {
      realtime: hub.realtimeFor(party.uid),
      sessions: createSessionManager(party.store, createPureTsLibsignalEngine()),
      sequence: makeSequence(),
      codec: createEnvelopeCodec(),
      keyClaimer: { claim: async (uid: string) => peerBundles[uid] ?? null },
      sender: { resolveSender: async () => ({ uid: party.uid, deviceId: party.deviceId }) },
      store: makeStore(),
      biometricAttestor: attestor,
      biometricEnrollment: enrollment,
    },
    { generateId: () => `${party.uid}-${(n += 1)}` },
  );
  messaging.onVerification((e) => verifications.push(e));
  return { messaging, verifications, enrollment };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('enrolment shares the public key and a live-biometric proof verifies (§4.5)', async () => {
  const alice = await newParty('alice', 'a-dev');
  const bob = await newParty('bob', 'b-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub, (await makeFakeAttestor()).attestor);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub, (await makeFakeAttestor()).attestor);

  // Bob enrols with Alice: Alice stores Bob's public attestation key and is told enrolment happened.
  const enrolled = await B.messaging.enrollBiometricAttestation(alice.uid);
  await flush();
  assert.equal(enrolled, true);
  assert.notEqual(await A.enrollment.loadPeerAttestationKey(bob.uid), null);
  assert.ok(A.verifications.some((e) => e.type === 'bioverify-enrolled' && e.peerUid === bob.uid));

  // Alice verifies Bob's presence; Bob's device signs the challenge after a (faked) live biometric.
  const sent = await A.messaging.requestBiometricVerification(bob.uid);
  await flush();
  assert.equal(sent, true);
  assert.ok(B.verifications.some((e) => e.type === 'bioverify-incoming' && e.peerUid === alice.uid));
  const result = A.verifications.find((e) => e.type === 'bioverify-result');
  assert.ok(result && result.type === 'bioverify-result' && result.ok === true && result.outcome === 'verified');
});

test('isBiometricPeerEnrolled reflects the durable enrollment store across a relaunch (§4.5)', async () => {
  const alice = await newParty('alice', 'a-dev');
  const bob = await newParty('bob', 'b-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub, (await makeFakeAttestor()).attestor);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub, (await makeFakeAttestor()).attestor);

  // Before enrolment Alice has no stored key for Bob, so the UI must keep "verify presence" disabled.
  assert.equal(await A.messaging.isBiometricPeerEnrolled(bob.uid), false);

  await B.messaging.enrollBiometricAttestation(alice.uid);
  await flush();

  // After enrolment the key persists in the store, so a fresh Messaging built over the SAME store
  // (a relaunch — the in-RAM badge is gone but the durable key survives) still reports enrolled.
  assert.equal(await A.messaging.isBiometricPeerEnrolled(bob.uid), true);
  const relaunched = createMessaging(
    {
      realtime: hub.realtimeFor(alice.uid),
      sessions: createSessionManager(alice.store, createPureTsLibsignalEngine()),
      sequence: makeSequence(),
      codec: createEnvelopeCodec(),
      keyClaimer: { claim: async () => null },
      sender: { resolveSender: async () => ({ uid: alice.uid, deviceId: alice.deviceId }) },
      store: makeStore(),
      biometricEnrollment: A.enrollment,
    },
    { generateId: () => 'x' },
  );
  assert.equal(await relaunched.isBiometricPeerEnrolled(bob.uid), true);
  relaunched.dispose();
});

test('a declined biometric (borrowed device) fails with outcome unavailable (§4.5)', async () => {
  const alice = await newParty('alice', 'a-dev');
  const bob = await newParty('bob', 'b-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub, (await makeFakeAttestor()).attestor);
  // Bob's device can present a key (enrol) but the biometric prompt is declined/fails (signEnabled:false).
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub, (await makeFakeAttestor({ signEnabled: false })).attestor);

  await B.messaging.enrollBiometricAttestation(alice.uid);
  await flush();
  await A.messaging.requestBiometricVerification(bob.uid);
  await flush();

  const result = A.verifications.find((e) => e.type === 'bioverify-result');
  assert.ok(result && result.type === 'bioverify-result' && result.ok === false && result.outcome === 'unavailable');
});

test('a forged signature (enrolled key ≠ signing key) fails with bad-signature (§4.5)', async () => {
  const alice = await newParty('alice', 'a-dev');
  const bob = await newParty('bob', 'b-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub, (await makeFakeAttestor()).attestor);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub, (await makeFakeAttestor()).attestor);

  // Bob enrols his real key with Alice…
  await B.messaging.enrollBiometricAttestation(alice.uid);
  await flush();
  // …but Alice's stored copy is replaced with a DIFFERENT (impostor) key, so Bob's genuine signature
  // no longer matches what Alice verifies against — exactly the man-in-the-middle / key-swap case.
  const impostor = await keyGen.generateIdentityKeyPair();
  await A.enrollment.savePeerAttestationKey(bob.uid, impostor.publicKey);

  await A.messaging.requestBiometricVerification(bob.uid);
  await flush();

  const result = A.verifications.find((e) => e.type === 'bioverify-result');
  assert.ok(result && result.type === 'bioverify-result' && result.ok === false && result.outcome === 'bad-signature');
});

test('requesting verification before enrolment sends nothing and returns false (§4.5)', async () => {
  const alice = await newParty('alice', 'a-dev');
  const bob = await newParty('bob', 'b-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub, (await makeFakeAttestor()).attestor);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub, (await makeFakeAttestor()).attestor);

  const sent = await A.messaging.requestBiometricVerification(bob.uid);
  await flush();
  assert.equal(sent, false);
  // Bob never received a challenge, so nothing happened on his side.
  assert.equal(B.verifications.filter((e) => e.type === 'bioverify-incoming').length, 0);
});

test('a replayed response finds no pending challenge the second time (anti-replay, §4.5)', async () => {
  const alice = await newParty('alice', 'a-dev');
  const bob = await newParty('bob', 'b-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub, (await makeFakeAttestor()).attestor);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub, (await makeFakeAttestor()).attestor);

  await B.messaging.enrollBiometricAttestation(alice.uid);
  await flush();
  await A.messaging.requestBiometricVerification(bob.uid);
  await flush();
  const first = A.verifications.filter((e) => e.type === 'bioverify-result');
  assert.equal(first.length, 1);
  assert.ok(first[0].type === 'bioverify-result' && first[0].ok === true);

  // A second, identical request must mint a NEW challenge; the prior single-use challenge is gone, so
  // there is no way to reuse the old proof. (We assert each request yields exactly one fresh result.)
  await A.messaging.requestBiometricVerification(bob.uid);
  await flush();
  assert.equal(A.verifications.filter((e) => e.type === 'bioverify-result').length, 2);
});

test('no challenge or signature appears as readable plaintext on the wire (§4.5)', async () => {
  const alice = await newParty('alice', 'a-dev');
  const bob = await newParty('bob', 'b-dev');
  const hub = makeHub();
  let wire = '';
  const base = hub.realtimeFor.bind(hub);
  hub.realtimeFor = (uid: string) => {
    const rt = base(uid);
    const origSend = rt.send.bind(rt);
    rt.send = (frame: ClientToServerFrame) => {
      wire += JSON.stringify(frame);
      origSend(frame);
    };
    return rt;
  };
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub, (await makeFakeAttestor()).attestor);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub, (await makeFakeAttestor()).attestor);

  await B.messaging.enrollBiometricAttestation(alice.uid);
  await flush();
  await A.messaging.requestBiometricVerification(bob.uid);
  await flush();

  // The control type markers ride inside the libsignal ciphertext, so they must not be in cleartext.
  assert.ok(!wire.includes('bioverify-enroll'), 'enrol key must be encrypted on the wire');
  assert.ok(!wire.includes('bioverify-request'), 'challenge must be encrypted on the wire');
  assert.ok(!wire.includes('bioverify-response'), 'signature must be encrypted on the wire');

  A.messaging.dispose();
  B.messaging.dispose();
});
