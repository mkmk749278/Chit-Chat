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

import type { ConversationEvent } from './conversation-reducer';
import { createEnvelopeCodec } from './envelope-codec';
import { DefaultMessaging, DEFAULT_ACK_TIMEOUT_MS } from './messaging';
import type {
  LocalSenderResolver,
  MessagingDeps,
  MessagingRealtime,
  MessagingStore,
  PreKeyClaimClient,
} from './messaging';
import type { MessageRow, Unsubscribe } from './ports';
import type { Scheduler, TimerHandle } from './realtime-client';
import type { SequenceAllocator } from './sequence-allocator';
import type { SessionManager } from './session-manager';

// --- fakes -------------------------------------------------------------------

class FakeRealtime implements MessagingRealtime {
  status: ConnectionStatus = 'connected';
  readonly sent: ClientToServerFrame[] = [];
  /** When set, the next `send` throws once (simulating a socket racing to closed). */
  throwOnNextSend = false;
  private readonly frameListeners = new Set<(frame: ServerToClientFrame) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();

  send(frame: ClientToServerFrame): void {
    if (this.throwOnNextSend) {
      this.throwOnNextSend = false;
      throw new Error('socket closed');
    }
    this.sent.push(frame);
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

class FakeSessions implements SessionManager {
  private readonly sessions = new Set<string>();
  establishCount = 0;
  failEstablish = false;
  failEncrypt = false;
  decryptResult: string | Error = 'decrypted';

  async hasSession(recipientUid: string): Promise<boolean> {
    return this.sessions.has(recipientUid);
  }
  async establishSession(recipientUid: string): Promise<void> {
    this.establishCount += 1;
    if (this.failEstablish) throw new Error('establish failed');
    this.sessions.add(recipientUid);
  }
  async encrypt(): Promise<CiphertextBody> {
    if (this.failEncrypt) throw new Error('encrypt failed');
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

class FakeSequence implements SequenceAllocator {
  private readonly counters = new Map<string, number>();
  async next(recipientUid: string): Promise<number> {
    const next = (this.counters.get(recipientUid) ?? 0) + 1;
    this.counters.set(recipientUid, next);
    return next;
  }
}

class FakeClaimer implements PreKeyClaimClient {
  result: ClaimedPreKeyBundle | null = bundle('dev-recipient');
  claimCount = 0;
  async claim(): Promise<ClaimedPreKeyBundle | null> {
    this.claimCount += 1;
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
  async appendMessage(row: MessageRow): Promise<void> {
    this.rows.push(row);
  }
  async updateMessageStatus(id: string, status: MessageStatus): Promise<void> {
    this.statuses.push({ id, status });
  }
}

/** A controllable scheduler: timers fire only when {@link runPending} is called. */
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
  sessions: FakeSessions;
  claimer: FakeClaimer;
  sender: FakeSender;
  store: FakeStore;
  scheduler: FakeScheduler;
  events: ConversationEvent[];
  messaging: DefaultMessaging;
}

let idCounter = 0;

function makeHarness(): Harness {
  idCounter = 0;
  const realtime = new FakeRealtime();
  const sessions = new FakeSessions();
  const claimer = new FakeClaimer();
  const sender = new FakeSender();
  const store = new FakeStore();
  const scheduler = new FakeScheduler();
  const events: ConversationEvent[] = [];

  const deps: MessagingDeps = {
    realtime,
    sessions,
    sequence: new FakeSequence(),
    codec: createEnvelopeCodec(),
    keyClaimer: claimer,
    sender,
    store,
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

// --- send happy path ---------------------------------------------------------

test('send while connected transmits a send frame and renders sending (5.2, 6.2)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'hello');

  assert.equal(h.realtime.sent.length, 1);
  const frame = h.realtime.sent[0]!;
  assert.equal(frame.kind, 'send');
  assert.equal(frame.envelope.senderUid, 'me');
  assert.equal(frame.envelope.recipientUid, 'bob');
  assert.equal(frame.envelope.senderDeviceId, 'dev-me');
  assert.equal(frame.envelope.seq, 1);
  // optimistic row appended as sending
  assert.equal(h.store.rows.length, 1);
  assert.equal(h.store.rows[0]!.status, 'sending');
  assert.equal(h.store.rows[0]!.plaintext, 'hello');
  assert.deepEqual(h.events[0], {
    type: 'message-appended',
    message: { id: 'id-1', seq: 1, direction: 'out', text: 'hello', status: 'sending' },
    remoteUid: 'bob',
  });
});

test('no plaintext field appears on the serialized send frame (5.3, 5.7, 8.2)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'secret-plaintext');
  const serialized = JSON.stringify(h.realtime.sent[0]);
  assert.ok(!serialized.includes('secret-plaintext'));
});

test('ack within deadline transitions sending -> sent (5.6)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'hi');
  const envelope = h.realtime.sent[0]!.envelope;

  h.realtime.emitFrame(ackFor(envelope));
  await Promise.resolve();

  assert.deepEqual(h.store.statuses.at(-1), { id: 'id-1', status: 'sent' });
  assert.deepEqual(h.events.at(-1), { type: 'status-updated', id: 'id-1', status: 'sent', remoteUid: 'bob' });
  // ack timer was cleared
  assert.equal(h.scheduler.count, 0);
});

test('ack-timeout transitions sending -> failed and retains text (5.11, 6.8)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'hi');
  assert.equal(h.scheduler.count, 1);

  h.scheduler.runPending();
  await Promise.resolve();

  assert.deepEqual(h.store.statuses.at(-1), { id: 'id-1', status: 'failed' });
  // text retained in the appended row (never removed)
  assert.equal(h.store.rows[0]!.plaintext, 'hi');
});

test('default ack timeout is 30 seconds (5.6, 5.11)', () => {
  assert.equal(DEFAULT_ACK_TIMEOUT_MS, 30_000);
});

// --- session establishment ---------------------------------------------------

test('first send claims + establishes a session; second send reuses it (5.1)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'one');
  await h.messaging.send('bob', 'two');

  assert.equal(h.claimer.claimCount, 1);
  assert.equal(h.sessions.establishCount, 1);
  assert.equal(h.realtime.sent.length, 2);
});

test('no recipient device (claim null) marks failed and transmits nothing (5.9)', async () => {
  const h = makeHarness();
  h.claimer.result = null;
  await h.messaging.send('ghost', 'hello');

  assert.equal(h.realtime.sent.length, 0);
  assert.deepEqual(h.store.statuses.at(-1), { id: 'id-1', status: 'failed' });
});

test('encrypt failure marks failed and transmits nothing (5.9)', async () => {
  const h = makeHarness();
  h.sessions.failEncrypt = true;
  await h.messaging.send('bob', 'hello');

  assert.equal(h.realtime.sent.length, 0);
  assert.deepEqual(h.store.statuses.at(-1), { id: 'id-1', status: 'failed' });
});

test('missing sender identity marks failed and transmits nothing (5.9)', async () => {
  const h = makeHarness();
  h.sender.value = null;
  await h.messaging.send('bob', 'hello');

  assert.equal(h.realtime.sent.length, 0);
  assert.deepEqual(h.store.statuses.at(-1), { id: 'id-1', status: 'failed' });
});

// --- pending-send / flush (Property 16) -------------------------------------

test('send while disconnected holds pending; flushes once on reconnect (5.10)', async () => {
  const h = makeHarness();
  h.realtime.status = 'disconnected';
  await h.messaging.send('bob', 'queued');

  assert.equal(h.realtime.sent.length, 0, 'nothing transmitted while disconnected');
  assert.equal(h.store.rows[0]!.status, 'sending');

  h.realtime.setStatus('connected');
  assert.equal(h.realtime.sent.length, 1, 'flushed exactly once on reconnect');
});

test('pending send flushes exactly once across repeated reconnects (Property 16, 5.10)', async () => {
  const h = makeHarness();
  h.realtime.status = 'disconnected';
  await h.messaging.send('bob', 'm');

  h.realtime.setStatus('connected');
  h.realtime.setStatus('disconnected');
  h.realtime.setStatus('connected');

  assert.equal(h.realtime.sent.length, 1, 'transmitted exactly once, never duplicated');
});

test('a transmit that throws keeps the message queued for the next flush (5.10)', async () => {
  const h = makeHarness();
  h.realtime.throwOnNextSend = true;
  await h.messaging.send('bob', 'm');

  assert.equal(h.realtime.sent.length, 0, 'throw means not transmitted');
  assert.equal(h.scheduler.count, 0, 'no ack timer armed for an un-transmitted send');

  h.realtime.setStatus('connected');
  assert.equal(h.realtime.sent.length, 1, 'flushed on next reconnect, exactly once');
});

test('acked messages are not re-sent on a later reconnect', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'm');
  h.realtime.emitFrame(ackFor(h.realtime.sent[0]!.envelope));
  await Promise.resolve();

  h.realtime.setStatus('disconnected');
  h.realtime.setStatus('connected');
  assert.equal(h.realtime.sent.length, 1);
});

// --- onEnvelope --------------------------------------------------------------

test('onEnvelope decrypts and renders inbound plaintext as received (5.4)', async () => {
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

  assert.equal(h.store.rows.at(-1)!.plaintext, 'hi back');
  assert.equal(h.store.rows.at(-1)!.status, 'received');
  assert.deepEqual(h.events.at(-1), {
    type: 'message-appended',
    message: { id: 'id-1', seq: 7, direction: 'in', text: 'hi back', status: 'received' },
    remoteUid: 'bob',
  });
});

test('onEnvelope on decrypt failure renders no plaintext + delivery-error (5.5, 6.9)', async () => {
  const h = makeHarness();
  h.sessions.decryptResult = new Error('bad ciphertext');
  const envelope: CiphertextEnvelope = {
    senderUid: 'bob',
    recipientUid: 'me',
    senderDeviceId: 'dev-bob',
    seq: 9,
    type: 1,
    ciphertext: Buffer.from('x').toString('base64'),
  };
  await h.messaging.onEnvelope(envelope);

  assert.equal(h.store.rows.at(-1)!.plaintext, null);
  assert.equal(h.store.rows.at(-1)!.status, 'delivery-error');
  assert.deepEqual(h.events.at(-1), { type: 'inbound-delivery-error', id: 'id-1', seq: 9, remoteUid: 'bob' });
});

test('an inbound deliver frame routes through onEnvelope', async () => {
  const h = makeHarness();
  h.sessions.decryptResult = 'via frame';
  const envelope: CiphertextEnvelope = {
    senderUid: 'bob',
    recipientUid: 'me',
    senderDeviceId: 'dev-bob',
    seq: 3,
    type: 1,
    ciphertext: Buffer.from('x').toString('base64'),
  };
  h.realtime.emitFrame({ kind: 'deliver', envelope });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.store.rows.at(-1)!.plaintext, 'via frame');
});

// --- dispose -----------------------------------------------------------------

test('dispose detaches transport listeners and cancels ack timers', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'm');
  assert.equal(h.scheduler.count, 1);

  h.messaging.dispose();
  assert.equal(h.scheduler.count, 0);

  // After dispose, transport events are ignored.
  h.realtime.setStatus('connected');
  h.realtime.emitFrame(ackFor(h.realtime.sent[0]!.envelope));
  await Promise.resolve();
  assert.ok(!h.store.statuses.some((s) => s.status === 'sent'));
});
