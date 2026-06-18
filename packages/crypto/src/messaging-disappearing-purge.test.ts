/**
 * `@chat-app/crypto` — disappearing-message purge engine (Phase 2, Requirement 4.2).
 *
 * Drives {@link DefaultMessaging} with a controllable scheduler + store double and asserts that
 * timed messages are erased from the store and removed from the UI (via a `messages-expired`
 * event) once their timer elapses — on send, on receive, and re-armed from persisted rows on a
 * fresh construction (relaunch).
 */

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
import {
  DefaultMessaging,
  type MessagingDeps,
  type MessagingRealtime,
  type MessagingStore,
} from './messaging';
import type { MessageRow } from './ports';
import type { Scheduler, TimerHandle } from './realtime-client';
import type { SessionManager } from './session-manager';
import type { SequenceAllocator } from './sequence-allocator';

/** A scheduler whose timers fire only when {@link advance} crosses their due time. */
class FakeScheduler implements Scheduler {
  now = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, delayMs: number): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + delayMs, fn });
    return id;
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }
  /** Advance virtual time, firing every timer whose due time has passed (re-arming included). */
  advance(ms: number): void {
    this.now += ms;
    let fired = true;
    while (fired) {
      fired = false;
      for (const [id, t] of [...this.timers.entries()]) {
        if (t.at <= this.now) {
          this.timers.delete(id);
          fired = true;
          t.fn();
        }
      }
    }
  }
}

class FakeRealtime implements MessagingRealtime {
  status: ConnectionStatus = 'connected';
  private frameListeners = new Set<(f: ServerToClientFrame) => void>();
  sent: ClientToServerFrame[] = [];
  send(frame: ClientToServerFrame): void {
    if (this.status !== 'connected') {
      throw new Error('socket not open');
    }
    this.sent.push(frame);
  }
  getStatus(): ConnectionStatus {
    return this.status;
  }
  onFrame(l: (f: ServerToClientFrame) => void): () => void {
    this.frameListeners.add(l);
    return () => this.frameListeners.delete(l);
  }
  onStatus(): () => void {
    return () => undefined;
  }
  deliver(frame: ServerToClientFrame): void {
    for (const l of this.frameListeners) l(frame);
  }
}

class FakeStore implements MessagingStore {
  readonly rows = new Map<string, MessageRow>();
  readonly timers = new Map<string, number>();
  constructor(seed: MessageRow[] = []) {
    for (const r of seed) this.rows.set(r.id, { ...r });
  }
  async appendMessage(row: MessageRow): Promise<void> {
    this.rows.set(row.id, { ...row });
  }
  async updateMessageStatus(id: string, status: MessageStatus): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.status = status;
  }
  async applyReaction(): Promise<void> {}
  async applyEdit(): Promise<void> {}
  async applyDelete(): Promise<void> {}
  async setConversationTimer(remoteUid: string, ttlMs: number): Promise<void> {
    this.timers.set(remoteUid, ttlMs);
  }
  async loadMessages(): Promise<MessageRow[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async purgeMessages(ids: string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
}

const sessions: SessionManager = {
  async hasSession() {
    return true;
  },
  async establishSession() {},
  async encrypt(): Promise<CiphertextBody> {
    return { type: 1, ciphertext: Buffer.from('ct').toString('base64') };
  },
  async decrypt() {
    return 'hello';
  },
  async getSafetyNumber() {
    return null;
  },
};

const sequence: SequenceAllocator = (() => {
  const c = new Map<string, number>();
  return {
    async next(uid: string) {
      const n = (c.get(uid) ?? 0) + 1;
      c.set(uid, n);
      return n;
    },
  };
})();

const codec = {
  encode: (
    meta: { senderUid: string; recipientUid: string; senderDeviceId: string; seq: number },
    body: CiphertextBody,
  ): CiphertextEnvelope => ({ ...meta, type: body.type, ciphertext: body.ciphertext }),
  decode: (envelope: CiphertextEnvelope) => ({
    routing: {
      senderUid: envelope.senderUid,
      recipientUid: envelope.recipientUid,
      senderDeviceId: envelope.senderDeviceId,
      seq: envelope.seq,
    },
    body: { type: envelope.type, ciphertext: envelope.ciphertext },
  }),
};

const keyClaimer = {
  async claim(): Promise<ClaimedPreKeyBundle | null> {
    return null;
  },
};
const sender = {
  async resolveSender() {
    return { uid: 'me', deviceId: 'dev-me' };
  },
};

/** Let queued microtasks (the async purge) settle after the scheduler fires a timer. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function make(store: FakeStore): {
  messaging: DefaultMessaging;
  scheduler: FakeScheduler;
  events: ConversationEvent[];
  realtime: FakeRealtime;
} {
  const scheduler = new FakeScheduler();
  const events: ConversationEvent[] = [];
  const realtime = new FakeRealtime();
  const deps: MessagingDeps = {
    realtime,
    sessions,
    sequence,
    codec,
    keyClaimer,
    sender,
    store,
  };
  let idc = 0;
  const messaging = new DefaultMessaging(deps, {
    generateId: () => `id-${++idc}`,
    now: () => scheduler.now,
    scheduler,
  });
  messaging.onConversationUpdate((e) => events.push(e));
  return { messaging, scheduler, events, realtime };
}

test('sendTyping transmits a typing frame; onTyping surfaces inbound typing (Req 5.3)', () => {
  const store = new FakeStore();
  const { messaging, realtime } = make(store);
  messaging.sendTyping('bob');
  assert.deepEqual(realtime.sent.at(-1), { kind: 'typing', recipientUid: 'bob' });

  const seen: string[] = [];
  messaging.onTyping((from) => seen.push(from));
  realtime.deliver({ kind: 'typing', fromUid: 'bob' });
  assert.deepEqual(seen, ['bob']);
});

test('sendTyping is a no-op while disconnected (Req 5.3)', () => {
  const store = new FakeStore();
  const { messaging, realtime } = make(store);
  realtime.status = 'disconnected';
  messaging.sendTyping('bob');
  assert.equal(realtime.sent.some((f) => f.kind === 'typing'), false);
});

test('an outbound timed message is purged from the store and UI after its timer', async () => {
  const store = new FakeStore();
  const { messaging, scheduler, events } = make(store);
  await messaging.setDisappearingTimer('bob', 1000);
  await messaging.send('bob', 'secret');
  // Row exists with an expiry one second out.
  const sent = [...store.rows.values()].find((r) => r.plaintext === 'secret');
  assert.ok(sent);
  assert.equal(sent?.expiresAt, 1000);

  scheduler.advance(999);
  await flush();
  assert.equal([...store.rows.values()].some((r) => r.plaintext === 'secret'), true);

  scheduler.advance(1);
  await flush();
  // Purged from the store and a removal event emitted for bob's conversation.
  assert.equal([...store.rows.values()].some((r) => r.plaintext === 'secret'), false);
  const expired = events.filter((e) => e.type === 'messages-expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].type === 'messages-expired' && expired[0].remoteUid, 'bob');
});

test('an inbound timed message expires from receive time', async () => {
  const store = new FakeStore();
  const { messaging, scheduler, events } = make(store);
  await messaging.setDisappearingTimer('bob', 500);
  await messaging.onEnvelope({
    senderUid: 'bob',
    recipientUid: 'me',
    senderDeviceId: 'dev-bob',
    seq: 1,
    type: 1,
    ciphertext: Buffer.from('ct').toString('base64'),
  });
  assert.equal([...store.rows.values()].length, 1);
  scheduler.advance(500);
  await flush();
  assert.equal([...store.rows.values()].length, 0);
  assert.equal(events.some((e) => e.type === 'messages-expired'), true);
});

test('persisted expired rows are purged on construction (relaunch)', async () => {
  // A row whose expiry already passed before this process started.
  const store = new FakeStore([
    { id: 'old', remoteUid: 'bob', direction: 'out', seq: 1, plaintext: 'stale', status: 'sent', createdAt: 0, expiresAt: 10 },
  ]);
  const { scheduler } = make(store);
  // initPurgeSchedule runs async in the constructor; let it load rows + arm the timer.
  await flush();
  scheduler.advance(10);
  await flush();
  assert.equal(store.rows.has('old'), false);
});

test('a message with no timer is never purged', async () => {
  const store = new FakeStore();
  const { messaging, scheduler } = make(store);
  await messaging.send('bob', 'permanent');
  scheduler.advance(10_000_000);
  assert.equal([...store.rows.values()].some((r) => r.plaintext === 'permanent'), true);
});

test('send({ viewOnce }) stamps the row and the emitted message (Req 4.3)', async () => {
  const store = new FakeStore();
  const { messaging, events } = make(store);
  await messaging.send('bob', 'peek', { viewOnce: true });
  const row = [...store.rows.values()].find((r) => r.plaintext === 'peek');
  assert.equal(row?.viewOnce, true);
  const appended = events.find((e) => e.type === 'message-appended');
  assert.equal(appended?.type === 'message-appended' && appended.message.viewOnce, true);
});
