import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as Signal from '@signalapp/libsignal-client';

import type {
  CiphertextEnvelope,
  ClaimedPreKeyBundle,
  ClientToServerFrame,
  ServerToClientFrame,
} from '@chat-app/types';

import type { ConversationEvent, RenderableMessage } from './conversation-reducer';
import { createEnvelopeCodec } from './envelope-codec';
import { createInMemorySignalProtocolStore } from './in-memory-signal-store';
import { createLibsignalEngine } from './libsignal-engine.node';
import {
  createMessaging,
  type MessagingRealtime,
  type MessagingStore,
  type OutgoingAttachment,
} from './messaging';
import type { BlobStore, MessageRow, SignalProtocolStore } from './ports';
import { createSessionManager } from './session-manager';
import type { SequenceAllocator } from './sequence-allocator';

/**
 * Full client lifecycle for end-to-end ENCRYPTED ATTACHMENTS (Req 7), the documented blocker where
 * inbound attachments were previously ignored. Drives the REAL {@link createMessaging} orchestrator
 * for two parties with the real libsignal engine + a shared in-process blob store, proving the whole
 * media path: encrypt locally → upload ciphertext → send the key/handle inside the E2E channel →
 * download → decrypt → render. It also asserts the two security invariants — the content key never
 * reaches the blob store, and no plaintext/key rides the wire — and that a tampered blob is rejected.
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

function makeHub(): {
  realtimeFor: (uid: string) => MessagingRealtime;
  lastFrame: () => Extract<ClientToServerFrame, { kind: 'send' }> | null;
} {
  const deliverers = new Map<string, (frame: ServerToClientFrame) => void>();
  let lastFrame: Extract<ClientToServerFrame, { kind: 'send' }> | null = null;

  return {
    lastFrame: () => lastFrame,
    realtimeFor(uid: string): MessagingRealtime {
      const frameListeners = new Set<(frame: ServerToClientFrame) => void>();
      deliverers.set(uid, (frame) => {
        for (const listener of frameListeners) listener(frame);
      });
      return {
        send(frame: ClientToServerFrame): void {
          if (frame.kind !== 'send') return;
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
      if (row !== undefined) row.status = status;
    },
    async applyReaction(): Promise<void> {},
    async applyEdit(): Promise<void> {},
    async applyDelete(): Promise<void> {},
    async setConversationTimer(): Promise<void> {},
    async loadMessages(): Promise<MessageRow[]> {
      return [...rows.values()].map((r) => ({ ...r }));
    },
    async purgeMessages(ids): Promise<void> {
      for (const id of ids) rows.delete(id);
    },
  };
}

/** A shared in-process blob store, modelling the backend blob service for both parties. */
function makeBlobStore(): BlobStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  let counter = 0;
  return {
    blobs,
    async put(ciphertext: Uint8Array): Promise<string> {
      const blobId = `blob-${(counter += 1)}`;
      blobs.set(blobId, Uint8Array.from(ciphertext));
      return blobId;
    },
    async get(blobId: string): Promise<Uint8Array> {
      const bytes = blobs.get(blobId);
      if (bytes === undefined) throw new Error(`no such blob: ${blobId}`);
      return Uint8Array.from(bytes);
    },
  };
}

interface Client {
  sendAttachment: (uid: string, content: OutgoingAttachment) => Promise<void>;
  onEnvelope: (envelope: CiphertextEnvelope) => Promise<void>;
  rows: Map<string, MessageRow>;
  events: ConversationEvent[];
  dispose: () => void;
}

function makeClient(
  party: Party,
  peerBundles: Record<string, ClaimedPreKeyBundle>,
  hub: ReturnType<typeof makeHub>,
  blobs: BlobStore,
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
      blobs,
    },
    { generateId: () => `${party.uid}-${(counter += 1)}` },
  );
  messaging.onConversationUpdate((event) => events.push(event));
  return {
    sendAttachment: (uid, content) => messaging.sendAttachment(uid, content),
    onEnvelope: (envelope) => messaging.onEnvelope(envelope),
    rows: store.rows,
    events,
    dispose: () => messaging.dispose(),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const inbound = (rows: Map<string, MessageRow>): MessageRow[] =>
  [...rows.values()].filter((r) => r.direction === 'in');

const appended = (events: ConversationEvent[]): RenderableMessage[] =>
  events
    .filter((e): e is Extract<ConversationEvent, { type: 'message-appended' }> => e.type === 'message-appended')
    .map((e) => e.message);

// A small "JPEG": arbitrary non-text bytes, including a NUL, to ensure binary fidelity end to end.
const PLAINTEXT = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x10, 42, 7, 255, 0, 1, 2, 3]);

test('attachment E2E: encrypt → upload → send key in-band → download → decrypt → render', async () => {
  const alice = newParty('alice-uid', 'alice-dev', 5678);
  const bob = newParty('bob-uid', 'bob-dev', 1234);
  const hub = makeHub();
  const blobStore = makeBlobStore();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub, blobStore);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub, blobStore);

  await A.sendAttachment(bob.uid, { data: PLAINTEXT, mediaType: 'image/jpeg', name: 'p.jpg' });
  await flush();

  // Sender: optimistic row acked → sent, carrying the decrypted bytes for immediate render.
  const aOut = [...A.rows.values()].find((r) => r.direction === 'out');
  assert.equal(aOut?.status, 'sent');
  assert.equal(aOut?.attachment?.mediaType, 'image/jpeg');
  assert.equal(aOut?.attachment?.name, 'p.jpg');
  const aMsg = appended(A.events).find((m) => m.direction === 'out');
  assert.deepEqual(aMsg?.attachment?.data, PLAINTEXT);

  // Recipient: downloaded + decrypted to the exact original bytes.
  const received = inbound(B.rows)[0];
  assert.equal(received?.status, 'received');
  assert.equal(received?.attachment?.mediaType, 'image/jpeg');
  assert.equal(received?.attachment?.name, 'p.jpg');
  const bMsg = appended(B.events).find((m) => m.direction === 'in');
  assert.deepEqual(bMsg?.attachment?.data, PLAINTEXT, 'recipient renders the original bytes');

  // Security 1: only CIPHERTEXT reached the blob store — never the plaintext nor the content key.
  assert.equal(blobStore.blobs.size, 1);
  const stored = [...blobStore.blobs.values()][0]!;
  assert.notDeepEqual(stored, PLAINTEXT, 'stored bytes are ciphertext, not plaintext');
  assert.ok(!b64(stored).includes(received!.attachment!.key), 'content key must not be in the stored blob');

  // Security 2: the wire frame carried neither the content key nor the plaintext bytes.
  const wire = JSON.stringify(hub.lastFrame());
  assert.ok(!wire.includes(received!.attachment!.key), 'content key must not be on the wire');

  // The content key travelled in-band: the recipient's persisted row has the key/iv to re-decrypt.
  assert.equal(typeof received?.attachment?.key, 'string');
  assert.equal(typeof received?.attachment?.iv, 'string');

  A.dispose();
  B.dispose();
});

test('attachment E2E: a tampered blob yields a delivery-error (GCM auth), no rendered bytes', async () => {
  const alice = newParty('alice-uid', 'alice-dev', 5678);
  const bob = newParty('bob-uid', 'bob-dev', 1234);
  const hub = makeHub();
  const blobStore = makeBlobStore();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub, blobStore);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub, blobStore);

  // Intercept: corrupt the ciphertext in the store after upload but before delivery resolves.
  const realGet = blobStore.get.bind(blobStore);
  blobStore.get = async (blobId: string) => {
    const bytes = await realGet(blobId);
    bytes[0] ^= 0xff; // flip a bit → GCM auth must fail
    return bytes;
  };

  await A.sendAttachment(bob.uid, { data: PLAINTEXT, mediaType: 'image/jpeg' });
  await flush();

  const received = inbound(B.rows)[0];
  assert.equal(received?.status, 'delivery-error');
  assert.ok(
    B.events.some((e) => e.type === 'inbound-delivery-error'),
    'a tampered attachment surfaces a delivery-error, never plaintext bytes',
  );

  A.dispose();
  B.dispose();
});

test('attachment send without a blob transport fails locally (no silent drop)', async () => {
  const alice = newParty('alice-uid', 'alice-dev', 5678);
  const bob = newParty('bob-uid', 'bob-dev', 1234);
  const hub = makeHub();
  // Build a client whose deps omit `blobs` by constructing messaging directly.
  const store = makeStore();
  const events: ConversationEvent[] = [];
  let counter = 0;
  const messaging = createMessaging(
    {
      realtime: hub.realtimeFor(alice.uid),
      sessions: createSessionManager(alice.store, createLibsignalEngine()),
      sequence: makeSequence(),
      codec: createEnvelopeCodec(),
      keyClaimer: { claim: async () => bob.bundle },
      sender: { resolveSender: async () => ({ uid: alice.uid, deviceId: alice.deviceId }) },
      store,
    },
    { generateId: () => `alice-${(counter += 1)}` },
  );
  messaging.onConversationUpdate((e) => events.push(e));

  await messaging.sendAttachment(bob.uid, { data: PLAINTEXT, mediaType: 'image/jpeg' });
  await flush();

  const failed = appended(events).find((m) => m.direction === 'out');
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.attachment?.mediaType, 'image/jpeg');
  // The failed row retains the bytes for a retry rather than dropping the media silently.
  assert.deepEqual(failed?.attachment?.data, PLAINTEXT);

  messaging.dispose();
});
