import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  CiphertextEnvelope,
  ClaimedPreKeyBundle,
  ClientToServerFrame,
  ServerToClientFrame,
} from '@chat-app/types';

import {
  createConversationRegistry,
  type ConversationKey,
  type ConversationRegistry,
} from './conversation-registry';
import type { ConversationEvent, ConversationState } from './conversation-reducer';
import { createEnvelopeCodec } from './envelope-codec';
import { createInMemorySignalProtocolStore } from './in-memory-signal-store';
import {
  createPureTsLibsignalEngine,
  createPureTsLibsignalKeyGen,
  encodePreKeyRecord,
} from './libsignal-puretsignal';
import { createMessaging, type MessagingRealtime, type MessagingStore } from './messaging';
import type { KeyStore, MessageRow, SignalProtocolStore } from './ports';
import { createSessionManager } from './session-manager';
import type { SequenceAllocator } from './sequence-allocator';
import { deriveShadowThreadId } from './shadow-chat';
import { SHADOW_SEQ_OFFSET, ShadowSequenceAllocator } from './shadow-sequence-allocator';

/**
 * ============================================================================================
 *  GATING DELIVERABLE — Shadow Chat two-client end-to-end test (design "Integration / end-to-end
 *  testing — the gating deliverable"; tasks 5.1 / 6). Per Requirement 10.7 NO UI work (epic 8)
 *  may begin until THIS test passes. It is the explicit "core-first (crypto + messaging) before UI"
 *  gate.
 * ============================================================================================
 *
 * Mirrors the `messaging-puretsignal-e2e.test.ts` harness — the SHIPPABLE pure-JS
 * `@privacyresearch/libsignal-protocol-typescript` engine the web and mobile clients run — and
 * drives the REAL {@link createMessaging} orchestrator + {@link createSessionManager} for two
 * parties (A and B) over an in-process relay that mirrors the (frozen) Backend_API gateway. Both
 * parties share ONE shadow `masterSecret`, derive the SAME `threadId` with no handshake, and feed
 * their emitted {@link ConversationEvent}s into a {@link ConversationRegistry} (with the shadow
 * thread pre-opened on each side).
 *
 * It proves surface and shadow stay FULLY separated with real cryptography:
 *   1. Both sides independently derive the same `threadId` (Property 1).
 *   2. ≥10 surface and ≥10 shadow messages (≥1 of each in BOTH directions) land in disjoint seq
 *      spaces (`<1e9` vs `>=1e9`), each conversation containing only its own messages (Props 2, 8).
 *   3. A reaction + a disappearing-timer in the shadow thread never touch the surface thread, and
 *      vice-versa (Property 8).
 *   4. A gap induced in each thread yields a `missingBefore` computed PER thread (Property 3).
 *   5. EVERY frame on the wire carries no `threadId` and no plaintext, and a shadow envelope and a
 *      surface envelope expose an identical field-name set, count, types, and ordering (Property 5,
 *      C1) — the server cannot tell shadow from surface.
 */

const PREKEY_ID = 31337;
const SIGNED_PREKEY_ID = 22;

/** The shared device-local shadow master secret both peers hold (never on the wire). */
const SHADOW_MASTER_SECRET = new TextEncoder().encode('shadow-chat-e2e-shared-master-secret');

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

interface Hub {
  realtimeFor: (uid: string) => MessagingRealtime;
  lastFrame: () => Extract<ClientToServerFrame, { kind: 'send' }> | null;
  /** Every `send` frame placed on the wire (for the no-leak / envelope-shape assertions). */
  frames: () => Extract<ClientToServerFrame, { kind: 'send' }>[];
  /** While paused, frames are still captured + ACKed to the sender but NOT delivered (induces gaps). */
  setPaused: (paused: boolean) => void;
}

/** In-process relay mirroring the gateway: ack to sender + (unless paused) deliver to recipient. */
function makeHub(): Hub {
  const deliverers = new Map<string, (frame: ServerToClientFrame) => void>();
  const captured: Extract<ClientToServerFrame, { kind: 'send' }>[] = [];
  let lastFrame: Extract<ClientToServerFrame, { kind: 'send' }> | null = null;
  let paused = false;

  return {
    lastFrame: () => lastFrame,
    frames: () => captured,
    setPaused: (p: boolean) => {
      paused = p;
    },
    realtimeFor(uid: string): MessagingRealtime {
      const frameListeners = new Set<(frame: ServerToClientFrame) => void>();
      deliverers.set(uid, (frame) => {
        for (const listener of frameListeners) {
          listener(frame);
        }
      });
      return {
        send(frame: ClientToServerFrame): void {
          if (frame.kind !== 'send') {
            return;
          }
          captured.push(frame);
          lastFrame = frame;
          const env = frame.envelope;
          // Always acknowledge the sender (so sends settle to `sent` even while delivery is paused).
          deliverers.get(env.senderUid)?.({
            kind: 'ack',
            recipientUid: env.recipientUid,
            seq: env.seq,
            status: 'received',
          });
          // Deliver to the recipient unless paused — pausing drops exactly the messages sent during
          // the pause window, which is how we induce a per-thread sequence gap deterministically.
          if (!paused) {
            deliverers.get(env.recipientUid)?.({ kind: 'deliver', envelope: env });
          }
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

/** Trivial per-recipient monotonic SURFACE sequence allocator (seq < 1e9). */
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

/** Minimal KeyStore exposing the per-thread `nextSeq` the {@link ShadowSequenceAllocator} needs. */
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
  uid: string;
  peerUid: string;
  send: (uid: string, text: string, threadId?: string) => Promise<void>;
  react: (uid: string, target: { direction: 'in' | 'out'; seq: number }, emoji: string, threadId?: string) => Promise<void>;
  setTimer: (uid: string, ttlMs: number, threadId?: string) => Promise<void>;
  onEnvelope: (envelope: CiphertextEnvelope) => Promise<void>;
  registry: ConversationRegistry;
  surfaceState: () => ConversationState;
  shadowState: () => ConversationState;
  dispose: () => void;
}

function makeClient(
  party: Party,
  peerBundles: Record<string, ClaimedPreKeyBundle>,
  hub: Hub,
  peerUid: string,
  threadId: string,
): Client {
  const store = makeStore();
  const shadowKeyStore = makeShadowKeyStore();
  const registry = createConversationRegistry({ platform: 'mobile' });
  // Pre-open the shadow thread so inbound shadow events are accepted (the UI opens it via /alias).
  registry.openShadowThread(threadId, peerUid);
  let counter = 0;

  const messaging = createMessaging(
    {
      realtime: hub.realtimeFor(party.uid),
      sessions: createSessionManager(party.store, createPureTsLibsignalEngine()),
      sequence: makeSurfaceSequence(),
      shadowSequence: (tid: string) => new ShadowSequenceAllocator(shadowKeyStore, tid),
      codec: createEnvelopeCodec(),
      keyClaimer: { claim: async (uid: string) => peerBundles[uid] ?? null },
      sender: { resolveSender: async () => ({ uid: party.uid, deviceId: party.deviceId }) },
      store,
    },
    { generateId: () => `${party.uid}-${(counter += 1)}` },
  );
  // Every emitted conversation event drives the per-thread registry (surface vs shadow routing).
  messaging.onConversationUpdate((event) => registry.apply(event));

  const surfaceKey: ConversationKey = { kind: 'surface', remoteUid: peerUid };
  const shadowKey: ConversationKey = { kind: 'shadow', threadId, peerUid };

  return {
    uid: party.uid,
    peerUid,
    send: (uid, text, tid) =>
      messaging.send(uid, text, tid !== undefined ? { threadId: tid } : undefined),
    react: (uid, target, emoji, tid) =>
      messaging.react(uid, target, emoji, tid !== undefined ? { threadId: tid } : undefined),
    setTimer: (uid, ttlMs, tid) =>
      messaging.setDisappearingTimer(uid, ttlMs, tid !== undefined ? { threadId: tid } : undefined),
    onEnvelope: (envelope) => messaging.onEnvelope(envelope),
    registry,
    surfaceState: () => registry.getState(surfaceKey),
    shadowState: () => registry.getState(shadowKey),
    dispose: () => messaging.dispose(),
  };
}

/** Drain the pure-TS engine's async WebCrypto decrypt/ack chains (each a real macrotask turn). */
async function flush(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const texts = (state: ConversationState, direction: 'in' | 'out'): string[] =>
  state.messages.filter((m) => m.direction === direction).map((m) => m.text ?? '');

test('SHADOW E2E GATE: surface and shadow stay fully separated across two real clients (Props 1,2,3,5,8)', async () => {
  const alice = await newParty('alice-uid', 'alice-dev');
  const bob = await newParty('bob-uid', 'bob-dev');

  // ---- Property 1: both sides derive the SAME threadId with no handshake (symmetric) ----------
  const threadIdA = await deriveShadowThreadId(SHADOW_MASTER_SECRET, alice.uid, bob.uid);
  const threadIdB = await deriveShadowThreadId(SHADOW_MASTER_SECRET, bob.uid, alice.uid);
  assert.equal(threadIdA, threadIdB, 'Property 1: both peers must derive the identical threadId');
  const threadId = threadIdA;

  const hub = makeHub();
  const A = makeClient(alice, { [bob.uid]: bob.bundle }, hub, bob.uid, threadId);
  const B = makeClient(bob, { [alice.uid]: alice.bundle }, hub, alice.uid, threadId);

  // ---- Exchange >=10 surface + >=10 shadow messages, >=1 of each in BOTH directions -----------
  // Surface: 5 A->B and 5 B->A.
  for (let i = 1; i <= 5; i += 1) {
    await A.send(bob.uid, `surface-A-${i}`);
    await flush();
    await B.send(alice.uid, `surface-B-${i}`);
    await flush();
  }
  // Shadow: 5 A->B and 5 B->A. Capture A's first outbound shadow seq for the reaction step.
  let firstShadowOutboundSeqA = 0;
  for (let i = 1; i <= 5; i += 1) {
    await A.send(bob.uid, `shadow-A-${i}`, threadId);
    await flush();
    if (i === 1) firstShadowOutboundSeqA = hub.lastFrame()!.envelope.seq;
    await B.send(alice.uid, `shadow-B-${i}`, threadId);
    await flush();
  }

  // ---- Properties 2 + 8: each conversation holds only its own messages, disjoint seq spaces ----
  for (const C of [A, B]) {
    const surface = C.surfaceState();
    const shadow = C.shadowState();
    // 5 sent + 5 received in each conversation.
    assert.equal(surface.messages.length, 10, 'surface must hold exactly its 10 messages');
    assert.equal(shadow.messages.length, 10, 'shadow must hold exactly its 10 messages');
    // Disjoint seq ranges: surface < 1e9 <= shadow (Property 2).
    assert.ok(
      surface.messages.every((m) => m.seq < SHADOW_SEQ_OFFSET),
      'every surface seq must be < 1e9',
    );
    assert.ok(
      shadow.messages.every((m) => m.seq >= SHADOW_SEQ_OFFSET),
      'every shadow seq must be >= 1e9',
    );
    // Only-their-own content: no shadow text in surface and no surface text in shadow (Property 8).
    const surfaceText = surface.messages.map((m) => m.text ?? '').join('|');
    const shadowText = shadow.messages.map((m) => m.text ?? '').join('|');
    assert.ok(!surfaceText.includes('shadow-'), 'surface conversation leaked a shadow message');
    assert.ok(!shadowText.includes('surface-'), 'shadow conversation leaked a surface message');
  }
  // Sanity: both directions are present in each conversation on A's side.
  assert.deepEqual(texts(A.surfaceState(), 'out').sort(), ['surface-A-1', 'surface-A-2', 'surface-A-3', 'surface-A-4', 'surface-A-5']);
  assert.deepEqual(texts(A.surfaceState(), 'in').sort(), ['surface-B-1', 'surface-B-2', 'surface-B-3', 'surface-B-4', 'surface-B-5']);
  assert.deepEqual(texts(A.shadowState(), 'out').sort(), ['shadow-A-1', 'shadow-A-2', 'shadow-A-3', 'shadow-A-4', 'shadow-A-5']);
  assert.deepEqual(texts(A.shadowState(), 'in').sort(), ['shadow-B-1', 'shadow-B-2', 'shadow-B-3', 'shadow-B-4', 'shadow-B-5']);

  // ---- Property 8: a reaction + timer in the SHADOW thread do not touch the SURFACE thread ----
  await A.react(bob.uid, { direction: 'out', seq: firstShadowOutboundSeqA }, '🔥', threadId);
  await flush();
  await A.setTimer(bob.uid, 3_600_000, threadId);
  await flush();

  // A's shadow message carries the reaction; A's surface messages carry none; surface TTL untouched.
  const aShadowReacted = A.shadowState().messages.find(
    (m) => m.seq === firstShadowOutboundSeqA && m.direction === 'out',
  );
  assert.deepEqual(aShadowReacted?.reactions, ['🔥'], 'shadow reaction missing on the shadow message');
  assert.equal(A.shadowState().disappearingTtlMs, 3_600_000, 'shadow timer not applied to shadow');
  assert.ok(
    A.surfaceState().messages.every((m) => m.reactions === undefined),
    'a shadow reaction bled into the surface thread',
  );
  assert.equal(A.surfaceState().disappearingTtlMs, 0, 'a shadow timer bled into the surface thread');
  // The reaction also reached B's shadow thread only (inbound), never B's surface thread.
  assert.ok(
    B.shadowState().messages.some((m) => (m.reactions ?? []).includes('🔥')),
    "B's shadow thread should have received the reaction",
  );
  assert.ok(
    B.surfaceState().messages.every((m) => m.reactions === undefined),
    'a shadow reaction bled into B surface thread',
  );

  // ---- Property 8 (vice-versa): a reaction + timer in the SURFACE thread do not touch SHADOW ----
  const firstSurfaceOutboundSeqA = A.surfaceState().messages.find((m) => m.direction === 'out')!.seq;
  await A.react(bob.uid, { direction: 'out', seq: firstSurfaceOutboundSeqA }, '👍');
  await flush();
  await A.setTimer(bob.uid, 60_000);
  await flush();

  const aSurfaceReacted = A.surfaceState().messages.find(
    (m) => m.seq === firstSurfaceOutboundSeqA && m.direction === 'out',
  );
  assert.deepEqual(aSurfaceReacted?.reactions, ['👍'], 'surface reaction missing on the surface message');
  assert.equal(A.surfaceState().disappearingTtlMs, 60_000, 'surface timer not applied to surface');
  // The shadow thread is unchanged by the surface reaction/timer: still only the '🔥' reaction and
  // the shadow TTL, never the surface '👍' or the 60s surface TTL.
  assert.equal(A.shadowState().disappearingTtlMs, 3_600_000, 'a surface timer bled into the shadow thread');
  assert.ok(
    A.shadowState().messages.every((m) => !(m.reactions ?? []).includes('👍')),
    'a surface reaction bled into the shadow thread',
  );

  // ---- Property 3: induce a gap in EACH thread; missingBefore is computed PER thread -----------
  // Surface gap on A's inbound: B sends g1 (delivered), g2 (dropped), g3 (delivered).
  await B.send(alice.uid, 'surface-gap-1');
  await flush();
  hub.setPaused(true);
  await B.send(alice.uid, 'surface-gap-2-DROPPED');
  await flush();
  hub.setPaused(false);
  await B.send(alice.uid, 'surface-gap-3');
  await flush();

  // Shadow gap on A's inbound: same drop pattern within the shadow thread.
  await B.send(alice.uid, 'shadow-gap-1', threadId);
  await flush();
  hub.setPaused(true);
  await B.send(alice.uid, 'shadow-gap-2-DROPPED', threadId);
  await flush();
  hub.setPaused(false);
  await B.send(alice.uid, 'shadow-gap-3', threadId);
  await flush();

  const surfaceMissing = A.surfaceState().missingBefore;
  const shadowMissing = A.shadowState().missingBefore;
  assert.ok(surfaceMissing.length > 0, 'surface thread should report a gap');
  assert.ok(shadowMissing.length > 0, 'shadow thread should report a gap');
  // PER-thread: the surface gap is a surface seq (<1e9) and the shadow gap a shadow seq (>=1e9),
  // and neither leaks into the other thread's missingBefore.
  assert.ok(surfaceMissing.every((s) => s < SHADOW_SEQ_OFFSET), 'surface gap must be a surface seq');
  assert.ok(shadowMissing.every((s) => s >= SHADOW_SEQ_OFFSET), 'shadow gap must be a shadow seq');
  assert.ok(
    surfaceMissing.every((s) => !shadowMissing.includes(s)),
    'a gap leaked across threads (surface ∩ shadow)',
  );

  // ---- Property 5 + C1: nothing sensitive on the wire; shadow + surface envelopes are identical -
  const frames = hub.frames();
  assert.ok(frames.length > 0, 'frames were captured');
  for (const frame of frames) {
    const serialized = JSON.stringify(frame);
    assert.ok(!serialized.includes(threadId), 'threadId must NEVER appear on the wire');
    // No plaintext (surface or shadow, including the dropped ones) ever appears on the wire.
    for (const needle of ['surface-', 'shadow-', 'gap-']) {
      assert.ok(!serialized.includes(needle), `plaintext "${needle}" leaked onto the wire`);
    }
    // The envelope itself must expose no threadId / plaintext field.
    assert.ok(!Object.prototype.hasOwnProperty.call(frame.envelope, 'threadId'));
    assert.ok(!Object.prototype.hasOwnProperty.call(frame.envelope, 'plaintext'));
  }

  // A shadow envelope and a surface envelope are indistinguishable in shape (Property 5, C1).
  const surfaceEnvelope = frames.find((f) => f.envelope.seq < SHADOW_SEQ_OFFSET)!.envelope;
  const shadowEnvelope = frames.find((f) => f.envelope.seq >= SHADOW_SEQ_OFFSET)!.envelope;
  const surfaceKeys = Object.keys(surfaceEnvelope);
  const shadowKeys = Object.keys(shadowEnvelope);
  // Identical field-name set + identical field count + identical ORDERING.
  assert.deepEqual(shadowKeys, surfaceKeys, 'shadow + surface envelopes differ in field names/order/count');
  // Identical field TYPES.
  const surfaceRec = surfaceEnvelope as unknown as Record<string, unknown>;
  const shadowRec = shadowEnvelope as unknown as Record<string, unknown>;
  for (const key of surfaceKeys) {
    assert.equal(
      typeof shadowRec[key],
      typeof surfaceRec[key],
      `envelope field "${key}" differs in type between shadow and surface`,
    );
  }

  A.dispose();
  B.dispose();
});
