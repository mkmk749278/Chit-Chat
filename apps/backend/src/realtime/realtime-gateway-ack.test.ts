import type { AuthContext, CiphertextEnvelope } from '@chat-app/types';

import type { MessageRelayService } from '../messaging';
import { RealtimeGateway, type AuthenticatedSocket } from './realtime.gateway';

/**
 * Unit test for the gateway's inbound `send` handling (task 4.8, Requirements 5.6, 5.7).
 * The gateway is constructed with a stub relay and its inbound handler is driven directly
 * with a fake authenticated socket (no real `ws` server / Nest boot):
 *
 * - an accepted relay (`{ status: 'received' }`) makes the gateway emit an `ack` frame
 *   back to the sender so its message shows `sent` (5.6);
 * - a rejected relay is NOT ACKed (the sender's 30 s timeout governs, 5.11);
 * - an unauthenticated socket never causes a relay call.
 */

const ENVELOPE: CiphertextEnvelope = {
  senderUid: 'alice',
  recipientUid: 'bob',
  senderDeviceId: 'device-1',
  seq: 5,
  type: 1,
  ciphertext: 'YmFzZTY0',
};

type InboundGateway = {
  handleInboundMessage(socket: AuthenticatedSocket, data: string): Promise<void>;
};

function buildGateway(relay: Pick<MessageRelayService, 'relay'>): InboundGateway {
  // Only `relay` is exercised by handleInboundMessage; the other collaborators are unused
  // on this path, so undefined stubs are safe.
  const gateway = new RealtimeGateway(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    relay as MessageRelayService,
    undefined as never,
  );
  return gateway as unknown as InboundGateway;
}

function fakeSocket(authContext?: AuthContext): AuthenticatedSocket & { sent: string[] } {
  const sent: string[] = [];
  return { authContext, send: (data: string) => sent.push(data), sent } as unknown as
    AuthenticatedSocket & { sent: string[] };
}

const sendFrame = (envelope: CiphertextEnvelope): string =>
  JSON.stringify({ kind: 'send', envelope });

describe('RealtimeGateway inbound send handling', () => {
  it('ACKs the sender when the relay accepts the envelope (5.6)', async () => {
    const relay = { relay: jest.fn().mockResolvedValue({ status: 'received' }) };
    const gateway = buildGateway(relay);
    const socket = fakeSocket({ uid: 'alice', tokenExp: 9_999_999_999 });

    await gateway.handleInboundMessage(socket, sendFrame(ENVELOPE));

    expect(relay.relay).toHaveBeenCalledTimes(1);
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      kind: 'ack',
      recipientUid: 'bob',
      seq: 5,
      status: 'received',
    });
  });

  it('does not ACK when the relay rejects the envelope (5.11)', async () => {
    const relay = {
      relay: jest.fn().mockResolvedValue({ status: 'rejected', reason: 'sender-mismatch' }),
    };
    const gateway = buildGateway(relay);
    const socket = fakeSocket({ uid: 'alice', tokenExp: 9_999_999_999 });

    await gateway.handleInboundMessage(socket, sendFrame(ENVELOPE));

    expect(relay.relay).toHaveBeenCalledTimes(1);
    expect(socket.sent).toHaveLength(0);
  });

  it('never relays for an unauthenticated socket', async () => {
    const relay = { relay: jest.fn() };
    const gateway = buildGateway(relay);
    const socket = fakeSocket(undefined);

    await gateway.handleInboundMessage(socket, sendFrame(ENVELOPE));

    expect(relay.relay).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(0);
  });
});
