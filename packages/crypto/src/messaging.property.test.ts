import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import type {
  CiphertextBody,
  ClientToServerFrame,
  ConnectionStatus,
  MessageStatus,
  ServerToClientFrame,
} from '@chat-app/types';

import { createEnvelopeCodec } from './envelope-codec';
import { DefaultMessaging, type MessagingDeps } from './messaging';
import type { MessageRow, Unsubscribe } from './ports';
import type { Scheduler, TimerHandle } from './realtime-client';

class FakeRealtime {
  status: ConnectionStatus = 'connected';
  readonly sent: ClientToServerFrame[] = [];
  private frameL = new Set<(f: ServerToClientFrame) => void>();
  private statusL = new Set<(s: ConnectionStatus) => void>();
  send(f: ClientToServerFrame): void {
    this.sent.push(f);
  }
  getStatus(): ConnectionStatus {
    return this.status;
  }
  onFrame(l: (f: ServerToClientFrame) => void): Unsubscribe {
    this.frameL.add(l);
    return () => this.frameL.delete(l);
  }
  onStatus(l: (s: ConnectionStatus) => void): Unsubscribe {
    this.statusL.add(l);
    return () => this.statusL.delete(l);
  }
  setStatus(s: ConnectionStatus): void {
    this.status = s;
    for (const l of this.statusL) l(s);
  }
  emit(f: ServerToClientFrame): void {
    for (const l of this.frameL) l(f);
  }
}

class FakeScheduler implements Scheduler {
  private seq = 0;
  private timers = new Map<number, () => void>();
  setTimeout(handler: () => void): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, handler);
    return id;
  }
  clearTimeout(h: TimerHandle): void {
    this.timers.delete(h as number);
  }
  runPending(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    for (const fn of fns) fn();
  }
}

function harness() {
  const realtime = new FakeRealtime();
  const scheduler = new FakeScheduler();
  const store = { rows: [] as MessageRow[], status: new Map<string, MessageStatus>() };
  let idc = 0;
  const deps: MessagingDeps = {
    realtime,
    sessions: {
      async hasSession() {
        return true;
      },
      async establishSession() {},
      async encrypt(): Promise<CiphertextBody> {
        return { type: 1, ciphertext: Buffer.from('ct').toString('base64') };
      },
      async decrypt() {
        return 'x';
      },
      async getSafetyNumber() {
        return null;
      },
    },
    sequence: (() => {
      const c = new Map<string, number>();
      return {
        async next(uid: string) {
          const n = (c.get(uid) ?? 0) + 1;
          c.set(uid, n);
          return n;
        },
      };
    })(),
    codec: createEnvelopeCodec(),
    keyClaimer: {
      async claim() {
        return null;
      },
    },
    sender: {
      async resolveSender() {
        return { uid: 'me', deviceId: 'dev-me' };
      },
    },
    store: {
      async appendMessage(row: MessageRow) {
        store.rows.push(row);
        store.status.set(row.id, row.status);
      },
      async updateMessageStatus(id: string, s: MessageStatus) {
        store.status.set(id, s);
      },
      async applyReaction() {},
      async applyEdit() {},
      async applyDelete() {},
      async setConversationTimer() {},
    },
  };
  const messaging = new DefaultMessaging(deps, {
    generateId: () => `id-${++idc}`,
    now: () => 0,
    scheduler,
  });
  return { realtime, scheduler, store, messaging };
}

test('Property 16: a pending send flushes exactly once across reconnect toggles', async () => {
  // Feature: phase1-client-messaging, Property 16: Pending send flushes exactly once
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 12 }),
      fc.array(fc.boolean(), { maxLength: 12 }),
      async (count, toggles) => {
        const h = harness();
        h.realtime.status = 'disconnected';
        for (let i = 0; i < count; i += 1) {
          await h.messaging.send('bob', `m${i}`);
        }
        assert.equal(h.realtime.sent.length, 0, 'nothing sent while disconnected');

        // Apply arbitrary connection toggles, ending connected.
        for (const on of [...toggles, true]) {
          h.realtime.setStatus(on ? 'connected' : 'disconnected');
        }

        // Every message transmitted exactly once; sequence numbers unique.
        assert.equal(h.realtime.sent.length, count);
        const seqs = h.realtime.sent.map((f) => f.envelope.seq);
        assert.equal(new Set(seqs).size, count, 'no duplicate transmissions');
      },
    ),
    { numRuns: 150 },
  );
});

test('Property 17: ack → sent, timeout → failed (text retained)', async () => {
  // Feature: phase1-client-messaging, Property 17: Ack and timeout status transitions
  await fc.assert(
    fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), async (ackFlags) => {
      const h = harness(); // starts connected
      // Send one message per flag; capture each transmitted envelope's (id, seq).
      for (let i = 0; i < ackFlags.length; i += 1) {
        await h.messaging.send('bob', `m${i}`);
      }
      assert.equal(h.realtime.sent.length, ackFlags.length);

      // Ack the chosen ones (by recipient+seq), then fire timers for the rest.
      h.realtime.sent.forEach((frame, i) => {
        if (ackFlags[i]) {
          h.realtime.emit({
            kind: 'ack',
            recipientUid: frame.envelope.recipientUid,
            seq: frame.envelope.seq,
            status: 'received',
          });
        }
      });
      await Promise.resolve();
      h.scheduler.runPending(); // un-acked → failed
      await Promise.resolve();

      // Outbound rows: acked are 'sent', un-acked are 'failed'; text always retained.
      const outRows = h.store.rows.filter((r) => r.direction === 'out');
      assert.equal(outRows.length, ackFlags.length);
      outRows.forEach((row, i) => {
        assert.equal(h.store.status.get(row.id), ackFlags[i] ? 'sent' : 'failed');
        assert.equal(row.plaintext, `m${i}`, 'message text retained in the row');
      });
    }),
    { numRuns: 150 },
  );
});
