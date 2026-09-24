import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';

import type { AuthContext, CiphertextEnvelope } from '@chat-app/types';

import type { InboxService, MessageRelayService, PushNotificationService } from '../messaging';
import type { PresenceRegistryService, RateLimiterService } from '../redis';
import { negotiateProtocol, RealtimeGateway, type AuthenticatedSocket } from './realtime.gateway';
import { WS_CLOSE_SERVICE_RESTART, WS_SEND_RATE_LIMIT } from './realtime.constants';

/**
 * Unit tests for the gateway's frame handling (task 4.8, Requirements 5.6, 5.7; reliable delivery
 * protocol v2). The gateway is constructed with stubs and driven directly with fake sockets
 * (no real `ws` server / Nest boot):
 *
 * - an accepted relay makes the gateway emit an `ack` frame back to the sender (5.6); a rejected,
 *   over-limit, or failed relay is NOT ACKed (the sender's 30 s timeout governs, 5.11), and a
 *   relay failure never escapes as an unhandled rejection;
 * - v2 `delivered` frames acknowledge entries in the caller's OWN inbox; v2 `ping` gets `pong`;
 * - the inbox is replayed on connect: non-destructively with ids + `hello` for v2, destructively
 *   without ids for legacy clients;
 * - graceful shutdown withdraws the node and closes sockets with 1012.
 */

const ENVELOPE: CiphertextEnvelope = {
  senderUid: 'alice',
  recipientUid: 'bob',
  senderDeviceId: 'device-1',
  seq: 5,
  type: 1,
  ciphertext: 'YmFzZTY0',
};

type GatewayInternals = {
  handleInboundMessage(socket: AuthenticatedSocket, data: string): Promise<void>;
  replayInbox(uid: string, socket: { send: (frame: unknown) => void; protocol?: number }): Promise<void>;
  handleNodeMessage(channel: string, message: string): void;
  connections: Set<AuthenticatedSocket>;
  nodeId: string;
};

interface Stubs {
  relay?: Partial<MessageRelayService>;
  inbox?: Partial<InboxService>;
  allowed?: boolean;
  presence?: Partial<PresenceRegistryService>;
  push?: Partial<PushNotificationService>;
}

function buildGateway(stubs: Stubs = {}): { gateway: RealtimeGateway; internals: GatewayInternals; hit: jest.Mock } {
  const hit = jest.fn().mockResolvedValue({ allowed: stubs.allowed ?? true });
  const gateway = new RealtimeGateway(
    undefined as never,
    (stubs.presence ?? {}) as PresenceRegistryService,
    { hit } as unknown as RateLimiterService,
    undefined as never,
    (stubs.relay ?? {}) as MessageRelayService,
    undefined as never,
    (stubs.inbox ?? {}) as InboxService,
    (stubs.push ?? {}) as PushNotificationService,
  );
  return { gateway, internals: gateway as unknown as GatewayInternals, hit };
}

function fakeSocket(authContext?: AuthContext): AuthenticatedSocket & { sent: string[] } {
  const sent: string[] = [];
  return { authContext, send: (data: string) => sent.push(data), sent } as unknown as
    AuthenticatedSocket & { sent: string[] };
}

const ALICE: AuthContext = { uid: 'alice', tokenExp: 9_999_999_999 };

const sendFrame = (envelope: CiphertextEnvelope): string =>
  JSON.stringify({ kind: 'send', envelope });

describe('RealtimeGateway inbound send handling', () => {
  it('ACKs the sender when the relay accepts the envelope (5.6)', async () => {
    const relay = { relay: jest.fn().mockResolvedValue({ status: 'received', nodes: 1 }) };
    const { internals } = buildGateway({ relay });
    const socket = fakeSocket(ALICE);

    await internals.handleInboundMessage(socket, sendFrame(ENVELOPE));

    expect(relay.relay).toHaveBeenCalledTimes(1);
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      kind: 'ack',
      recipientUid: 'bob',
      seq: 5,
      status: 'received',
      nodes: 1,
    });
  });

  it('does not ACK when the relay rejects the envelope (5.11)', async () => {
    const relay = {
      relay: jest.fn().mockResolvedValue({ status: 'rejected', reason: 'sender-mismatch' }),
    };
    const { internals } = buildGateway({ relay });
    const socket = fakeSocket(ALICE);

    await internals.handleInboundMessage(socket, sendFrame(ENVELOPE));

    expect(relay.relay).toHaveBeenCalledTimes(1);
    expect(socket.sent).toHaveLength(0);
  });

  it('does not ACK — and does not reject — when storing the envelope fails', async () => {
    const relay = { relay: jest.fn().mockRejectedValue(new Error('redis down')) };
    const { internals } = buildGateway({ relay });
    const socket = fakeSocket(ALICE);

    await expect(internals.handleInboundMessage(socket, sendFrame(ENVELOPE))).resolves.toBeUndefined();
    expect(socket.sent).toHaveLength(0);
  });

  it('drops a send over the per-user rate limit without relaying or ACKing', async () => {
    const relay = { relay: jest.fn() };
    const { internals, hit } = buildGateway({ relay, allowed: false });
    const socket = fakeSocket(ALICE);

    await internals.handleInboundMessage(socket, sendFrame(ENVELOPE));

    expect(hit).toHaveBeenCalledWith('ws-send:alice', WS_SEND_RATE_LIMIT, 60);
    expect(relay.relay).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(0);
  });

  it('never relays for an unauthenticated socket', async () => {
    const relay = { relay: jest.fn() };
    const { internals } = buildGateway({ relay });
    const socket = fakeSocket(undefined);

    await internals.handleInboundMessage(socket, sendFrame(ENVELOPE));

    expect(relay.relay).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(0);
  });
});

describe('RealtimeGateway v2 control frames', () => {
  it('acknowledges delivered ids against the caller OWN inbox', async () => {
    const inbox = { ack: jest.fn().mockResolvedValue(2) };
    const { internals } = buildGateway({ inbox });

    await internals.handleInboundMessage(
      fakeSocket(ALICE),
      JSON.stringify({ kind: 'delivered', ids: ['1-0', '2-0'] }),
    );

    expect(inbox.ack).toHaveBeenCalledWith('alice', ['1-0', '2-0']);
  });

  it('ignores a delivered frame without an id list', async () => {
    const inbox = { ack: jest.fn() };
    const { internals } = buildGateway({ inbox });

    await internals.handleInboundMessage(fakeSocket(ALICE), JSON.stringify({ kind: 'delivered', ids: 'x' }));

    expect(inbox.ack).not.toHaveBeenCalled();
  });

  it('answers an application-level ping with pong', async () => {
    const { internals } = buildGateway();
    const socket = fakeSocket(ALICE);

    await internals.handleInboundMessage(socket, JSON.stringify({ kind: 'ping' }));

    expect(socket.sent.map((f) => JSON.parse(f))).toEqual([{ kind: 'pong' }]);
  });

  it('rate-limits typing hints per user', async () => {
    const relay = { relayTyping: jest.fn() };
    const { internals } = buildGateway({ relay, allowed: false });

    await internals.handleInboundMessage(
      fakeSocket(ALICE),
      JSON.stringify({ kind: 'typing', recipientUid: 'bob' }),
    );

    expect(relay.relayTyping).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway inbox replay on connect', () => {
  const queued = [
    { id: '1-0', envelope: { ...ENVELOPE, seq: 1 } },
    { id: '2-0', envelope: { ...ENVELOPE, seq: 2 } },
  ];

  it('v2: says hello, then replays every pending entry WITH its id, non-destructively', async () => {
    const inbox = {
      migrateLegacy: jest.fn().mockResolvedValue(0),
      list: jest.fn().mockResolvedValue(queued),
      takeAll: jest.fn(),
    };
    const { internals } = buildGateway({ inbox });
    const sent: unknown[] = [];

    await internals.replayInbox('bob', { send: (frame) => sent.push(frame), protocol: 2 });

    expect(inbox.migrateLegacy).toHaveBeenCalledWith('bob');
    expect(inbox.takeAll).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { kind: 'hello', protocol: 2 },
      { kind: 'deliver', envelope: queued[0]!.envelope, id: '1-0' },
      { kind: 'deliver', envelope: queued[1]!.envelope, id: '2-0' },
    ]);
  });

  it('legacy: drains destructively and sends plain deliver frames, no hello', async () => {
    const inbox = {
      migrateLegacy: jest.fn().mockResolvedValue(0),
      list: jest.fn(),
      takeAll: jest.fn().mockResolvedValue(queued),
    };
    const { internals } = buildGateway({ inbox });
    const sent: unknown[] = [];

    await internals.replayInbox('bob', { send: (frame) => sent.push(frame) });

    expect(inbox.list).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { kind: 'deliver', envelope: queued[0]!.envelope },
      { kind: 'deliver', envelope: queued[1]!.envelope },
    ]);
  });

  it('swallows a replay failure so a Redis blip cannot break the connection', async () => {
    const inbox = { migrateLegacy: jest.fn().mockRejectedValue(new Error('redis down')) };
    const { internals } = buildGateway({ inbox });
    const sent: unknown[] = [];

    await expect(
      internals.replayInbox('bob', { send: (frame) => sent.push(frame), protocol: 2 }),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([{ kind: 'hello', protocol: 2 }]);
  });
});

describe('RealtimeGateway node channel delivery', () => {
  it('wakes the recipient when their socket is no longer on this node', () => {
    const relay = { deliverLocal: jest.fn().mockReturnValue(0) };
    const push = { notify: jest.fn().mockResolvedValue(undefined) };
    const { internals } = buildGateway({ relay, push });

    internals.handleNodeMessage(
      `node:${internals.nodeId}`,
      JSON.stringify({ targetUid: 'bob', envelope: ENVELOPE, id: '9-0' }),
    );

    expect(relay.deliverLocal).toHaveBeenCalledWith('bob', ENVELOPE, '9-0');
    expect(push.notify).toHaveBeenCalledWith('bob');
  });

  it('ignores messages for other nodes', () => {
    const relay = { deliverLocal: jest.fn() };
    const { internals } = buildGateway({ relay });

    internals.handleNodeMessage('node:someone-else', JSON.stringify({ targetUid: 'bob', envelope: ENVELOPE }));

    expect(relay.deliverLocal).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway graceful shutdown', () => {
  it('withdraws the node, drops presence entries, and closes sockets with 1012', async () => {
    const presence = {
      clearNodeAlive: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      recordLastSeen: jest.fn().mockResolvedValue(undefined),
    };
    const { gateway, internals } = buildGateway({ presence });
    const close = jest.fn();
    const socket = { authContext: ALICE, connId: 'conn-1', close } as unknown as AuthenticatedSocket;
    internals.connections.add(socket);

    await gateway.beforeApplicationShutdown();

    expect(presence.clearNodeAlive).toHaveBeenCalledWith(internals.nodeId);
    expect(presence.remove).toHaveBeenCalledWith('alice', 'conn-1');
    expect(close).toHaveBeenCalledWith(WS_CLOSE_SERVICE_RESTART, 'service restart');
    expect(internals.connections.size).toBe(0);
  });
});

describe('negotiateProtocol', () => {
  it.each([
    [undefined, 1],
    ['/', 1],
    ['/?v=1', 1],
    ['/?v=abc', 1],
    ['/?v=2', 2],
    ['/?token=x&v=2', 2],
    ['/?v=99', 2],
  ])('%s → v%i', (url, expected) => {
    expect(negotiateProtocol(url)).toBe(expected);
  });
});

describe('RealtimeGateway frames sent during the handshake', () => {
  /** A `ws`-like socket: an EventEmitter that is OPEN and records what the server writes. */
  class FakeWs extends EventEmitter {
    readyState = 1; // WebSocket.OPEN
    readonly sent: unknown[] = [];
    readonly close = jest.fn();
    send(data: string): void {
      this.sent.push(JSON.parse(data));
    }
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function build(verify: Promise<AuthContext>) {
    const relay = { relay: jest.fn().mockResolvedValue({ status: 'received', nodes: 1 }) };
    const gateway = new RealtimeGateway(
      { verify: () => verify } as never,
      { add: jest.fn().mockResolvedValue(undefined) } as never,
      { hit: jest.fn().mockResolvedValue({ allowed: true }) } as never,
      { subscribe: jest.fn().mockResolvedValue(1) } as never,
      relay as never,
      { register: jest.fn(), unregister: jest.fn(), getLocalSockets: () => [] } as never,
      {
        migrateLegacy: jest.fn().mockResolvedValue(0),
        list: jest.fn().mockResolvedValue([]),
        takeAll: jest.fn().mockResolvedValue([]),
      } as never,
      { notify: jest.fn() } as never,
    );
    return { gateway, relay };
  }

  const request = { headers: { 'sec-websocket-protocol': 'bearer, tok' }, url: '/?v=2' } as unknown as IncomingMessage;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
  };

  it('relays (and ACKs) a send the client flushed before verification finished', async () => {
    const verify = deferred<AuthContext>();
    const { gateway, relay } = build(verify.promise);
    const socket = new FakeWs();

    const connecting = gateway.handleConnection(socket as unknown as AuthenticatedSocket, request);
    socket.emit('message', Buffer.from(sendFrame(ENVELOPE))); // arrives while verify is pending
    verify.resolve(ALICE);
    await connecting;
    await settle();

    expect(relay.relay).toHaveBeenCalledWith(ALICE, ENVELOPE);
    expect(socket.sent).toContainEqual(expect.objectContaining({ kind: 'ack', seq: 5 }));
  });

  it('discards buffered frames when the handshake is rejected', async () => {
    const verify = deferred<AuthContext>();
    const { gateway, relay } = build(verify.promise);
    const socket = new FakeWs();

    const connecting = gateway.handleConnection(socket as unknown as AuthenticatedSocket, request);
    socket.emit('message', Buffer.from(sendFrame(ENVELOPE)));
    verify.reject(new Error('bad token'));
    await connecting;
    await settle();

    expect(relay.relay).not.toHaveBeenCalled();
    expect(socket.listenerCount('message')).toBe(0);
  });
});
