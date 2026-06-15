import type { AuthContext, CiphertextEnvelope } from '@chat-app/types';

import { InProcessSocketRegistry, type LocalRecipientSocket } from './local-socket-registry';
import { MessageRelayService } from './message-relay.service';
import type { NodeRelayMessage } from './node-relay-message';

/**
 * Unit tests for {@link MessageRelayService} (task 4.5, Requirements 5.7, 8.2). The relay
 * is exercised directly with stub Redis publisher + presence registry rather than booting
 * Nest, asserting its example behaviours:
 *
 * - a spoofed sender (`envelope.senderUid !== sender.uid`) is rejected `sender-mismatch`
 *   and nothing is published (security boundary, 5.7/8.2);
 * - a structurally malformed envelope is rejected `malformed` and nothing is published;
 * - a well-formed, sender-bound envelope is accepted `received` and fanned out once per
 *   DISTINCT owning node to `node:{nodeId}` as a NodeRelayMessage JSON payload;
 * - an offline recipient is still accepted `received` with no publish;
 * - `deliverLocal` wraps the envelope in a `deliver` frame and pushes it to every local
 *   socket the recipient holds, and is a no-op when none.
 *
 * The opaque ciphertext body is never decoded by the relay; tests use a placeholder
 * base64 string and only assert it is carried through unchanged.
 */

const SENDER_UID = 'sender-uid';
const RECIPIENT_UID = 'recipient-uid';

function buildEnvelope(overrides: Partial<CiphertextEnvelope> = {}): CiphertextEnvelope {
  return {
    senderUid: SENDER_UID,
    recipientUid: RECIPIENT_UID,
    senderDeviceId: 'device-1',
    seq: 0,
    type: 3,
    ciphertext: 'YmFzZTY0LWNpcGhlcnRleHQ=',
    ...overrides,
  };
}

function buildSender(uid: string = SENDER_UID): AuthContext {
  return { uid, tokenExp: 9_999_999_999 };
}

type Harness = {
  service: MessageRelayService;
  publish: jest.Mock;
  lookup: jest.Mock;
  enqueue: jest.Mock;
  registry: InProcessSocketRegistry;
};

function buildService(presenceEntries: Record<string, string> = {}): Harness {
  const publish = jest.fn().mockResolvedValue(1);
  const lookup = jest.fn().mockResolvedValue(presenceEntries);
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const publisher = { publish } as unknown as ConstructorParameters<typeof MessageRelayService>[0];
  const presence = { lookup } as unknown as ConstructorParameters<typeof MessageRelayService>[1];
  const registry = new InProcessSocketRegistry();
  const offlineQueue = { enqueue } as unknown as ConstructorParameters<typeof MessageRelayService>[3];
  const service = new MessageRelayService(publisher, presence, registry, offlineQueue);
  return { service, publish, lookup, enqueue, registry };
}

describe('MessageRelayService.relay', () => {
  it('rejects a spoofed sender as sender-mismatch and publishes nothing', async () => {
    const { service, publish } = buildService({ 'conn-1': 'node-a' });

    const outcome = await service.relay(buildSender('someone-else'), buildEnvelope());

    expect(outcome).toEqual({ status: 'rejected', reason: 'sender-mismatch' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a structurally malformed envelope as malformed and publishes nothing', async () => {
    const { service, publish } = buildService({ 'conn-1': 'node-a' });

    const malformed = buildEnvelope({ ciphertext: '' });
    const outcome = await service.relay(buildSender(), malformed);

    expect(outcome).toEqual({ status: 'rejected', reason: 'malformed' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('accepts a well-formed envelope and publishes once per distinct owning node', async () => {
    // Two connections on node-a + one on node-b → publish exactly twice (deduped node-a).
    const { service, publish } = buildService({
      'conn-1': 'node-a',
      'conn-2': 'node-a',
      'conn-3': 'node-b',
    });
    const envelope = buildEnvelope();

    const outcome = await service.relay(buildSender(), envelope);

    expect(outcome).toEqual({ status: 'received' });
    expect(publish).toHaveBeenCalledTimes(2);

    const channels = publish.mock.calls.map((call) => call[0] as string).sort();
    expect(channels).toEqual(['node:node-a', 'node:node-b']);

    const payload = JSON.parse(publish.mock.calls[0][1] as string) as NodeRelayMessage;
    expect(payload).toEqual({ targetUid: RECIPIENT_UID, envelope });
  });

  it('queues an offline recipient for store-and-forward instead of publishing', async () => {
    const { service, publish, enqueue } = buildService({});
    const envelope = buildEnvelope();

    const outcome = await service.relay(buildSender(), envelope);

    expect(outcome).toEqual({ status: 'received' });
    expect(publish).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(RECIPIENT_UID, envelope);
  });

  it('does not queue an online recipient (delivered live, not stored)', async () => {
    const { service, enqueue } = buildService({ 'conn-1': 'node-a' });

    await service.relay(buildSender(), buildEnvelope());

    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('MessageRelayService.deliverLocal', () => {
  it('pushes a deliver frame to every local socket the recipient holds', () => {
    const { service, registry } = buildService();
    const frames: unknown[] = [];
    const socketA: LocalRecipientSocket = { send: (frame) => frames.push(frame) };
    const socketB: LocalRecipientSocket = { send: (frame) => frames.push(frame) };
    registry.register(RECIPIENT_UID, socketA);
    registry.register(RECIPIENT_UID, socketB);
    const envelope = buildEnvelope();

    service.deliverLocal(RECIPIENT_UID, envelope);

    expect(frames).toEqual([
      { kind: 'deliver', envelope },
      { kind: 'deliver', envelope },
    ]);
  });

  it('is a no-op when the recipient holds no local socket', () => {
    const { service } = buildService();
    expect(() => service.deliverLocal('nobody', buildEnvelope())).not.toThrow();
  });
});
