import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ClientToServerFrame } from '@chat-app/types';

import type { Unsubscribe, WebSocketHandle, WebSocketTransport } from './ports';
import {
  classifyReconnect,
  CLOSE_CODE_AUTH_UNAVAILABLE,
  CLOSE_CODE_RATE_LIMITED,
  CLOSE_CODE_UNAUTHORIZED,
  RealtimeClient,
  type RealtimeAuthService,
  type Scheduler,
  type TimerHandle,
} from './realtime-client';

const URL = 'wss://ws.example.test/socket';

// Feature: phase1-client-messaging, Property 13: Close-code-driven reconnect classification.

test('client-initiated close never reconnects, regardless of code (Property 13)', () => {
  for (const code of [1000, CLOSE_CODE_UNAUTHORIZED, CLOSE_CODE_AUTH_UNAVAILABLE, 4500]) {
    assert.equal(classifyReconnect(code, true), 'no-reconnect');
  }
});

test('4401 maps to refresh-reconnect; everything else non-deliberate maps to backoff (Property 13)', () => {
  assert.equal(classifyReconnect(CLOSE_CODE_UNAUTHORIZED, false), 'refresh-reconnect');
  assert.equal(classifyReconnect(CLOSE_CODE_AUTH_UNAVAILABLE, false), 'backoff-reconnect');
  assert.equal(classifyReconnect(CLOSE_CODE_RATE_LIMITED, false), 'backoff-reconnect');
  assert.equal(classifyReconnect(1006, false), 'backoff-reconnect');
  assert.equal(classifyReconnect(1000, false), 'backoff-reconnect');
});

// --- state-machine harness ---------------------------------------------------

class FakeHandle implements WebSocketHandle {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private openL: Array<() => void> = [];
  private msgL: Array<(d: string) => void> = [];
  private closeL: Array<(c: number, r: string) => void> = [];
  private errL: Array<(e: unknown) => void> = [];

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  onOpen(l: () => void): Unsubscribe {
    this.openL.push(l);
    return () => undefined;
  }
  onMessage(l: (d: string) => void): Unsubscribe {
    this.msgL.push(l);
    return () => undefined;
  }
  onClose(l: (c: number, r: string) => void): Unsubscribe {
    this.closeL.push(l);
    return () => undefined;
  }
  onError(l: (e: unknown) => void): Unsubscribe {
    this.errL.push(l);
    return () => undefined;
  }
  fireOpen(): void {
    for (const l of this.openL) l();
  }
  fireMessage(d: string): void {
    for (const l of this.msgL) l(d);
  }
  fireClose(code: number, reason = ''): void {
    for (const l of this.closeL) l(code, reason);
  }
}

class FakeTransport implements WebSocketTransport {
  readonly handles: FakeHandle[] = [];
  lastUrl = '';
  lastSubprotocols: string[] = [];
  open(url: string, subprotocols: string[]): WebSocketHandle {
    this.lastUrl = url;
    this.lastSubprotocols = subprotocols;
    const h = new FakeHandle();
    this.handles.push(h);
    return h;
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
}

const fakeAuth = (overrides: Partial<RealtimeAuthService> = {}): RealtimeAuthService => ({
  getCurrentToken: () => 'tok',
  refreshWithRetry: async () => 'tok2',
  ...overrides,
});

function build(auth: RealtimeAuthService = fakeAuth()): {
  client: RealtimeClient;
  transport: FakeTransport;
  scheduler: FakeScheduler;
} {
  const transport = new FakeTransport();
  const scheduler = new FakeScheduler();
  const client = new RealtimeClient({ url: URL, transport, auth, scheduler });
  return { client, transport, scheduler };
}

// Feature: phase1-client-messaging, Property 14: Connection status reflects socket state.

test('constructor rejects a non-wss url (8.6)', () => {
  assert.throws(() => new RealtimeClient({
    url: 'ws://insecure',
    transport: new FakeTransport(),
    auth: fakeAuth(),
  }), TypeError);
});

test('token rides the bearer subprotocol, never the URL (4.1, 4.2, 8.6)', () => {
  const { client, transport } = build();
  void client.connect();
  assert.equal(transport.lastUrl, URL);
  assert.ok(!transport.lastUrl.includes('tok'));
  assert.deepEqual(transport.lastSubprotocols, ['bearer', 'tok']);
});

test('status is disconnected while connecting and connected only once open (Property 14)', async () => {
  const { client, transport } = build();
  const p = client.connect();
  assert.equal(client.getStatus(), 'disconnected', 'connecting is not yet connected');
  transport.handles[0]!.fireOpen();
  await p;
  assert.equal(client.getStatus(), 'connected');
});

test('a non-deliberate close drops to disconnected and reconnects under backoff (Property 14, 4.6)', async () => {
  const { client, transport, scheduler } = build();
  const p = client.connect();
  transport.handles[0]!.fireOpen();
  await p;
  assert.equal(client.getStatus(), 'connected');

  transport.handles[0]!.fireClose(CLOSE_CODE_AUTH_UNAVAILABLE);
  assert.equal(client.getStatus(), 'disconnected');

  scheduler.runPending(); // fire the backoff timer → new attempt
  assert.equal(transport.handles.length, 2, 'a fresh socket was opened for the reconnect');
  transport.handles[1]!.fireOpen();
  assert.equal(client.getStatus(), 'connected');
});

test('client-initiated disconnect goes disconnected and does not reconnect (4.8)', async () => {
  const { client, transport, scheduler } = build();
  const p = client.connect();
  transport.handles[0]!.fireOpen();
  await p;

  client.disconnect();
  assert.equal(client.getStatus(), 'disconnected');
  assert.equal(transport.handles[0]!.closed?.code, 1000);

  scheduler.runPending();
  assert.equal(transport.handles.length, 1, 'no reconnect attempt after a client disconnect');
});

test('send throws while not connected and writes a frame once connected (5.10)', async () => {
  const { client, transport } = build();
  const frame: ClientToServerFrame = {
    kind: 'send',
    envelope: {
      senderUid: 'a',
      recipientUid: 'b',
      senderDeviceId: 'd',
      seq: 1,
      type: 1,
      ciphertext: Buffer.from('x').toString('base64'),
    },
  };
  assert.throws(() => client.send(frame), /cannot send while not connected/);

  const p = client.connect();
  transport.handles[0]!.fireOpen();
  await p;
  client.send(frame);
  assert.equal(transport.handles[0]!.sent.length, 1);
  assert.deepEqual(JSON.parse(transport.handles[0]!.sent[0]!), frame);
});

test('an inbound ping is answered with a pong; deliver/ack frames are forwarded (4.3)', async () => {
  const { client, transport } = build();
  const frames: unknown[] = [];
  client.onFrame((f) => frames.push(f));

  const p = client.connect();
  const handle = transport.handles[0]!;
  handle.fireOpen();
  await p;

  handle.fireMessage(JSON.stringify({ kind: 'ping' }));
  assert.deepEqual(JSON.parse(handle.sent.at(-1)!), { kind: 'pong' });

  const ack = { kind: 'ack', recipientUid: 'b', seq: 1, status: 'received' };
  handle.fireMessage(JSON.stringify(ack));
  assert.deepEqual(frames.at(-1), ack);
});

test('a 4401 close refreshes the token then reconnects (4.4)', async () => {
  let refreshCalls = 0;
  const auth = fakeAuth({
    refreshWithRetry: async () => {
      refreshCalls += 1;
      return 'tok2';
    },
  });
  const { client, transport } = build(auth);
  const p = client.connect();
  transport.handles[0]!.fireOpen();
  await p;

  transport.handles[0]!.fireClose(CLOSE_CODE_UNAUTHORIZED);
  // allow the async refresh-then-reconnect microtasks to settle
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(refreshCalls, 1);
  assert.equal(transport.handles.length, 2, 'reconnected with a fresh socket after refresh');
});
