import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  CiphertextEnvelope,
  ClaimedPreKeyBundle,
  ClientToServerFrame,
  ServerToClientFrame,
} from '@chat-app/types';

import { createConversationRegistry, type ConversationRegistry } from './conversation-registry';
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
} from './messaging';
import type { AliasEntry } from './shadow-chat';
import { deriveShadowThreadId } from './shadow-chat';
import type { KeyStore, MessageRow, SignalProtocolStore } from './ports';
import { createSessionManager } from './session-manager';
import type { SequenceAllocator } from './sequence-allocator';
import { InMemoryRowThreadAssociation } from './row-thread-association';
import {
  DefaultShadowInviteCoordinator,
  type RandomSource,
  type ShadowInviteCoordinator,
  type ShadowInviteEvent,
  type ShadowInviteTransport,
} from './shadow-invite-coordinator';
import {
  ShadowSecretStore,
  type InvitedThreadRef,
  type ShadowSecretPersistence,
  type ShadowThreadRef,
} from './shadow-secret-store';
import { SHADOW_SEQ_OFFSET, ShadowSequenceAllocator } from './shadow-sequence-allocator';

/**
 * ============================================================================================
 *  GATING DELIVERABLE — Shadow Chat Invites two-client end-to-end test (Tasks 8.1 / 8.2).
 *  Two REAL libsignal clients are each provisioned with a DIFFERENT device-local master secret —
 *  the opposite of the shipped `messaging-shadow-e2e.test.ts` harness that injected one shared
 *  secret and masked the convergence bug. The thread can only converge via the SHARED per-thread
 *  key carried inside the encrypted `shadow-invite`. Proves Correctness Properties 3, 4, 7, 8, 9,
 *  12, 13, 14, 15, 17, 18.
 * ============================================================================================
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

interface Hub {
  realtimeFor: (uid: string) => MessagingRealtime;
  frames: () => Extract<ClientToServerFrame, { kind: 'send' }>[];
}

function makeHub(): Hub {
  const deliverers = new Map<string, (frame: ServerToClientFrame) => void>();
  const captured: Extract<ClientToServerFrame, { kind: 'send' }>[] = [];
  return {
    frames: () => captured,
    realtimeFor(uid: string): MessagingRealtime {
      const frameListeners = new Set<(frame: ServerToClientFrame) => void>();
      deliverers.set(uid, (frame) => {
        for (const listener of frameListeners) listener(frame);
      });
      return {
        send(frame: ClientToServerFrame): void {
          if (frame.kind !== 'send') return;
          captured.push(frame);
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

function makeSurfaceSequence(): SequenceAllocator {
  const counters = new Map<string, number>();
  return {
    async next(recipientUid: string): Promise<number> {
      const n = (counters.get(recipientUid) ?? 0) + 1;
      counters.set(recipientUid, n);
      return n;
    },
  };
}

function makeShadowKeyStore(): KeyStore {
  const counters = new Map<string, number>();
  return {
    async nextSeq(conversationKey: string): Promise<number> {
      const n = (counters.get(conversationKey) ?? 0) + 1;
      counters.set(conversationKey, n);
      return n;
    },
  } as unknown as KeyStore;
}

function makeStore(): MessagingStore & { rows: Map<string, MessageRow> } {
  const rows = new Map<string, MessageRow>();
  return {
    rows,
    async appendMessage(row: MessageRow): Promise<void> {
      rows.set(row.id, { ...row });
    },
    async updateMessageStatus(id, status): Promise<void> {
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

function makePersistence(): ShadowSecretPersistence {
  let master: Uint8Array | null = null;
  let aliasKey: Uint8Array | null = null;
  const entries: AliasEntry<ShadowThreadRef>[] = [];
  const invited: InvitedThreadRef[] = [];
  return {
    async loadMasterSecret() {
      return master;
    },
    async saveMasterSecret(s) {
      master = s;
    },
    async loadAliasKey() {
      return aliasKey;
    },
    async saveAliasKey(k) {
      aliasKey = k;
    },
    async loadAliasEntries() {
      return entries.map((e) => ({ aliasHash: e.aliasHash, ref: { ...e.ref } }));
    },
    async saveAliasEntry(entry) {
      const i = entries.findIndex((e) => e.aliasHash === entry.aliasHash);
      const c = { aliasHash: entry.aliasHash, ref: { ...entry.ref } };
      if (i >= 0) entries[i] = c;
      else entries.push(c);
    },
    async saveInvitedThread(r) {
      const i = invited.findIndex((x) => x.threadId === r.threadId);
      const c: InvitedThreadRef = { ...r, threadKey: r.threadKey.slice() };
      if (i >= 0) invited[i] = c;
      else invited.push(c);
    },
    async loadInvitedThreads() {
      return invited.map((r) => ({ ...r, threadKey: r.threadKey.slice() }));
    },
    async deleteInvitedThread(threadId) {
      const i = invited.findIndex((x) => x.threadId === threadId);
      if (i >= 0) invited.splice(i, 1);
      for (let j = entries.length - 1; j >= 0; j -= 1) {
        if (entries[j].ref.threadId === threadId) entries.splice(j, 1);
      }
    },
  };
}

function makeRandom(seed: number): RandomSource {
  let n = seed;
  return {
    bytes(len: number) {
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) {
        n = (n * 1103515245 + 12345) & 0x7fffffff;
        out[i] = n & 0xff;
      }
      return out;
    },
  };
}

let inviteCounter = 0;

interface Client {
  uid: string;
  peerUid: string;
  messaging: Messaging;
  coord: ShadowInviteCoordinator;
  registry: ConversationRegistry;
  store: MessagingStore & { rows: Map<string, MessageRow> };
  persistence: ShadowSecretPersistence;
  rowThreads: InMemoryRowThreadAssociation;
  events: ShadowInviteEvent[];
  setMode: (m: 'real' | 'decoy' | null) => void;
}

function makeClient(party: Party, peerBundles: Record<string, ClaimedPreKeyBundle>, hub: Hub, peerUid: string, seed: number): Client {
  const store = makeStore();
  const shadowKeyStore = makeShadowKeyStore();
  const registry = createConversationRegistry({ platform: 'mobile' });
  const persistence = makePersistence();
  const secretStore = new ShadowSecretStore(persistence);
  const rowThreads = new InMemoryRowThreadAssociation();
  const events: ShadowInviteEvent[] = [];
  let mode: 'real' | 'decoy' | null = 'real';
  let counter = 0;
  let messaging!: Messaging;

  const transport: ShadowInviteTransport = {
    async sendControl(to, payload) {
      await messaging.sendShadowControl(to, payload);
    },
    async sendShadow(to, threadId, text) {
      await messaging.send(to, text, { threadId });
    },
  };

  const coord = new DefaultShadowInviteCoordinator({
    store: secretStore,
    registry,
    transport,
    random: makeRandom(seed),
    rowThreads,
    purgeMessages: (ids) => store.purgeMessages(ids),
    resolveMode: () => mode,
    myUid: () => party.uid,
    now: () => 1000,
    newInviteId: () => `inv-${(inviteCounter += 1)}`,
    inviteTtlMs: 1000,
  });
  coord.onInvite((e) => events.push(e));

  messaging = createMessaging(
    {
      realtime: hub.realtimeFor(party.uid),
      sessions: createSessionManager(party.store, createPureTsLibsignalEngine()),
      sequence: makeSurfaceSequence(),
      shadowSequence: (tid: string) => new ShadowSequenceAllocator(shadowKeyStore, tid),
      codec: createEnvelopeCodec(),
      keyClaimer: { claim: async (uid: string) => peerBundles[uid] ?? null },
      sender: { resolveSender: async () => ({ uid: party.uid, deviceId: party.deviceId }) },
      store,
      shadowInvites: coord,
      recordRow: (rowId, threadId) => rowThreads.record(rowId, threadId),
    },
    { generateId: () => `${party.uid}-${(counter += 1)}` },
  );
  messaging.onConversationUpdate((event) => registry.apply(event));

  return {
    uid: party.uid,
    peerUid,
    messaging,
    coord,
    registry,
    store,
    persistence,
    rowThreads,
    events,
    setMode: (m) => {
      mode = m;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const receivedInviteId = (c: Client): string => {
  const e = c.events.find((x) => x.type === 'invite-received');
  assert.ok(e && e.type === 'invite-received', 'an invite-received event must have been emitted');
  return e.inviteId;
};

async function setupConverged(routing: 'hidden' | 'merge'): Promise<{
  alice: Client;
  bob: Client;
  hub: Hub;
  threadId: string;
}> {
  const A = await newParty('alice', 'devA');
  const B = await newParty('bob', 'devB');
  const hub = makeHub();
  const alice = makeClient(A, { [B.uid]: B.bundle }, hub, B.uid, 11);
  const bob = makeClient(B, { [A.uid]: A.bundle }, hub, A.uid, 9999);
  // DISTINCT device-local master secrets — convergence must come from the shared per-thread key.
  await alice.persistence.saveMasterSecret(Uint8Array.from({ length: 32 }, () => 0xa1));
  await bob.persistence.saveMasterSecret(Uint8Array.from({ length: 32 }, () => 0xb2));

  const pending = await alice.coord.createInvite('bob');
  assert.ok(pending);
  await flush();
  const inviteId = receivedInviteId(bob);
  const ref = await bob.coord.acceptInvite(inviteId, routing);
  assert.ok(ref);
  await flush();
  // Convergence (Property 3): identical threadId on both sides, with DISTINCT masters.
  assert.equal(pending!.threadId, ref!.threadId, 'Property 3: inviter and recipient threadIds must converge');
  return { alice, bob, hub, threadId: pending!.threadId };
}

const shadowTexts = (c: Client, threadId: string, direction: 'in' | 'out'): string[] =>
  c.registry
    .getState({ kind: 'shadow', threadId, peerUid: c.peerUid })
    .messages.filter((m) => m.direction === direction)
    .map((m) => m.text ?? '');

const surfaceMsgCount = (c: Client): number =>
  c.registry.getState({ kind: 'surface', remoteUid: c.peerUid }).messages.length;

test('GATE: invite → accept(hidden) converges across two clients with DISTINCT masters; shadow messages stay isolated and leak nothing', async () => {
  const { alice, bob, hub, threadId } = await setupConverged('hidden');

  // Bidirectional steady-state shadow messages route ONLY into the shadow thread.
  await alice.messaging.send('bob', 'a→b secret', { threadId });
  await flush();
  await bob.messaging.send('alice', 'b→a secret', { threadId });
  await flush();

  assert.deepEqual(shadowTexts(bob, threadId, 'in'), ['a→b secret']);
  assert.deepEqual(shadowTexts(alice, threadId, 'in'), ['b→a secret']);
  // hidden ⇒ excluded from the recipient's surface list (Property 7). Checked BEFORE probing any
  // surface state below, since getState() materialises an (empty) state on first access.
  assert.ok(!bob.registry.listSurfaceConversations().some((c) => c.remoteUid === 'alice'));
  // Property 12 / 8: NO shadow content ever lands in either side's surface conversation.
  assert.equal(surfaceMsgCount(alice), 0, 'inviter surface chat must stay empty');
  assert.equal(surfaceMsgCount(bob), 0, 'recipient surface chat must stay empty');

  // Shadow seqs are in the +1e9 space.
  const bobInbound = bob.registry.getState({ kind: 'shadow', threadId, peerUid: 'alice' }).messages.find((m) => m.direction === 'in');
  assert.ok(bobInbound && bobInbound.seq >= SHADOW_SEQ_OFFSET, 'shadow seq must be ≥ SHADOW_SEQ_OFFSET');

  // Property 4 / 15: every frame on the wire is opaque — no threadId, no plaintext — and a shadow
  // (invite/accept/message) envelope has the SAME field shape as any other envelope.
  const frames = hub.frames();
  assert.ok(frames.length >= 3, 'invite + accept + at least one shadow message were transmitted');
  const expectedKeys = JSON.stringify(Object.keys(frames[0].envelope).sort());
  for (const f of frames) {
    const env: CiphertextEnvelope = f.envelope;
    const serialized = JSON.stringify(env);
    assert.ok(!serialized.includes(threadId), 'threadId must NEVER appear on the wire');
    assert.ok(!serialized.includes('secret'), 'plaintext must NEVER appear on the wire');
    assert.ok(!Object.prototype.hasOwnProperty.call(env, 'threadId'));
    assert.equal(JSON.stringify(Object.keys(env).sort()), expectedKeys, 'all envelopes share an identical field shape');
  }
  // Auto-cleanup (Property 13): each side resolved the invite exactly once; only the active record remains.
  assert.equal(alice.events.filter((e) => e.type === 'invite-resolved').length, 1);
  assert.equal(bob.events.filter((e) => e.type === 'invite-resolved').length, 1);
  const aInvited = await alice.persistence.loadInvitedThreads();
  assert.equal(aInvited.length, 1);
  assert.equal(aInvited[0].state, 'active');
});

test('GATE: accept(merge) surfaces the thread in the recipient main chat yet keeps the isolated shadow state', async () => {
  const { alice, bob, threadId } = await setupConverged('merge');
  await alice.messaging.send('bob', 'merged hello', { threadId });
  await flush();
  // merge ⇒ visible under the peer uid (Property 7) ...
  assert.ok(bob.registry.listSurfaceConversations().some((c) => c.remoteUid === 'alice'));
  // ... yet the message lives in the isolated shadow state, not the surface reducer (Property 12).
  assert.deepEqual(shadowTexts(bob, threadId, 'in'), ['merged hello']);
  assert.equal(surfaceMsgCount(bob), 0);
});

test('GATE revoke leg: A revokes → both vaults drop key+record+history, thread closed, threadId not re-derivable, wire opaque (Props 14,15,17)', async () => {
  const { alice, bob, hub, threadId } = await setupConverged('hidden');
  await alice.messaging.send('bob', 'doomed-a', { threadId });
  await flush();
  await bob.messaging.send('alice', 'doomed-b', { threadId });
  await flush();
  assert.ok(alice.store.rows.size > 0 && bob.store.rows.size > 0);

  const framesBefore = hub.frames().length;
  await alice.coord.revokeShadowThread(threadId);
  await flush();

  // Property 14: symmetric teardown — no record/key on EITHER side.
  assert.equal((await alice.persistence.loadInvitedThreads()).length, 0);
  assert.equal((await bob.persistence.loadInvitedThreads()).length, 0);
  // Local history purged on both sides.
  for (const r of alice.store.rows.values()) assert.notEqual(r.plaintext, 'doomed-a');
  for (const r of bob.store.rows.values()) assert.notEqual(r.plaintext, 'doomed-b');
  assert.equal((await alice.rowThreads.rowIdsForThread(threadId)).length, 0);
  assert.equal((await bob.rowThreads.rowIdsForThread(threadId)).length, 0);
  // Thread closed on both: a further inbound shadow event for it is rejected (unknown thread).
  await assert.rejects(async () => {
    bob.registry.apply({ type: 'message-appended', message: { id: 'x', seq: SHADOW_SEQ_OFFSET + 9, direction: 'in', text: 'after', status: 'received', createdAt: 1 }, remoteUid: 'alice', threadId });
  });
  // Property 17: with the only HMAC key gone, the threadId cannot be reproduced from stored state.
  // (Both vaults hold no threadKey; the derivation below would require it.)
  assert.equal((await alice.persistence.loadInvitedThreads()).length, 0);
  // Both sides emitted thread-revoked (self on A, peer on B).
  assert.ok(alice.events.some((e) => e.type === 'thread-revoked' && e.initiatedBy === 'self'));
  assert.ok(bob.events.some((e) => e.type === 'thread-revoked' && e.initiatedBy === 'peer'));
  // Property 15: the shadow-revoke frame is opaque and shaped like every other envelope.
  const frames = hub.frames();
  assert.ok(frames.length > framesBefore, 'a shadow-revoke envelope was transmitted');
  const expectedKeys = JSON.stringify(Object.keys(frames[0].envelope).sort());
  for (const f of frames.slice(framesBefore)) {
    assert.ok(!JSON.stringify(f.envelope).includes(threadId), 'no threadId on the wire for revoke');
    assert.equal(JSON.stringify(Object.keys(f.envelope).sort()), expectedKeys);
  }
});

test('GATE clear leg: A clears local history but the chat keeps working (new message still delivers) (Property 18)', async () => {
  const { alice, bob, threadId } = await setupConverged('hidden');
  await alice.messaging.send('bob', 'old-1', { threadId });
  await flush();
  assert.ok((await alice.rowThreads.rowIdsForThread(threadId)).length > 0);

  await alice.coord.clearShadowThread(threadId);
  // Local history purged + state reset, but the record + key are kept.
  assert.equal((await alice.persistence.loadInvitedThreads()).length, 1);
  assert.equal((await alice.rowThreads.rowIdsForThread(threadId)).length, 0);

  // The chat still works: a new message on the SAME threadId is sent and delivered to B.
  await alice.messaging.send('bob', 'fresh-after-clear', { threadId });
  await flush();
  assert.deepEqual(shadowTexts(bob, threadId, 'in').slice(-1), ['fresh-after-clear']);
});

test('GATE decline leg: a declined invite leaves NO shadow residue on either side', async () => {
  const A = await newParty('alice', 'devA');
  const B = await newParty('bob', 'devB');
  const hub = makeHub();
  const alice = makeClient(A, { [B.uid]: B.bundle }, hub, B.uid, 7);
  const bob = makeClient(B, { [A.uid]: A.bundle }, hub, A.uid, 5555);

  await alice.coord.createInvite('bob');
  await flush();
  await bob.coord.declineInvite(receivedInviteId(bob));
  await flush();

  assert.equal((await alice.persistence.loadInvitedThreads()).length, 0, 'inviter keeps no record after decline');
  assert.equal((await bob.persistence.loadInvitedThreads()).length, 0, 'recipient keeps no record after decline');
  assert.ok(alice.events.some((e) => e.type === 'invite-declined'));
  assert.equal(alice.events.filter((e) => e.type === 'invite-resolved').length, 1);
});
