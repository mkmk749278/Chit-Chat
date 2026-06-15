import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CiphertextEnvelope, ClaimedPreKeyBundle } from '@chat-app/types';

import type { ConversationEvent } from './conversation-reducer';
import { createEnvelopeCodec } from './envelope-codec';
import { createInMemorySignalProtocolStore } from './in-memory-signal-store';
import {
  createPureTsLibsignalEngine,
  createPureTsLibsignalKeyGen,
  encodePreKeyRecord,
} from './libsignal-puretsignal';
import { createMessaging, type MessagingRealtime, type MessagingStore } from './messaging';
import type { MessageRow, SignalProtocolStore } from './ports';
import { createSessionManager } from './session-manager';
import type { SequenceAllocator } from './sequence-allocator';

/**
 * Regression test for the Phase 1 "message unavailable / could not be decrypted" bug
 * (CC1). The original failure: a message was encrypted to the recipient's published prekey
 * bundle while they were OFFLINE; by the time the store-and-forward queue delivered it, the
 * recipient's device had regenerated its identity (non-durable storage), so the private
 * prekeys no longer matched and decryption failed.
 *
 * These tests pin the invariant the fix established, end-to-end through the real engine +
 * SessionManager + Messaging.onEnvelope render path:
 *   1. POSITIVE — a recipient that RELAUNCHES with the SAME (persisted) identity decrypts a
 *      message that was encrypted-then-queued before the relaunch. This is what durable
 *      on-device identity guarantees.
 *   2. NEGATIVE — a recipient that comes back with a DIFFERENT identity (the churn the bug
 *      was caused by) cannot decrypt and surfaces a delivery-error with no plaintext. This
 *      proves the symptom reproduces precisely when identity is not durable, so the test
 *      fails loudly if anything reintroduces identity churn.
 */

const PREKEY_ID = 555;
const SIGNED_PREKEY_ID = 7;
const keyGen = createPureTsLibsignalKeyGen();
const engine = createPureTsLibsignalEngine();
const codec = createEnvelopeCodec();
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

/** The raw key material a device persists; rebuilding a store from it simulates a relaunch. */
interface IdentityMaterial {
  identity: { publicKey: Uint8Array; privateKey: Uint8Array };
  registrationId: number;
  signed: { pub: Uint8Array; priv: Uint8Array; sig: Uint8Array };
  oneTime: { pub: Uint8Array; priv: Uint8Array };
}

async function generateIdentity(): Promise<IdentityMaterial> {
  const identity = await keyGen.generateIdentityKeyPair();
  let registrationId = await keyGen.generateRegistrationId();
  while (registrationId < 1) {
    registrationId = await keyGen.generateRegistrationId();
  }
  const signedPair = await keyGen.generatePreKeyPair();
  const sig = await keyGen.signWithIdentity(identity.privateKey, signedPair.publicKey);
  const oneTimePair = await keyGen.generatePreKeyPair();
  return {
    identity,
    registrationId,
    signed: { pub: signedPair.publicKey, priv: signedPair.privateKey, sig },
    oneTime: { pub: oneTimePair.publicKey, priv: oneTimePair.privateKey },
  };
}

/** Build a fresh SignalProtocolStore from material — a "launch" that reloads the same identity. */
function storeFrom(m: IdentityMaterial): SignalProtocolStore {
  return createInMemorySignalProtocolStore({
    identityKeyPair: { publicKey: m.identity.publicKey, privateKey: m.identity.privateKey },
    registrationId: m.registrationId,
    preKeys: [{ keyId: PREKEY_ID, record: encodePreKeyRecord(m.oneTime.pub, m.oneTime.priv) }],
    signedPreKeys: [{ keyId: SIGNED_PREKEY_ID, record: encodePreKeyRecord(m.signed.pub, m.signed.priv) }],
  });
}

/** The recipient's PUBLIC bundle as the prekey-claim endpoint would serve it. */
function bundleFrom(m: IdentityMaterial, deviceId: string): ClaimedPreKeyBundle {
  return {
    deviceId,
    registrationId: m.registrationId,
    identityKey: b64(m.identity.publicKey),
    signedPreKey: { keyId: SIGNED_PREKEY_ID, publicKey: b64(m.signed.pub), signature: b64(m.signed.sig) },
    oneTimePreKey: { keyId: PREKEY_ID, publicKey: b64(m.oneTime.pub) },
  };
}

function makeStore(): MessagingStore & { rows: Map<string, MessageRow> } {
  const rows = new Map<string, MessageRow>();
  return {
    rows,
    async appendMessage(row: MessageRow): Promise<void> {
      rows.set(row.id, { ...row });
    },
    async updateMessageStatus(id: string, status): Promise<void> {
      const row = rows.get(id);
      if (row !== undefined) {
        row.status = status;
      }
    },
  };
}

/** A transport stub: the recipient only receives here, so send/status are inert. */
const inertRealtime: MessagingRealtime = {
  send(): void {
    /* recipient does not send in this test */
  },
  getStatus: () => 'connected',
  onFrame(): () => void {
    return () => undefined;
  },
  onStatus(): () => void {
    return () => undefined;
  },
};

const makeSequence = (): SequenceAllocator => ({ next: async () => 1 });

/** Drain the orchestrator's fire-and-forget decrypt chain (many real WebCrypto turns). */
async function flush(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const SENDER_UID = 'sender-uid';
const SENDER_DEVICE = 'sender-dev';
const RECIPIENT_UID = 'recipient-uid';

/** Sender encrypts "text" to the recipient's bundle and returns the wire envelope (queued offline). */
async function senderEnvelope(text: string, bundle: ClaimedPreKeyBundle): Promise<CiphertextEnvelope> {
  const senderStore = storeFrom(await generateIdentity());
  const senderSessions = createSessionManager(senderStore, engine);
  await senderSessions.establishSession(RECIPIENT_UID, bundle);
  const body = await senderSessions.encrypt(RECIPIENT_UID, text);
  return codec.encode(
    { senderUid: SENDER_UID, recipientUid: RECIPIENT_UID, senderDeviceId: SENDER_DEVICE, seq: 1 },
    body,
  );
}

/** Receive `envelope` on a recipient store and report the rendered row + events. */
async function receiveOn(
  store: SignalProtocolStore,
  envelope: CiphertextEnvelope,
): Promise<{ rows: MessageRow[]; events: ConversationEvent[] }> {
  const store_ = makeStore();
  const events: ConversationEvent[] = [];
  let n = 0;
  const messaging = createMessaging(
    {
      realtime: inertRealtime,
      sessions: createSessionManager(store, engine),
      sequence: makeSequence(),
      codec,
      keyClaimer: { claim: async () => null },
      sender: { resolveSender: async () => ({ uid: RECIPIENT_UID, deviceId: 'r-dev' }) },
      store: store_,
    },
    { generateId: () => `r-${(n += 1)}` },
  );
  messaging.onConversationUpdate((e) => events.push(e));
  await messaging.onEnvelope(envelope);
  await flush();
  messaging.dispose();
  return { rows: [...store_.rows.values()], events };
}

test('relaunch with the SAME persisted identity decrypts a message queued while offline', async () => {
  const recipient = await generateIdentity();
  const bundle = bundleFrom(recipient, 'recipient-dev');

  // Sender encrypts "Hello" to the published bundle; recipient is offline, so it is queued.
  const envelope = await senderEnvelope('Hello', bundle);

  // RELAUNCH: the recipient comes back up with the SAME identity (durable storage) and the
  // store-and-forward queue now delivers the envelope.
  const relaunchedStore = storeFrom(recipient);
  const { rows } = await receiveOn(relaunchedStore, envelope);

  const inbound = rows.find((r) => r.direction === 'in');
  assert.equal(inbound?.plaintext, 'Hello');
  assert.equal(inbound?.status, 'received');
});

test('relaunch with a DIFFERENT identity (churn) cannot decrypt -> delivery-error (the Phase 1 bug)', async () => {
  const recipient = await generateIdentity();
  const bundle = bundleFrom(recipient, 'recipient-dev');
  const envelope = await senderEnvelope('Hello', bundle);

  // The recipient comes back with a DIFFERENT identity (the churn that caused the bug): the
  // private prekeys no longer match what the sender encrypted to.
  const churnedStore = storeFrom(await generateIdentity());
  const { rows, events } = await receiveOn(churnedStore, envelope);

  const inbound = rows.find((r) => r.direction === 'in');
  assert.equal(inbound?.plaintext, null, 'no plaintext is rendered on decryption failure');
  assert.equal(inbound?.status, 'delivery-error');
  assert.ok(events.some((e) => e.type === 'inbound-delivery-error'));
});
