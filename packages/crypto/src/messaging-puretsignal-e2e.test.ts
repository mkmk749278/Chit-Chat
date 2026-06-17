import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ClaimedPreKeyBundle,
  ClientToServerFrame,
  ServerToClientFrame,
} from '@chat-app/types';

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
 * Parity proof for the SHIPPABLE pure-TS engine (task: runtime-binding execution).
 *
 * This is the `@privacyresearch/libsignal-protocol-typescript` twin of
 * `messaging-e2e.test.ts` (which uses the Node-only `@signalapp` engine). It drives the
 * REAL {@link createMessaging} orchestrator + {@link createSessionManager} for two parties
 * over the same in-process relay, but with {@link createPureTsLibsignalEngine} and
 * {@link createPureTsLibsignalKeyGen} — the exact engine the web and mobile clients ship.
 *
 * It proves the production engine works end to end through our orchestrator: session
 * establishment, encryption, the wire envelope, ack → `sent`, inbound decrypt → `received`,
 * bidirectional ratcheting, and decryption-failure → `delivery-error` with no plaintext on
 * the wire — all with real (non-native) cryptography that runs in the browser and Hermes.
 */

const PREKEY_ID = 31337;
const SIGNED_PREKEY_ID = 22;

interface Party {
  uid: string;
  deviceId: string;
  store: SignalProtocolStore;
  bundle: ClaimedPreKeyBundle;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const keyGen = createPureTsLibsignalKeyGen();

/** Generate a party's identity + published prekeys with the pure-TS keygen and seed a store. */
async function newParty(uid: string, deviceId: string): Promise<Party> {
  const identity = await keyGen.generateIdentityKeyPair();
  const registrationId = await keyGen.generateRegistrationId();
  const signedPair = await keyGen.generatePreKeyPair();
  const signature = await keyGen.signWithIdentity(identity.privateKey, signedPair.publicKey);
  const oneTimePair = await keyGen.generatePreKeyPair();

  const store = createInMemorySignalProtocolStore({
    identityKeyPair: { publicKey: identity.publicKey, privateKey: identity.privateKey },
    registrationId,
    // The device's own prekeys are stored in the engine's keypair-blob format so its
    // store bridge can load them back as key pairs when decrypting a prekey message.
    preKeys: [{ keyId: PREKEY_ID, record: encodePreKeyRecord(oneTimePair.publicKey, oneTimePair.privateKey) }],
    signedPreKeys: [
      { keyId: SIGNED_PREKEY_ID, record: encodePreKeyRecord(signedPair.publicKey, signedPair.privateKey) },
    ],
  });

  const bundle: ClaimedPreKeyBundle = {
    deviceId,
    registrationId,
    identityKey: b64(identity.publicKey),
    signedPreKey: {
      keyId: SIGNED_PREKEY_ID,
      publicKey: b64(signedPair.publicKey),
      signature: b64(signature),
    },
    oneTimePreKey: { keyId: PREKEY_ID, publicKey: b64(oneTimePair.publicKey) },
  };

  return { uid, deviceId, store, bundle };
}

/** In-process relay mirroring the gateway: ack to sender + deliver to recipient. */
function makeHub(): {
  realtimeFor: (uid: string) => MessagingRealtime;
  lastFrame: () => ClientToServerFrame | null;
} {
  const deliverers = new Map<string, (frame: ServerToClientFrame) => void>();
  let lastFrame: ClientToServerFrame | null = null;

  return {
    lastFrame: () => lastFrame,
    realtimeFor(uid: string): MessagingRealtime {
      const frameListeners = new Set<(frame: ServerToClientFrame) => void>();
      deliverers.set(uid, (frame) => {
        for (const listener of frameListeners) {
          listener(frame);
        }
      });
      return {
        send(frame: ClientToServerFrame): void {
          lastFrame = frame;
          const env = frame.envelope;
          deliverers.get(env.senderUid)?.({
            kind: 'ack',
            recipientUid: env.recipientUid,
            seq: env.seq,
            status: 'received',
          });
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

function makeSequence(): SequenceAllocator {
  const counters = new Map<string, number>();
  return {
    async next(recipientUid: string): Promise<number> {
      const n = (counters.get(recipientUid) ?? 0) + 1;
      counters.set(recipientUid, n);
      return n;
    },
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
    async applyReaction(remoteUid, direction, seq, emoji): Promise<void> {
      for (const r of rows.values()) {
        if (r.remoteUid === remoteUid && r.direction === direction && r.seq === seq && r.deleted !== true) {
          const reactions = r.reactions ?? [];
          if (!reactions.includes(emoji)) r.reactions = [...reactions, emoji];
        }
      }
    },
    async applyEdit(remoteUid, direction, seq, body): Promise<void> {
      for (const r of rows.values()) {
        if (r.remoteUid === remoteUid && r.direction === direction && r.seq === seq && r.deleted !== true) {
          r.plaintext = body;
          r.edited = true;
        }
      }
    },
    async applyDelete(remoteUid, direction, seq): Promise<void> {
      for (const r of rows.values()) {
        if (r.remoteUid === remoteUid && r.direction === direction && r.seq === seq) {
          r.plaintext = null;
          r.deleted = true;
          r.edited = false;
          delete r.reactions;
        }
      }
    },
    async setConversationTimer(): Promise<void> {},
  };
}

interface Client {
  send: (uid: string, text: string) => Promise<void>;
  onEnvelope: (envelope: ClientToServerFrame['envelope']) => Promise<void>;
  rows: Map<string, MessageRow>;
  events: ConversationEvent[];
  dispose: () => void;
}

function makeClient(
  party: Party,
  peerBundles: Record<string, ClaimedPreKeyBundle>,
  hub: ReturnType<typeof makeHub>,
): Client {
  const store = makeStore();
  const events: ConversationEvent[] = [];
  let counter = 0;
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
    { generateId: () => `${party.uid}-${(counter += 1)}` },
  );
  messaging.onConversationUpdate((event) => events.push(event));
  return {
    send: (uid, text) => messaging.send(uid, text),
    onEnvelope: (envelope) => messaging.onEnvelope(envelope),
    rows: store.rows,
    events,
    dispose: () => messaging.dispose(),
  };
}

/**
 * Let the orchestrator's fire-and-forget decrypt/ack chains settle. The pure-TS engine's
 * decrypt is a sequence of async WebCrypto `subtle` operations (each a threadpool
 * round-trip), so this yields many real macrotask turns — far more than the near-synchronous
 * native engine needs — to deterministically drain the chain.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const out = (rows: Map<string, MessageRow>): MessageRow[] =>
  [...rows.values()].filter((r) => r.direction === 'out');
const inbound = (rows: Map<string, MessageRow>): MessageRow[] =>
  [...rows.values()].filter((r) => r.direction === 'in');

test('pure-TS engine E2E: send → relay → decrypt → ack, no plaintext on the wire', async () => {
  const alice = await newParty('alice-uid', 'alice-dev');
  const bob = await newParty('bob-uid', 'bob-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub);

  await A.send(bob.uid, 'meet at the bridge 🔐');
  await flush();

  assert.equal(out(A.rows)[0]?.status, 'sent');
  assert.ok(A.events.some((e) => e.type === 'status-updated' && e.status === 'sent'));

  const received = inbound(B.rows)[0];
  assert.equal(received?.plaintext, 'meet at the bridge 🔐');
  assert.equal(received?.status, 'received');

  assert.ok(!JSON.stringify(hub.lastFrame()).includes('bridge'), 'no plaintext on the wire');

  A.dispose();
  B.dispose();
});

test('pure-TS engine E2E: bidirectional exchange decrypts both ways over the live session', async () => {
  const alice = await newParty('alice-uid', 'alice-dev');
  const bob = await newParty('bob-uid', 'bob-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub);

  await A.send(bob.uid, 'm1');
  await flush();
  await B.send(alice.uid, 'reply-1');
  await flush();
  await A.send(bob.uid, 'm2');
  await flush();

  assert.equal(inbound(A.rows)[0]?.plaintext, 'reply-1');
  assert.deepEqual(
    inbound(B.rows)
      .map((r) => r.plaintext)
      .sort(),
    ['m1', 'm2'],
  );
  assert.ok(!inbound(B.rows).some((r) => r.status === 'delivery-error'));

  A.dispose();
  B.dispose();
});

test('pure-TS engine E2E: a tampered ciphertext yields delivery-error with no plaintext', async () => {
  const alice = await newParty('alice-uid', 'alice-dev');
  const bob = await newParty('bob-uid', 'bob-dev');
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub);

  await A.send(bob.uid, 'secret');
  await flush();
  const genuine = hub.lastFrame();
  assert.ok(genuine !== null);

  const tampered = {
    ...genuine.envelope,
    ciphertext: Buffer.from('not a valid libsignal ciphertext').toString('base64'),
  };
  await B.onEnvelope(tampered);
  await flush();

  const errored = inbound(B.rows).find((r) => r.status === 'delivery-error');
  assert.ok(errored !== undefined, 'a delivery-error row is recorded');
  assert.equal(errored?.plaintext, null, 'no plaintext is rendered on decryption failure');
  assert.ok(B.events.some((e) => e.type === 'inbound-delivery-error'));

  A.dispose();
  B.dispose();
});
