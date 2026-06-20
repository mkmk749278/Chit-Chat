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
import { DefaultMessaging } from './messaging';
import type {
  LocalSenderResolver,
  MessagingDeps,
  MessagingRealtime,
  MessagingStore,
  PreKeyClaimClient,
} from './messaging';
import type { MessageRow, Unsubscribe } from './ports';
import type { SessionManager } from './session-manager';
import type { SequenceAllocator } from './sequence-allocator';

/**
 * Unit tests for Task 5.7: `messaging.ts` threads `MessageRow.createdAt` into the emitted
 * `message-appended` events (outbound + inbound), and a failed-decrypt `inbound-delivery-error`
 * row is stamped with the receive time (Requirement 2.6). A monotonic clock proves the emitted
 * value is the row's `createdAt`, not a hard-coded constant.
 */

class FakeRealtime implements MessagingRealtime {
  status: ConnectionStatus = 'connected';
  readonly sent: Extract<ClientToServerFrame, { kind: 'send' }>[] = [];
  send(frame: ClientToServerFrame): void {
    if (frame.kind === 'send') this.sent.push(frame);
  }
  getStatus(): ConnectionStatus {
    return this.status;
  }
  onFrame(): Unsubscribe {
    return () => undefined;
  }
  onStatus(): Unsubscribe {
    return () => undefined;
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
  decryptResult: string | Error = 'decrypted';
  async hasSession(): Promise<boolean> {
    return false;
  }
  async establishSession(): Promise<void> {
    /* no-op */
  }
  async encrypt(): Promise<CiphertextBody> {
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
  async claim(): Promise<ClaimedPreKeyBundle | null> {
    return bundle('dev-recipient');
  }
}

class FakeSender implements LocalSenderResolver {
  async resolveSender(): Promise<{ uid: string; deviceId: string } | null> {
    return { uid: 'me', deviceId: 'dev-me' };
  }
}

class FakeStore implements MessagingStore {
  readonly rows: MessageRow[] = [];
  async appendMessage(row: MessageRow): Promise<void> {
    this.rows.push(row);
  }
  async updateMessageStatus(): Promise<void> {
    /* no-op */
  }
  async applyReaction(): Promise<void> {
    /* no-op */
  }
  async applyEdit(): Promise<void> {
    /* no-op */
  }
  async applyDelete(): Promise<void> {
    /* no-op */
  }
  async setConversationTimer(): Promise<void> {
    /* no-op */
  }
  async loadMessages(): Promise<MessageRow[]> {
    return this.rows.map((r) => ({ ...r }));
  }
  async purgeMessages(): Promise<void> {
    /* no-op */
  }
}

interface Harness {
  store: FakeStore;
  events: ConversationEvent[];
  messaging: DefaultMessaging;
  sessions: FakeSessions;
}

/** Build a harness with a monotonic clock so each stamped `createdAt` is distinct. */
function makeHarness(): Harness {
  const store = new FakeStore();
  const sessions = new FakeSessions();
  const events: ConversationEvent[] = [];
  let clock = 10_000;
  const deps: MessagingDeps = {
    realtime: new FakeRealtime(),
    sessions,
    sequence: new FakeSequence(),
    codec: createEnvelopeCodec(),
    keyClaimer: new FakeClaimer(),
    sender: new FakeSender(),
    store,
  };
  let idCounter = 0;
  const messaging = new DefaultMessaging(deps, {
    generateId: () => `id-${++idCounter}`,
    now: () => (clock += 1),
  });
  messaging.onConversationUpdate((e) => events.push(e));
  return { store, events, messaging, sessions };
}

const inboundEnvelope = (seq: number): CiphertextEnvelope => ({
  senderUid: 'bob',
  recipientUid: 'me',
  senderDeviceId: 'dev-bob',
  seq,
  type: 1,
  ciphertext: Buffer.from('x').toString('base64'),
});

function appended(events: ConversationEvent[]): Extract<ConversationEvent, { type: 'message-appended' }>[] {
  return events.filter((e): e is Extract<ConversationEvent, { type: 'message-appended' }> => e.type === 'message-appended');
}

const STATUS_SENDING: MessageStatus = 'sending';

test('outbound message-appended carries the row createdAt (2.6)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'hello');

  const outRow = h.store.rows.find((r) => r.direction === 'out');
  assert.ok(outRow, 'an outbound row was appended');
  assert.equal(typeof outRow!.createdAt, 'number');

  const ev = appended(h.events).find((e) => e.message.direction === 'out');
  assert.ok(ev, 'an outbound message-appended event was emitted');
  assert.equal(ev!.message.createdAt, outRow!.createdAt, 'emitted createdAt equals the MessageRow.createdAt');
  assert.equal(ev!.message.status, STATUS_SENDING);
});

test('inbound message-appended carries the row createdAt (2.6)', async () => {
  const h = makeHarness();
  h.sessions.decryptResult = 'hi back';
  await h.messaging.onEnvelope(inboundEnvelope(7));

  const inRow = h.store.rows.find((r) => r.direction === 'in');
  assert.ok(inRow, 'an inbound row was appended');
  assert.equal(typeof inRow!.createdAt, 'number');

  const ev = appended(h.events).find((e) => e.message.direction === 'in');
  assert.ok(ev, 'an inbound message-appended event was emitted');
  assert.equal(ev!.message.createdAt, inRow!.createdAt, 'emitted createdAt equals the MessageRow.createdAt');
});

test('failed-decrypt inbound-delivery-error row and event get a createdAt (2.6)', async () => {
  const h = makeHarness();
  h.sessions.decryptResult = new Error('bad ciphertext');
  await h.messaging.onEnvelope(inboundEnvelope(9));

  // The persisted delivery-error row is stamped with the receive time.
  const errRow = h.store.rows.find((r) => r.status === 'delivery-error');
  assert.ok(errRow, 'a delivery-error row was appended');
  assert.equal(typeof errRow!.createdAt, 'number');
  assert.equal(errRow!.plaintext, null);

  // The emitted event carries that same receive time so the row sorts in place, not at the top.
  const ev = h.events.find(
    (e): e is Extract<ConversationEvent, { type: 'inbound-delivery-error' }> => e.type === 'inbound-delivery-error',
  );
  assert.ok(ev, 'an inbound-delivery-error event was emitted');
  assert.equal(ev!.createdAt, errRow!.createdAt, 'event createdAt equals the row receive time');
});

test('distinct rows get distinct createdAt under a monotonic clock (sanity)', async () => {
  const h = makeHarness();
  await h.messaging.send('bob', 'first');
  h.sessions.decryptResult = 'reply';
  await h.messaging.onEnvelope(inboundEnvelope(1));

  const stamps = appended(h.events).map((e) => e.message.createdAt);
  assert.equal(stamps.length, 2);
  assert.notEqual(stamps[0], stamps[1], 'createdAt is sourced from the clock per row, not a constant');
});
