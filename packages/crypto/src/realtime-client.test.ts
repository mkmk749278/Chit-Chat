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
  // Only the non-secret protocol-version flag is added to the URL.
  assert.equal(transport.lastUrl, `${URL}?v=2`);
  assert.ok(!transport.lastUrl.includes('tok'));
  assert.deepEqual(transport.lastSubprotocols, ['bearer', 'tok']);
});

test('protocol 1 opts out of the version flag (legacy wire)', () => {
  const transport = new FakeTransport();
  const client = new RealtimeClient({ url: URL, transport, auth: fakeAuth(), scheduler: new FakeScheduler(), protocol: 1 });
  void client.connect();
  assert.equal(transport.lastUrl, URL);
});

test('the version flag is appended after an existing query string', () => {
  const transport = new FakeTransport();
  const client = new RealtimeClient({ url: `${URL}?region=eu`, transport, auth: fakeAuth(), scheduler: new FakeScheduler() });
  void client.connect();
  assert.equal(transport.lastUrl, `${URL}?region=eu&v=2`);
});

// --- keepalive (protocol v2) --------------------------------------------------

async function connectedV2(): Promise<{ client: RealtimeClient; transport: FakeTransport; scheduler: FakeScheduler; handle: FakeHandle }> {
  const { client, transport, scheduler } = build();
  const p = client.connect();
  const handle = transport.handles[0]!;
  handle.fireOpen();
  await p;
  handle.fireMessage(JSON.stringify({ kind: 'hello', protocol: 2 }));
  return { client, transport, scheduler, handle };
}

test('keepalive: probes a v2 server with ping and stays up when pong arrives', async () => {
  const { client, transport, scheduler, handle } = await connectedV2();

  scheduler.runPending(); // keepalive interval elapses → ping sent, deadline armed
  assert.deepEqual(JSON.parse(handle.sent.at(-1)!), { kind: 'ping' });

  handle.fireMessage(JSON.stringify({ kind: 'pong' })); // answer clears the deadline, re-arms
  scheduler.runPending(); // next interval → another ping, NOT a reconnect
  assert.equal(transport.handles.length, 1);
  assert.equal(client.getStatus(), 'connected');
  assert.equal(handle.sent.filter((f) => JSON.parse(f).kind === 'ping').length, 2);
});

test('keepalive: a zombie socket (no answer) is replaced and reconnects', async () => {
  const { client, transport, scheduler, handle } = await connectedV2();

  scheduler.runPending(); // ping sent
  scheduler.runPending(); // deadline passes with no frame at all
  assert.equal(client.getStatus(), 'disconnected');
  assert.equal(handle.closed?.reason, 'keepalive timeout');

  scheduler.runPending(); // backoff → fresh attempt
  assert.equal(transport.handles.length, 2, 'a fresh socket replaces the zombie');
});

test('keepalive: any inbound frame counts as proof of life', async () => {
  const { transport, scheduler, handle } = await connectedV2();

  scheduler.runPending(); // ping sent, deadline armed
  handle.fireMessage(JSON.stringify({ kind: 'typing', fromUid: 'bob' }));
  scheduler.runPending(); // interval (not the stale deadline)
  assert.equal(transport.handles.length, 1);
});

test('keepalive: never runs against a server that did not say hello (older backend)', async () => {
  const { client, transport, scheduler } = build();
  const p = client.connect();
  const handle = transport.handles[0]!;
  handle.fireOpen();
  await p;

  scheduler.runPending();
  scheduler.runPending();
  assert.equal(handle.sent.length, 0, 'no ping sent to a v1 server');
  assert.equal(client.getStatus(), 'connected');
});

test('hello and pong are control frames, not forwarded to frame listeners', async () => {
  const { client, handle } = await connectedV2();
  const seen: unknown[] = [];
  client.onFrame((f) => seen.push(f));
  handle.fireMessage(JSON.stringify({ kind: 'pong' }));
  handle.fireMessage(JSON.stringify({ kind: 'hello', protocol: 2 }));
  assert.deepEqual(seen, []);
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

test('reconnectNow forces a fresh socket even while connected (foreground resume)', async () => {
  const { client, transport } = build();
  const p = client.connect();
  transport.handles[0]!.fireOpen();
  await p;
  assert.equal(client.getStatus(), 'connected');
  assert.equal(transport.handles.length, 1);

  // Simulate app-resume: the previous socket may be a zombie, so a fresh attempt opens at once.
  client.reconnectNow();
  assert.equal(transport.handles.length, 2, 'a fresh socket was opened immediately (no backoff wait)');
  assert.equal(transport.handles[0]!.closed?.code, 1000, 'the stale socket was proactively closed');
  assert.equal(client.getStatus(), 'disconnected', 'disconnected until the new handshake opens');

  transport.handles[1]!.fireOpen();
  assert.equal(client.getStatus(), 'connected', 'reconnected on the fresh handshake');
});

test('reconnectNow while signed out stays disconnected and opens no socket (no token)', () => {
  const { client, transport } = build(fakeAuth({ getCurrentToken: () => null }));
  client.reconnectNow();
  assert.equal(client.getStatus(), 'disconnected');
  assert.equal(transport.handles.length, 0, 'no authenticated socket without a token');
});

test('reconnectNow re-enables auto-reconnect after a client disconnect', async () => {
  const { client, transport } = build();
  const p = client.connect();
  transport.handles[0]!.fireOpen();
  await p;
  client.disconnect();
  assert.equal(client.getStatus(), 'disconnected');

  // After a deliberate disconnect, reconnectNow brings the connection back (like connect()).
  client.reconnectNow();
  assert.equal(transport.handles.length, 2, 'a new attempt was started');
  transport.handles[1]!.fireOpen();
  assert.equal(client.getStatus(), 'connected');
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
