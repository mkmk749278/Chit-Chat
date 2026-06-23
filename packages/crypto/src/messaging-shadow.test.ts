import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  CiphertextBody,
  CiphertextEnvelope,
  ClientToServerFrame,
  ConnectionStatus,
  MessageStatus,
  ServerToClientFrame,
} from '@chat-app/types';
import type { ClaimedPreKeyBundle } from '@chat-app/types';

import { decodeContentPayload } from './content-payload';
import type { ConversationEvent } from './conversation-reducer';
import { createEnvelopeCodec } from './envelope-codec';
import { DefaultMessaging } from './messaging';
import type {
  LocalSenderResolver,
  MessagingDeps,
  MessagingRealtime,
  MessagingStore,
  PreKeyClaimClient,
} from './messaging';
import type { KeyStore, MessageRow, Unsubscribe } from './ports';
import type { Scheduler, TimerHandle } from './realtime-client';
import type { SequenceAllocator } from './sequence-allocator';
import type { SessionManager } from './session-manager';
import { SHADOW_SEQ_OFFSET, ShadowSequenceAllocator } from './shadow-sequence-allocator';

/**
 * `@chat-app/crypto` — Shadow Chat threadId routing through {@link DefaultMessaging} (Shadow Chat,
 * design Component 4/5; tasks 3.1/3.2). Asserts that:
 *   - a SURFACE send/receive (no threadId) is observationally identical to the pre-shadow
 *     behaviour: seq <1e9, no threadId-tagged events, ordering/status transitions unchanged;
 *   - a SHADOW send allocates a seq ≥ `SHADOW_SEQ_OFFSET`, carries the threadId INSIDE the
 *     encrypted body, leaks neither the threadId nor any plaintext onto the wire, acks on the
 *     shared `${recipientUid}:${seq}` key, and tags every emitted event with the threadId;
 *   - react/edit/delete/timer with a threadId carry it through to their emitted events and encode
 *     it inside the payload;
 *   - an inbound shadow envelope routes events tagged with the decoded threadId.
 *
 * Mirrors the fakes/harness of `messaging.test.ts`; the sessions double additionally records the
 * plaintext handed to `encrypt`, so a test can decode it and confirm the threadId rode inside the
 * ciphertext body (and never on the wire envelope).
 */

const THREAD_ID = 'a'.repeat(64); // shaped like a deriveShadowThreadId hex output

// --- fakes -------------------------------------------------------------------

class FakeRealtime implements MessagingRealtime {
  status: ConnectionStatus = 'connected';
  readonly sent: Extract<ClientToServerFrame, { kind: 'send' }>[] = [];
  private readonly frameListeners = new Set<(frame: ServerToClientFrame) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();

  send(frame: ClientToServerFrame): void {
    if (frame.kind === 'send') {
      this.sent.push(frame);
    }
  }
  getStatus(): ConnectionStatus {
    return this.status;
  }
  onFrame(listener: (frame: ServerToClientFrame) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
  onStatus(listener: (status: ConnectionStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }
  emitFrame(frame: ServerToClientFrame): void {
    for (const l of this.frameListeners) l(frame);
  }
}

const bundle = (deviceId: string): ClaimedPreKeyBundle => ({
  deviceId,
  registrationId: 1,
  identityKey: Buffer.from('id').toString('base64'),
  signedPreKey: {
    keyId: 1,
    publicKey: Buffer.from('spk').toString('base64'),
    signature: Buffer.from('sig').toString('base64'),
  },
  oneTimePreKey: { keyId: 2, publicKey: Buffer.from('otp').toString('base64') },
});

/** Records every plaintext handed to `encrypt`, so tests can decode it and inspect the threadId. */
class RecordingSessions implements SessionManager {
  private readonly sessions = new Set<string>();
  readonly encrypted: string[] = [];
  decryptResult: string | Error = 'decrypted';

  async hasSession(recipientUid: string): Promise<boolean> {
    return this.sessions.has(recipientUid);
  }
  async establishSession(recipientUid: string): Promise<void> {
    this.sessions.add(recipientUid);
  }
  async encrypt(_recipientUid: string, plaintext: string): Promise<CiphertextBody> {
    this.encrypted.push(plaintext);
    return { type: 3, ciphertext: Buffer.from('ct').toString('base64') };
  }
  async decrypt(): Promise<string> {
    if (this.decryptResult instanceof Error) throw this.decryptResult;
    return this.decryptResult;
  }
  async getSafetyNumber(): Promise<null> {
    return null;
  }
}

class FakeSurfaceSequence implements SequenceAllocator {
  private readonly counters = new Map<string, number>();
  async next(recipientUid: string): Promise<number> {
    const next = (this.counters.get(recipientUid) ?? 0) + 1;
    this.counters.set(recipientUid, next);
    return next;
  }
}

/** Minimal `KeyStore` exposing only `nextSeq` (all the shadow allocator needs), per conversation key. */
function fakeKeyStore(): KeyStore {
  const counters = new Map<string, number>();
  return {
    async nextSeq(key: string): Promise<number> {
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return n;
    },
  } as unknown as KeyStore;
}

class FakeClaimer implements PreKeyClaimClient {
  result: ClaimedPreKeyBundle | null = bundle('dev-recipient');
  async claim(): Promise<ClaimedPreKeyBundle | null> {
    return this.result;
  }
}

class FakeSender implements LocalSenderResolver {
  value: { uid: string; deviceId: string } | null = { uid: 'me', deviceId: 'dev-me' };
  async resolveSender(): Promise<{ uid: string; deviceId: string } | null> {
    return this.value;
  }
}

class FakeStore implements MessagingStore {
  readonly rows: MessageRow[] = [];
  readonly statuses: Array<{ id: string; status: MessageStatus }> = [];
  readonly mutations: Array<{ kind: string; remoteUid: string; direction: 'in' | 'out'; seq: number; extra?: string }> = [];
  readonly timers = new Map<string, number>();
  async appendMessage(row: MessageRow): Promise<void> {
    this.rows.push(row);
  }
  async updateMessageStatus(id: string, status: MessageStatus): Promise<void> {
    this.statuses.push({ id, status });
  }
  async applyReaction(remoteUid: string, direction: 'in' | 'out', seq: number, emoji: string): Promise<void> {
    this.mutations.push({ kind: 'reaction', remoteUid, direction, seq, extra: emoji });
  }
  async applyEdit(remoteUid: string, direction: 'in' | 'out', seq: number, body: string): Promise<void> {
    this.mutations.push({ kind: 'edit', remoteUid, direction, seq, extra: body });
  }
  async applyDelete(remoteUid: string, direction: 'in' | 'out', seq: number): Promise<void> {
    this.mutations.push({ kind: 'delete', remoteUid, direction, seq });
  }
  async setConversationTimer(remoteUid: string, ttlMs: number): Promise<void> {
    this.timers.set(remoteUid, ttlMs);
  }
  async loadMessages(): Promise<MessageRow[]> {
    return this.rows.map((r) => ({ ...r }));
  }
  async purgeMessages(ids: string[]): Promise<void> {
    for (const id of ids) {
      const i = this.rows.findIndex((r) => r.id === id);
      if (i >= 0) this.rows.splice(i, 1);
    }
  }
}

class FakeScheduler implements Scheduler {
  private seq = 0;
  private readonly timers = new Map<number, () => void>();
  setTimeout(handler: () => void): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, handler);
    return id;
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }
  runPending(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    for (const fn of fns) fn();
  }
  get count(): number {
    return this.timers.size;
  }
}

interface Harness {
  realtime: FakeRealtime;
  sessions: RecordingSessions;
  claimer: FakeClaimer;
  sender: FakeSender;
  store: FakeStore;
  scheduler: FakeScheduler;
  events: ConversationEvent[];
  messaging: DefaultMessaging;
}

let idCounter = 0;

/** Build a harness; `withShadow` controls whether the shadow-sequence factory is injected. */
function makeHarness(withShadow = true): Harness {
  idCounter = 0;
  const realtime = new FakeRealtime();
  const sessions = new RecordingSessions();
  const claimer = new FakeClaimer();
  const sender = new FakeSender();
  const store = new FakeStore();
  const scheduler = new FakeScheduler();
  const events: ConversationEvent[] = [];
  const keyStore = fakeKeyStore();

  const deps: MessagingDeps = {
    realtime,
    sessions,
    sequence: new FakeSurfaceSequence(),
    codec: createEnvelopeCodec(),
    keyClaimer: claimer,
    sender,
    store,
    ...(withShadow
      ? { shadowSequence: (threadId: string) => new ShadowSequenceAllocator(keyStore, threadId) }
      : {}),
  };
  const messaging = new DefaultMessaging(deps, {
    generateId: () => `id-${++idCounter}`,
    now: () => 1000,
    scheduler,
  });
  messaging.onConversationUpdate((e) => events.push(e));
  return { realtime, sessions, claimer, sender, store, scheduler, events, messaging };
}

const ackFor = (envelope: CiphertextEnvelope): ServerToClientFrame => ({
  kind: 'ack',
  recipientUid: envelope.recipientUid,
  seq: envelope.seq,
  status: 'received',
});

const threadIdOf = (event: ConversationEvent): string | undefined =>
  (event as { threadId?: string }).threadId;

// --- surface path unchanged --------------------------------------------------

test('a surface send (no threadId) keeps seq <1e9 and emits no threadId-tagged events (5.2)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'hello');

  const frame = h.realtime.sent[0]!;
  assert.equal(frame.envelope.seq, 1);
  assert.ok(frame.envelope.seq < SHADOW_SEQ_OFFSET);
  // optimistic event identical to the pre-shadow shape (plus the P2 `createdAt` ordering key) —
  // no threadId key present.
  assert.deepEqual(h.events[0], {
    type: 'message-appended',
    message: { id: 'id-1', seq: 1, direction: 'out', text: 'hello', status: 'sending', createdAt: 1000 },
    remoteUid: 'bob',
  });
  assert.ok(h.events.every((e) => threadIdOf(e) === undefined));
});

test('a surface inbound message emits no threadId-tagged events (5.2)', async () => {
  const h = makeHarness();
  h.sessions.decryptResult = 'hi back';
  const envelope: CiphertextEnvelope = {
    senderUid: 'bob',
    recipientUid: 'me',
    senderDeviceId: 'dev-bob',
    seq: 7,
    type: 1,
    ciphertext: Buffer.from('x').toString('base64'),
  };
  await h.messaging.onEnvelope(envelope);

  assert.deepEqual(h.events.at(-1), {
    type: 'message-appended',
    message: { id: 'id-1', seq: 7, direction: 'in', text: 'hi back', status: 'received', createdAt: 1000 },
    remoteUid: 'bob',
  });
  assert.ok(h.events.every((e) => threadIdOf(e) === undefined));
});

// --- shadow send -------------------------------------------------------------

test('a shadow send allocates a seq >= SHADOW_SEQ_OFFSET (4.1, 4.4)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'meet at 8', { threadId: THREAD_ID });

  const frame = h.realtime.sent[0]!;
  assert.equal(frame.envelope.seq, SHADOW_SEQ_OFFSET + 1);
  assert.ok(frame.envelope.seq >= SHADOW_SEQ_OFFSET);
});

test('a shadow send tags every emitted event with the threadId (3.1, 5.2)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'meet at 8', { threadId: THREAD_ID });

  const appended = h.events.find((e) => e.type === 'message-appended');
  assert.ok(appended && appended.type === 'message-appended');
  assert.equal(threadIdOf(appended), THREAD_ID);
  assert.equal(appended.message.seq, SHADOW_SEQ_OFFSET + 1);
});

test('a shadow send carries the threadId INSIDE the encrypted body (3.1)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'meet at 8', { threadId: THREAD_ID });

  // The plaintext handed to encrypt decodes back to the threadId + text.
  const decoded = decodeContentPayload(h.sessions.encrypted[0]!);
  assert.equal(decoded.threadId, THREAD_ID);
  assert.equal(decoded.payload.type, 'text');
  assert.equal(decoded.payload.type === 'text' ? decoded.payload.body : null, 'meet at 8');
});

test('a shadow send leaks neither the threadId nor the plaintext onto the wire (Property 5, C1)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'topsecret', { threadId: THREAD_ID });

  const frame = h.realtime.sent[0]!;
  const serialized = JSON.stringify(frame);
  assert.ok(!serialized.includes(THREAD_ID), 'threadId must never appear on the wire');
  assert.ok(!serialized.includes('topsecret'), 'plaintext must never appear on the wire');
  assert.ok(!Object.prototype.hasOwnProperty.call(frame.envelope, 'threadId'));
});

test('a shadow ack on `${recipientUid}:${seq}` transitions the shadow send to sent (5.6, 4.4)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'hi', { threadId: THREAD_ID });
  const envelope = h.realtime.sent[0]!.envelope;

  h.realtime.emitFrame(ackFor(envelope));
  await Promise.resolve();

  assert.deepEqual(h.store.statuses.at(-1), { id: 'id-1', status: 'sent' });
  const sent = h.events.at(-1)!;
  assert.equal(sent.type, 'status-updated');
  assert.equal(threadIdOf(sent), THREAD_ID);
});

test('a shadow ack-timeout fails the shadow send with text retained + threadId tag (5.11)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'hi', { threadId: THREAD_ID });
  h.scheduler.runPending();
  await Promise.resolve();

  assert.deepEqual(h.store.statuses.at(-1), { id: 'id-1', status: 'failed' });
  assert.equal(h.store.rows[0]!.plaintext, 'hi');
  const failed = h.events.at(-1)!;
  assert.equal(failed.type, 'status-updated');
  assert.equal(threadIdOf(failed), THREAD_ID);
});

test('surface and shadow sends to the same contact use disjoint seq spaces', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'surface', {});
  await h.messaging.send('bob', 'shadow', { threadId: THREAD_ID });

  assert.equal(h.realtime.sent[0]!.envelope.seq, 1); // surface
  assert.equal(h.realtime.sent[1]!.envelope.seq, SHADOW_SEQ_OFFSET + 1); // shadow
});

test('a shadow send with no shadow factory fails locally, retaining text, transmitting nothing (3.6)', async () => {
  const h = makeHarness(false);
  await h.messaging.send('bob', 'meet at 8', { threadId: THREAD_ID });

  assert.equal(h.realtime.sent.length, 0, 'nothing transmitted for a misconfigured shadow send');
  assert.equal(h.store.rows.length, 1);
  assert.equal(h.store.rows[0]!.status, 'failed');
  assert.equal(h.store.rows[0]!.plaintext, 'meet at 8');
  const appended = h.events.find((e) => e.type === 'message-appended');
  assert.ok(appended && appended.type === 'message-appended');
  assert.equal(threadIdOf(appended), THREAD_ID);
  assert.equal(appended.message.status, 'failed');
  // No surface seq was consumed: a subsequent surface send still starts at 1.
  await h.messaging.send('bob', 'surface');
  assert.equal(h.realtime.sent[0]!.envelope.seq, 1);
});

// --- shadow react / edit / delete / timer ------------------------------------

test('a shadow reaction tags its event and encodes the threadId inside the payload (7.2)', async () => {
  const h = makeHarness();
  await h.messaging.react('bob', { direction: 'out', seq: SHADOW_SEQ_OFFSET + 1 }, '👍', { threadId: THREAD_ID });

  const applied = h.events.find((e) => e.type === 'reaction-applied');
  assert.ok(applied && applied.type === 'reaction-applied');
  assert.equal(threadIdOf(applied), THREAD_ID);
  const decoded = decodeContentPayload(h.sessions.encrypted[0]!);
  assert.equal(decoded.threadId, THREAD_ID);
  assert.equal(decoded.payload.type, 'reaction');
  assert.equal(h.realtime.sent[0]!.envelope.seq, SHADOW_SEQ_OFFSET + 1);
});

test('a shadow edit tags its event and encodes the threadId inside the payload (7.2)', async () => {
  const h = makeHarness();
  await h.messaging.editMessage('bob', { direction: 'out', seq: SHADOW_SEQ_OFFSET + 1 }, 'fixed', { threadId: THREAD_ID });

  const edited = h.events.find((e) => e.type === 'message-edited');
  assert.ok(edited && edited.type === 'message-edited');
  assert.equal(threadIdOf(edited), THREAD_ID);
  const decoded = decodeContentPayload(h.sessions.encrypted[0]!);
  assert.equal(decoded.threadId, THREAD_ID);
  assert.equal(decoded.payload.type, 'edit');
});

test('a shadow delete tags its event and encodes the threadId inside the payload (7.2)', async () => {
  const h = makeHarness();
  await h.messaging.deleteMessage('bob', { direction: 'out', seq: SHADOW_SEQ_OFFSET + 1 }, { threadId: THREAD_ID });

  const deleted = h.events.find((e) => e.type === 'message-deleted');
  assert.ok(deleted && deleted.type === 'message-deleted');
  assert.equal(threadIdOf(deleted), THREAD_ID);
  const decoded = decodeContentPayload(h.sessions.encrypted[0]!);
  assert.equal(decoded.threadId, THREAD_ID);
  assert.equal(decoded.payload.type, 'delete');
});

test('a shadow timer tags its event, encodes the threadId, and does not touch the surface timer (7.3)', async () => {
  const h = makeHarness();
  await h.messaging.setDisappearingTimer('bob', 3_600_000, { threadId: THREAD_ID });

  const changed = h.events.find((e) => e.type === 'timer-changed');
  assert.ok(changed && changed.type === 'timer-changed');
  assert.equal(threadIdOf(changed), THREAD_ID);
  assert.equal(changed.ttlMs, 3_600_000);
  const decoded = decodeContentPayload(h.sessions.encrypted[0]!);
  assert.equal(decoded.threadId, THREAD_ID);
  assert.equal(decoded.payload.type, 'timer');
  // The surface-scoped timer store (keyed by remoteUid) must NOT be written for a shadow timer.
  assert.equal(h.store.timers.has('bob'), false);
});

// --- inbound shadow routing --------------------------------------------------

test('an inbound shadow text envelope routes a threadId-tagged message-appended (5.2)', async () => {
  const h = makeHarness();
  h.sessions.decryptResult = encodeShadowText('see you there', THREAD_ID);
  const envelope: CiphertextEnvelope = {
    senderUid: 'bob',
    recipientUid: 'me',
    senderDeviceId: 'dev-bob',
    seq: SHADOW_SEQ_OFFSET + 5,
    type: 1,
    ciphertext: Buffer.from('x').toString('base64'),
  };
  await h.messaging.onEnvelope(envelope);

  const appended = h.events.at(-1)!;
  assert.equal(appended.type, 'message-appended');
  assert.equal(threadIdOf(appended), THREAD_ID);
  assert.equal(appended.type === 'message-appended' ? appended.message.seq : -1, SHADOW_SEQ_OFFSET + 5);
  assert.equal(h.store.rows.at(-1)!.plaintext, 'see you there');
});

test('an inbound shadow reaction routes a threadId-tagged reaction-applied with the direction flip', async () => {
  const h = makeHarness();
  // Peer reacts to a message that is OUTBOUND in their frame -> INBOUND locally.
  h.sessions.decryptResult = JSON.stringify({
    v: 1,
    type: 'reaction',
    targetSeq: SHADOW_SEQ_OFFSET + 2,
    targetOutbound: true,
    emoji: '🔥',
    threadId: THREAD_ID,
  });
  const envelope: CiphertextEnvelope = {
    senderUid: 'bob',
    recipientUid: 'me',
    senderDeviceId: 'dev-bob',
    seq: SHADOW_SEQ_OFFSET + 9,
    type: 1,
    ciphertext: Buffer.from('x').toString('base64'),
  };
  await h.messaging.onEnvelope(envelope);

  const applied = h.events.find((e) => e.type === 'reaction-applied');
  assert.ok(applied && applied.type === 'reaction-applied', 'reaction-applied must be emitted');
  assert.equal(threadIdOf(applied), THREAD_ID);
  assert.equal(applied.targetDirection, 'in');
});

// helper: encode a shadow text payload the way the sender would.
function encodeShadowText(body: string, threadId: string): string {
  return JSON.stringify({ v: 1, type: 'text', body, threadId });
}
