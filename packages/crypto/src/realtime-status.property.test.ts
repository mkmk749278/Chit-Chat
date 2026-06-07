import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import type { Unsubscribe, WebSocketHandle, WebSocketTransport } from './ports';
import {
  RealtimeClient,
  type RealtimeAuthService,
  type Scheduler,
  type TimerHandle,
} from './realtime-client';

class FakeHandle implements WebSocketHandle {
  private openL: Array<() => void> = [];
  private closeL: Array<(c: number, r: string) => void> = [];
  send(): void {}
  close(): void {}
  onOpen(l: () => void): Unsubscribe {
    this.openL.push(l);
    return () => undefined;
  }
  onMessage(): Unsubscribe {
    return () => undefined;
  }
  onClose(l: (c: number, r: string) => void): Unsubscribe {
    this.closeL.push(l);
    return () => undefined;
  }
  onError(): Unsubscribe {
    return () => undefined;
  }
  fireOpen(): void {
    for (const l of this.openL) l();
  }
  fireClose(code: number): void {
    for (const l of this.closeL) l(code, '');
  }
}

class FakeTransport implements WebSocketTransport {
  readonly handles: FakeHandle[] = [];
  open(): WebSocketHandle {
    const h = new FakeHandle();
    this.handles.push(h);
    return h;
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

const auth: RealtimeAuthService = {
  getCurrentToken: () => 'tok',
  refreshWithRetry: async () => 'tok',
};

test('Property 14: status is connected iff the socket is open, across many cycles', async () => {
  // Feature: phase1-client-messaging, Property 14: Connection status reflects socket state
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 15 }), async (cycles) => {
      const transport = new FakeTransport();
      const scheduler = new FakeScheduler();
      const client = new RealtimeClient({
        url: 'wss://ws.example.test/s',
        transport,
        auth,
        scheduler,
      });

      const p = client.connect();
      // Connecting (socket not yet open) ⇒ disconnected.
      assert.equal(client.getStatus(), 'disconnected');

      for (let i = 0; i < cycles; i += 1) {
        const handle = transport.handles[transport.handles.length - 1]!;
        handle.fireOpen();
        assert.equal(client.getStatus(), 'connected', 'open ⇒ connected');

        // A non-deliberate close drops to disconnected and schedules a backoff reconnect.
        handle.fireClose(1006);
        assert.equal(client.getStatus(), 'disconnected', 'closed ⇒ disconnected');

        scheduler.runPending(); // advance to the next attempt (opens a fresh handle)
        assert.equal(client.getStatus(), 'disconnected', 'reconnecting ⇒ disconnected');
      }
      await p;
    }),
    { numRuns: 120 },
  );
});
