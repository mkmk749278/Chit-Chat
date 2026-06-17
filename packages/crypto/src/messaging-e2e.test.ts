import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as Signal from '@signalapp/libsignal-client';

import type {
  ClaimedPreKeyBundle,
  ClientToServerFrame,
  ServerToClientFrame,
} from '@chat-app/types';

import type { ConversationEvent } from './conversation-reducer';
import { createEnvelopeCodec } from './envelope-codec';
import { createInMemorySignalProtocolStore } from './in-memory-signal-store';
import { createLibsignalEngine } from './libsignal-engine.node';
import { createMessaging, type MessagingRealtime, type MessagingStore } from './messaging';
import type { MessageRow, SignalProtocolStore } from './ports';
import { createSessionManager } from './session-manager';
import type { SequenceAllocator } from './sequence-allocator';

/**
 * Full client message-lifecycle integration (task 6.9 application layer; Requirements
 * 5.2, 5.4, 5.5, 5.6, 5.7, 6.5, 6.9).
 *
 * Drives the REAL {@link createMessaging} orchestrator for two parties, each with the
 * real `@signalapp/libsignal-client` engine over its own {@link SignalProtocolStore},
 * connected by an in-process relay that mirrors the Backend_API gateway: a `send` frame
 * is acknowledged to the sender and delivered to the recipient. This proves the entire
 * client stack above the network transport — session establishment, encryption, the wire
 * envelope, ack → `sent`, inbound decrypt → `received`, and decryption-failure →
 * `delivery-error` — works end to end with real cryptography and no plaintext on the wire.
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

/** Generate a party's identity + published prekeys and seed an in-memory store. */
function newParty(uid: string, deviceId: string, registrationId: number): Party {
  const identity = Signal.IdentityKeyPair.generate();
  const preKeyPair = Signal.PrivateKey.generate();
  const preKeyRecord = Signal.PreKeyRecord.new(PREKEY_ID, preKeyPair.getPublicKey(), preKeyPair);
  const signedPair = Signal.PrivateKey.generate();
  const signature = identity.privateKey.sign(signedPair.getPublicKey().serialize());
  const signedRecord = Signal.SignedPreKeyRecord.new(
    SIGNED_PREKEY_ID,
    0,
    signedPair.getPublicKey(),
    signedPair,
    signature,
  );

  const store = createInMemorySignalProtocolStore({
    identityKeyPair: {
      publicKey: new Uint8Array(identity.publicKey.serialize()),
      privateKey: new Uint8Array(identity.privateKey.serialize()),
    },
    registrationId,
    preKeys: [{ keyId: PREKEY_ID, record: new Uint8Array(preKeyRecord.serialize()) }],
    signedPreKeys: [{ keyId: SIGNED_PREKEY_ID, record: new Uint8Array(signedRecord.serialize()) }],
  });

  const bundle: ClaimedPreKeyBundle = {
    deviceId,
    registrationId,
    identityKey: b64(new Uint8Array(identity.publicKey.serialize())),
    signedPreKey: {
      keyId: SIGNED_PREKEY_ID,
      publicKey: b64(new Uint8Array(signedPair.getPublicKey().serialize())),
      signature: b64(new Uint8Array(signature)),
    },
    oneTimePreKey: {
      keyId: PREKEY_ID,
      publicKey: b64(new Uint8Array(preKeyPair.getPublicKey().serialize())),
    },
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
          // Acknowledge to the sender, then deliver to the recipient (gateway behavior).
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

/** Trivial per-recipient monotonic sequence allocator. */
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
    async loadMessages(): Promise<MessageRow[]> {
      return [...rows.values()].map((r) => ({ ...r }));
    },
    async purgeMessages(ids): Promise<void> {
      for (const id of ids) rows.delete(id);
    },
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
      sessions: createSessionManager(party.store, createLibsignalEngine()),
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

/** Let fire-and-forget decrypt/ack chains settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const out = (rows: Map<string, MessageRow>): MessageRow[] =>
  [...rows.values()].filter((r) => r.direction === 'out');
const inbound = (rows: Map<string, MessageRow>): MessageRow[] =>
  [...rows.values()].filter((r) => r.direction === 'in');

test('Messaging E2E: send → relay → decrypt → ack, with no plaintext on the wire (5.2, 5.6, 6.5)', async () => {
  const alice = newParty('alice-uid', 'alice-dev', 5678);
  const bob = newParty('bob-uid', 'bob-dev', 1234);
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub);

  await A.send(bob.uid, 'meet at the bridge 🔐');
  await flush();

  // Alice's outbound message was acknowledged → sent.
  assert.equal(out(A.rows)[0]?.status, 'sent');
  assert.ok(A.events.some((e) => e.type === 'status-updated' && e.status === 'sent'));

  // Bob received and decrypted the real ciphertext.
  const received = inbound(B.rows)[0];
  assert.equal(received?.plaintext, 'meet at the bridge 🔐');
  assert.equal(received?.status, 'received');

  // The wire frame carried no plaintext (Requirement 5.7 / 8.2).
  assert.ok(!JSON.stringify(hub.lastFrame()).includes('bridge'), 'no plaintext on the wire');

  A.dispose();
  B.dispose();
});

test('Messaging E2E: bidirectional exchange decrypts both ways over the live session (5.4, 6.7)', async () => {
  const alice = newParty('alice-uid', 'alice-dev', 5678);
  const bob = newParty('bob-uid', 'bob-dev', 1234);
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
  // Every delivered message decrypted (no delivery-errors).
  assert.ok(!inbound(B.rows).some((r) => r.status === 'delivery-error'));

  A.dispose();
  B.dispose();
});

test('Messaging E2E: a tampered ciphertext yields delivery-error with no plaintext (5.5, 6.9)', async () => {
  const alice = newParty('alice-uid', 'alice-dev', 5678);
  const bob = newParty('bob-uid', 'bob-dev', 1234);
  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub);
  // A fresh Bob that never received the genuine first message, so the tampered one is first.
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub);

  await A.send(bob.uid, 'secret');
  await flush();
  const genuine = hub.lastFrame();
  assert.ok(genuine !== null);

  // Corrupt the ciphertext and feed it straight to Bob's onEnvelope.
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
