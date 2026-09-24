import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  CiphertextBody,
  CiphertextEnvelope,
  ClaimedPreKeyBundle,
  ClientToServerFrame,
  ConnectionStatus,
  MessageStatus,
  ServerToClientFrame,
} from '@chat-app/types';

import { createEnvelopeCodec } from './envelope-codec';
import { DefaultMessaging, MAX_REMEMBERED_ENVELOPE_IDS } from './messaging';
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

// Reliable delivery (realtime protocol v2): a `deliver` frame carrying a server inbox `id` is
// processed at most once per device and confirmed with a `delivered` frame only after it was
// durably handled — so the server can replay unconfirmed entries without producing duplicates or
// spurious "could not decrypt" rows.

class FakeRealtime implements MessagingRealtime {
  status: ConnectionStatus = 'connected';
  readonly frames: ClientToServerFrame[] = [];
  connected = true;
  private readonly frameListeners = new Set<(frame: ServerToClientFrame) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();

  send(frame: ClientToServerFrame): void {
    if (!this.connected) {
      throw new Error('RealtimeClient: cannot send while not connected');
    }
    this.frames.push(frame);
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
  emitFrame(frame: ServerToClientFrame): void {
    for (const l of this.frameListeners) l(frame);
  }
  delivered(): string[] {
    return this.frames.flatMap((f) => (f.kind === 'delivered' ? f.ids : []));
  }
}

class FakeSessions implements SessionManager {
  decryptCount = 0;
  decryptResult: string | Error = 'hello';
  async hasSession(): Promise<boolean> {
    return true;
  }
  async establishSession(): Promise<void> {}
  async encrypt(): Promise<CiphertextBody> {
    return { type: 1, ciphertext: 'Y3Q=' };
  }
  async decrypt(): Promise<string> {
    this.decryptCount += 1;
    if (this.decryptResult instanceof Error) throw this.decryptResult;
    return this.decryptResult;
  }
  async getSafetyNumber(): Promise<null> {
    return null;
  }
}

class FakeSequence implements SequenceAllocator {
  async next(): Promise<number> {
    return 1;
  }
}

class FakeClaimer implements PreKeyClaimClient {
  async claim(): Promise<ClaimedPreKeyBundle | null> {
    return null;
  }
}

class FakeSender implements LocalSenderResolver {
  async resolveSender(): Promise<{ uid: string; deviceId: string } | null> {
    return { uid: 'me', deviceId: 'dev-me' };
  }
}

class FakeStore implements MessagingStore {
  readonly rows: MessageRow[] = [];
  /** Persisted processed ids; `undefined` models a store without the optional methods. */
  processed: Set<string> | undefined = new Set<string>();
  failAppend = false;
  async appendMessage(row: MessageRow): Promise<void> {
    if (this.failAppend) throw new Error('disk full');
    this.rows.push(row);
  }
  async updateMessageStatus(_id: string, _status: MessageStatus): Promise<void> {}
  async applyReaction(): Promise<void> {}
  async applyEdit(): Promise<void> {}
  async applyDelete(): Promise<void> {}
  async setConversationTimer(): Promise<void> {}
  async loadMessages(): Promise<MessageRow[]> {
    return [];
  }
  async purgeMessages(): Promise<void> {}
}

/** A store exposing the optional persisted-dedupe methods. */
class PersistentDedupeStore extends FakeStore {
  async hasProcessedEnvelope(id: string): Promise<boolean> {
    return this.processed?.has(id) ?? false;
  }
  async markEnvelopeProcessed(id: string): Promise<void> {
    this.processed?.add(id);
  }
}

class FakeScheduler implements Scheduler {
  setTimeout(): TimerHandle {
    return 0;
  }
  clearTimeout(): void {}
}

function envelope(seq: number): CiphertextEnvelope {
  return { senderUid: 'bob', recipientUid: 'me', senderDeviceId: 'dev-bob', seq, type: 1, ciphertext: 'Y3Q=' };
}

function makeHarness(store: FakeStore = new PersistentDedupeStore()) {
  let n = 0;
  const realtime = new FakeRealtime();
  const sessions = new FakeSessions();
  const deps: MessagingDeps = {
    realtime,
    sessions,
    sequence: new FakeSequence(),
    codec: createEnvelopeCodec(),
    keyClaimer: new FakeClaimer(),
    sender: new FakeSender(),
    store,
  };
  const messaging = new DefaultMessaging(deps, {
    generateId: () => `row-${++n}`,
    now: () => 1000,
    scheduler: new FakeScheduler(),
  });
  return { realtime, sessions, store, messaging };
}

/** Let the per-peer processing chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test('a delivered envelope with an inbox id is processed, then confirmed with that id', async () => {
  const h = makeHarness();

  h.realtime.emitFrame({ kind: 'deliver', envelope: envelope(1), id: '10-0' });
  await settle();

  assert.equal(h.store.rows.length, 1);
  assert.equal(h.store.rows[0]!.plaintext, 'hello');
  assert.deepEqual(h.realtime.delivered(), ['10-0']);
  assert.ok(h.store.processed?.has('10-0'), 'the id is persisted for relaunch dedupe');
});

test('the same inbox id delivered twice (live + replay) is decrypted once but confirmed both times', async () => {
  const h = makeHarness();

  h.realtime.emitFrame({ kind: 'deliver', envelope: envelope(1), id: '10-0' });
  h.realtime.emitFrame({ kind: 'deliver', envelope: envelope(1), id: '10-0' });
  await settle();

  assert.equal(h.sessions.decryptCount, 1, 'a second decrypt would fail and show an error row');
  assert.equal(h.store.rows.length, 1, 'no duplicate message');
  assert.deepEqual(h.realtime.delivered(), ['10-0', '10-0']);
});

test('a replay after a relaunch is skipped via the persisted dedupe set', async () => {
  const store = new PersistentDedupeStore();
  store.processed?.add('10-0'); // processed before the app was killed, confirmation never sent
  const h = makeHarness(store);

  h.realtime.emitFrame({ kind: 'deliver', envelope: envelope(1), id: '10-0' });
  await settle();

  assert.equal(h.sessions.decryptCount, 0);
  assert.equal(h.store.rows.length, 0);
  assert.deepEqual(h.realtime.delivered(), ['10-0']);
});

test('without persisted dedupe the in-memory set still dedupes within the session', async () => {
  const h = makeHarness(new FakeStore());

  h.realtime.emitFrame({ kind: 'deliver', envelope: envelope(1), id: '10-0' });
  await settle();
  h.realtime.emitFrame({ kind: 'deliver', envelope: envelope(1), id: '10-0' });
  await settle();

  assert.equal(h.sessions.decryptCount, 1);
  assert.equal(h.store.rows.length, 1);
});

test('a legacy deliver frame (no id) is processed and never confirmed', async () => {
  const h = makeHarness();

  h.realtime.emitFrame({ kind: 'deliver', envelope: envelope(1) });
  await settle();

  assert.equal(h.store.rows.length, 1);
  assert.deepEqual(h.realtime.delivered(), []);
});

test('an undecryptable envelope is recorded as a delivery error AND confirmed (a replay cannot fix it)', async () => {
  const h = makeHarness();
  h.sessions.decryptResult = new Error('bad mac');

  h.realtime.emitFrame({ kind: 'deliver', envelope: envelope(1), id: '10-0' });
  await settle();

  assert.equal(h.store.rows[0]!.status, 'delivery-error');
  assert.deepEqual(h.realtime.delivered(), ['10-0']);
});

test('a processing failure leaves the entry unconfirmed so the server replays it', async () => {
  const h = makeHarness();
  h.store.failAppend = true;

  h.realtime.emitFrame({ kind: 'deliver', envelope: envelope(1), id: '10-0' });
  await settle();

  assert.deepEqual(h.realtime.delivered(), []);
  assert.equal(h.store.processed?.has('10-0'), false);
});

test('a confirmation that cannot be sent (socket dropped) is re-sent when the entry is replayed', async () => {
  const h = makeHarness();
  h.realtime.connected = false;

  h.realtime.emitFrame({ kind: 'deliver', envelope: envelope(1), id: '10-0' });
  await settle();
  assert.equal(h.store.rows.length, 1, 'processing does not depend on the confirmation');
  assert.deepEqual(h.realtime.delivered(), []);

  h.realtime.connected = true; // reconnect → server replays the unconfirmed entry
  h.realtime.emitFrame({ kind: 'deliver', envelope: envelope(1), id: '10-0' });
  await settle();

  assert.equal(h.sessions.decryptCount, 1);
  assert.deepEqual(h.realtime.delivered(), ['10-0']);
});

test('the in-memory dedupe set is bounded', () => {
  assert.ok(MAX_REMEMBERED_ENVELOPE_IDS >= 1000, 'must cover a full server inbox replay');
});
