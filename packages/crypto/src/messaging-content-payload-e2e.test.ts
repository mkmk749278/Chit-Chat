import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ClaimedPreKeyBundle, ClientToServerFrame, ServerToClientFrame } from '@chat-app/types';

import type { ConversationEvent } from './conversation-reducer';
import { createEnvelopeCodec } from './envelope-codec';
import { createInMemorySignalProtocolStore } from './in-memory-signal-store';
import {
  createPureTsLibsignalEngine,
  createPureTsLibsignalKeyGen,
  encodePreKeyRecord,
} from './libsignal-puretsignal';
import { createMessaging, type Messaging, type MessagingRealtime, type MessagingStore } from './messaging';
import type { MessageRow, SignalProtocolStore } from './ports';
import { createSessionManager } from './session-manager';
import type { SequenceAllocator } from './sequence-allocator';

/**
 * End-to-end test that the content payload (Phase 2, Req 3) flows through the real Messaging
 * orchestrator: text still round-trips, and reactions / edits / deletes propagate to the peer
 * and apply against the correct message (with the sender-relative -> local direction flip).
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

function makeHub(): { realtimeFor: (uid: string) => MessagingRealtime } {
  const deliverers = new Map<string, (frame: ServerToClientFrame) => void>();
  return {
    realtimeFor(uid: string): MessagingRealtime {
      const frameListeners = new Set<(frame: ServerToClientFrame) => void>();
      deliverers.set(uid, (frame) => frameListeners.forEach((l) => l(frame)));
      return {
        send(frame: ClientToServerFrame): void {
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

function makeStore(): MessagingStore & { rows: Map<string, MessageRow> } {
  const rows = new Map<string, MessageRow>();
  return {
    rows,
    async appendMessage(row) {
      rows.set(row.id, { ...row });
    },
    async updateMessageStatus(id, status) {
      const r = rows.get(id);
      if (r !== undefined) {
        r.status = status;
      }
    },
  };
}

interface Client {
  messaging: Messaging;
  rows: Map<string, MessageRow>;
  events: ConversationEvent[];
}

function makeClient(party: Party, peerBundles: Record<string, ClaimedPreKeyBundle>, hub: ReturnType<typeof makeHub>): Client {
  const store = makeStore();
  const events: ConversationEvent[] = [];
  let n = 0;
  const messaging = createMessaging(
    {
      realtime: hub.realtimeFor(party.uid),
      sessions: createSessionManager(party.store, createPureTsLibsignalEngine()),
      sequence: makeSequence(),
      codec: createEnvelopeCodec(),
      keyClaimer: { claim: async (uid: string) => peerBundles[uid] ?? null },
      sender: { resolveSender: async () => ({ uid: party.uid, deviceId: party.deviceId }) },
      store,
    },
    { generateId: () => `${party.uid}-${(n += 1)}` },
  );
  messaging.onConversationUpdate((e) => events.push(e));
  return { messaging, rows: store.rows, events };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const inbound = (rows: Map<string, MessageRow>): MessageRow[] =>
  [...rows.values()].filter((r) => r.direction === 'in');

test('text still round-trips through the content payload', async () => {
  const alice = await newParty('alice', 'a-dev');
  const bob = await newParty('bob', 'b-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub);

  await A.messaging.send(bob.uid, 'hello there');
  await flush();

  assert.equal(inbound(B.rows)[0]?.plaintext, 'hello there');
  assert.equal(inbound(B.rows)[0]?.status, 'received');
  A.messaging.dispose();
  B.messaging.dispose();
});

test('a reaction propagates and targets the peer outbound message (direction flip)', async () => {
  const alice = await newParty('alice', 'a-dev');
  const bob = await newParty('bob', 'b-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub);

  await A.messaging.send(bob.uid, 'hi'); // A out:1, B in:1
  await flush();
  // Bob reacts to Alice's message, which on Bob's device is inbound seq 1.
  await B.messaging.react(alice.uid, { direction: 'in', seq: 1 }, '👍');
  await flush();

  // On Alice's device the reaction must target her OUTBOUND seq 1.
  const onAlice = A.events.find((e) => e.type === 'reaction-applied');
  assert.ok(onAlice && onAlice.type === 'reaction-applied');
  assert.equal(onAlice.targetDirection, 'out');
  assert.equal(onAlice.targetSeq, 1);
  assert.equal(onAlice.emoji, '👍');
  A.messaging.dispose();
  B.messaging.dispose();
});

test('an edit propagates and supersedes the peer message text', async () => {
  const alice = await newParty('alice', 'a-dev');
  const bob = await newParty('bob', 'b-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub);

  await A.messaging.send(bob.uid, 'helo'); // A out:1 -> B in:1
  await flush();
  await A.messaging.editMessage(bob.uid, { direction: 'out', seq: 1 }, 'hello');
  await flush();

  const onBob = B.events.find((e) => e.type === 'message-edited');
  assert.ok(onBob && onBob.type === 'message-edited');
  assert.equal(onBob.targetDirection, 'in'); // Alice's outbound is inbound on Bob
  assert.equal(onBob.targetSeq, 1);
  assert.equal(onBob.body, 'hello');
  A.messaging.dispose();
  B.messaging.dispose();
});

test('a delete propagates as a tombstone for the peer message', async () => {
  const alice = await newParty('alice', 'a-dev');
  const bob = await newParty('bob', 'b-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub);

  await A.messaging.send(bob.uid, 'oops'); // A out:1 -> B in:1
  await flush();
  await A.messaging.deleteMessage(bob.uid, { direction: 'out', seq: 1 });
  await flush();

  const onBob = B.events.find((e) => e.type === 'message-deleted');
  assert.ok(onBob && onBob.type === 'message-deleted');
  assert.equal(onBob.targetDirection, 'in');
  assert.equal(onBob.targetSeq, 1);
  A.messaging.dispose();
  B.messaging.dispose();
});

test('no plaintext appears on the wire for a text message', async () => {
  const alice = await newParty('alice', 'a-dev');
  const bob = await newParty('bob', 'b-dev');
  const hub = makeHub();
  // Capture the frame the sender transmits by wrapping the recipient delivery.
  let lastWire = '';
  const baseRealtimeFor = hub.realtimeFor.bind(hub);
  hub.realtimeFor = (uid: string) => {
    const rt = baseRealtimeFor(uid);
    const origSend = rt.send.bind(rt);
    rt.send = (frame: ClientToServerFrame) => {
      lastWire += JSON.stringify(frame);
      origSend(frame);
    };
    return rt;
  };
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub);

  await A.messaging.send(bob.uid, 'topsecret');
  await flush();
  assert.ok(!lastWire.includes('topsecret'), 'plaintext must never appear on the wire');
  A.messaging.dispose();
  B.messaging.dispose();
});
