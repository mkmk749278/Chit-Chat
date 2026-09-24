import type { AuthContext, CiphertextEnvelope } from '@chat-app/types';

import { InProcessSocketRegistry, type LocalRecipientSocket } from './local-socket-registry';
import { MessageRelayService } from './message-relay.service';
import type { NodeRelayMessage } from './node-relay-message';

/**
 * Unit tests for {@link MessageRelayService} (task 4.5, Requirements 5.7, 8.2; reliable delivery
 * protocol v2). The relay is exercised directly with stub Redis publisher, presence registry,
 * inbox, and push service rather than booting Nest, asserting:
 *
 * - a spoofed sender (`envelope.senderUid !== sender.uid`) is rejected `sender-mismatch` and
 *   nothing is stored or published (security boundary, 5.7/8.2);
 * - a structurally malformed envelope is rejected `malformed` and nothing is stored or published;
 * - an accepted envelope is stored in the recipient's inbox FIRST, then fanned out once per
 *   DISTINCT live node as a NodeRelayMessage carrying the inbox id;
 * - when no node actually receives the publish (offline recipient, dead node, publish failure)
 *   the recipient is woken with a push — and the sender is still ACKed, because the envelope is
 *   stored;
 * - a storage failure propagates (the gateway must not ACK);
 * - `deliverLocal` wraps the envelope in a `deliver` frame with its id, and drops the inbox entry
 *   when the frame went to a legacy (v1) socket that will never acknowledge it.
 *
 * The opaque ciphertext body is never decoded by the relay; tests use a placeholder
 * base64 string and only assert it is carried through unchanged.
 */

const SENDER_UID = 'sender-uid';
const RECIPIENT_UID = 'recipient-uid';
const INBOX_ID = '1700000000000-0';

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
  lookupLive: jest.Mock;
  append: jest.Mock;
  ack: jest.Mock;
  notify: jest.Mock;
  registry: InProcessSocketRegistry;
};

function buildService(
  presenceEntries: Record<string, string> = {},
  opts: { receivers?: number; appendFails?: boolean; publishFails?: boolean } = {},
): Harness {
  const publish = opts.publishFails
    ? jest.fn().mockRejectedValue(new Error('publisher down'))
    : jest.fn().mockResolvedValue(opts.receivers ?? 1);
  const lookupLive = jest.fn().mockResolvedValue(presenceEntries);
  const append = opts.appendFails
    ? jest.fn().mockRejectedValue(new Error('redis down'))
    : jest.fn().mockResolvedValue(INBOX_ID);
  const ack = jest.fn().mockResolvedValue(1);
  const notify = jest.fn().mockResolvedValue(undefined);
  const publisher = { publish } as unknown as ConstructorParameters<typeof MessageRelayService>[0];
  const presence = { lookupLive } as unknown as ConstructorParameters<typeof MessageRelayService>[1];
  const registry = new InProcessSocketRegistry();
  const inbox = { append, ack } as unknown as ConstructorParameters<typeof MessageRelayService>[3];
  const push = { notify } as unknown as ConstructorParameters<typeof MessageRelayService>[4];
  const service = new MessageRelayService(publisher, presence, registry, inbox, push);
  return { service, publish, lookupLive, append, ack, notify, registry };
}

describe('MessageRelayService.relay', () => {
  it('rejects a spoofed sender as sender-mismatch and stores/publishes nothing', async () => {
    const { service, publish, append } = buildService({ 'conn-1': 'node-a' });

    const outcome = await service.relay(buildSender('someone-else'), buildEnvelope());

    expect(outcome).toEqual({ status: 'rejected', reason: 'sender-mismatch' });
    expect(append).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a structurally malformed envelope as malformed and stores/publishes nothing', async () => {
    const { service, publish, append } = buildService({ 'conn-1': 'node-a' });

    for (const malformed of [
      buildEnvelope({ ciphertext: '' }),
      buildEnvelope({ seq: 1.5 }),
      buildEnvelope({ recipientUid: 'x'.repeat(129) }),
    ]) {
      const outcome = await service.relay(buildSender(), malformed);
      expect(outcome).toEqual({ status: 'rejected', reason: 'malformed' });
    }
    expect(append).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('stores first, then publishes once per distinct live node with the inbox id', async () => {
    // Two connections on node-a + one on node-b → publish exactly twice (deduped node-a).
    const { service, publish, append, notify } = buildService({
      'conn-1': 'node-a',
      'conn-2': 'node-a',
      'conn-3': 'node-b',
    });
    const envelope = buildEnvelope();

    const outcome = await service.relay(buildSender(), envelope);

    expect(outcome).toEqual({ status: 'received', nodes: 2 });
    expect(append).toHaveBeenCalledWith(RECIPIENT_UID, envelope);
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0]!);
    expect(publish).toHaveBeenCalledTimes(2);
    const channels = publish.mock.calls.map((call) => call[0] as string).sort();
    expect(channels).toEqual(['node:node-a', 'node:node-b']);
    const payload = JSON.parse(publish.mock.calls[0][1] as string) as NodeRelayMessage;
    expect(payload).toEqual({ targetUid: RECIPIENT_UID, envelope, id: INBOX_ID });
    expect(notify).not.toHaveBeenCalled();
  });

  it('never stores or forwards extra fields a client smuggles onto the envelope', async () => {
    const { service, append } = buildService({ 'conn-1': 'node-a' });
    const envelope = { ...buildEnvelope(), plaintext: 'leak' } as unknown as CiphertextEnvelope;

    await service.relay(buildSender(), envelope);

    expect(append.mock.calls[0][1]).toEqual(buildEnvelope());
  });

  it('stores and wakes an offline recipient (no publish), and still ACKs', async () => {
    const { service, publish, append, notify } = buildService({});
    const envelope = buildEnvelope();

    const outcome = await service.relay(buildSender(), envelope);

    expect(outcome).toEqual({ status: 'received', nodes: 0 });
    expect(append).toHaveBeenCalledWith(RECIPIENT_UID, envelope);
    expect(publish).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(RECIPIENT_UID);
  });

  it('treats a publish nobody received (dead node) as offline: wake push, still stored', async () => {
    const { service, notify } = buildService({ 'conn-1': 'node-gone' }, { receivers: 0 });

    const outcome = await service.relay(buildSender(), buildEnvelope());

    expect(outcome).toEqual({ status: 'received', nodes: 0 });
    expect(notify).toHaveBeenCalledWith(RECIPIENT_UID);
  });

  it('survives a publish failure: the stored envelope is still accepted and the user woken', async () => {
    const { service, notify } = buildService({ 'conn-1': 'node-a' }, { publishFails: true });

    const outcome = await service.relay(buildSender(), buildEnvelope());

    expect(outcome).toEqual({ status: 'received', nodes: 0 });
    expect(notify).toHaveBeenCalledWith(RECIPIENT_UID);
  });

  it('propagates a storage failure so the gateway does not ACK an unstored message', async () => {
    const { service, publish } = buildService({ 'conn-1': 'node-a' }, { appendFails: true });

    await expect(service.relay(buildSender(), buildEnvelope())).rejects.toThrow('redis down');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('MessageRelayService.relayTyping', () => {
  it('publishes a typing hint once per distinct live node, bound to the sender', async () => {
    const { service, publish } = buildService({
      'conn-1': 'node-a',
      'conn-2': 'node-a',
      'conn-3': 'node-b',
    });

    await service.relayTyping(buildSender(), RECIPIENT_UID);

    expect(publish).toHaveBeenCalledTimes(2);
    const channels = publish.mock.calls.map((call) => call[0] as string).sort();
    expect(channels).toEqual(['node:node-a', 'node:node-b']);
    const payload = JSON.parse(publish.mock.calls[0][1] as string) as Record<string, unknown>;
    expect(payload).toEqual({ kind: 'typing', targetUid: RECIPIENT_UID, fromUid: SENDER_UID });
  });

  it('is a silent no-op for an offline recipient (never stored, never pushed)', async () => {
    const { service, publish, append, notify } = buildService({});

    await service.relayTyping(buildSender(), RECIPIENT_UID);

    expect(publish).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores an empty or oversized recipient', async () => {
    const { service, publish, lookupLive } = buildService({ 'conn-1': 'node-a' });

    await service.relayTyping(buildSender(), '');
    await service.relayTyping(buildSender(), 'x'.repeat(200));

    expect(lookupLive).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('MessageRelayService.deliverTypingLocal', () => {
  it('pushes a typing frame to every local socket the recipient holds', () => {
    const { service, registry } = buildService();
    const frames: unknown[] = [];
    const socket: LocalRecipientSocket = { send: (frame) => frames.push(frame) };
    registry.register(RECIPIENT_UID, socket);

    service.deliverTypingLocal(RECIPIENT_UID, SENDER_UID);

    expect(frames).toEqual([{ kind: 'typing', fromUid: SENDER_UID }]);
  });

  it('is a no-op when the recipient holds no local socket', () => {
    const { service } = buildService();
    expect(() => service.deliverTypingLocal('nobody', SENDER_UID)).not.toThrow();
  });
});

describe('MessageRelayService.deliverLocal', () => {
  it('pushes a deliver frame with the inbox id to every local socket, keeping the entry for v2', () => {
    const { service, registry, ack } = buildService();
    const frames: unknown[] = [];
    const socketA: LocalRecipientSocket = { send: (frame) => frames.push(frame), protocol: 2 };
    const socketB: LocalRecipientSocket = { send: (frame) => frames.push(frame), protocol: 2 };
    registry.register(RECIPIENT_UID, socketA);
    registry.register(RECIPIENT_UID, socketB);
    const envelope = buildEnvelope();

    const written = service.deliverLocal(RECIPIENT_UID, envelope, INBOX_ID);

    expect(written).toBe(2);
    expect(frames).toEqual([
      { kind: 'deliver', envelope, id: INBOX_ID },
      { kind: 'deliver', envelope, id: INBOX_ID },
    ]);
    // v2 sockets confirm with `delivered`; the relay must not drop the entry itself.
    expect(ack).not.toHaveBeenCalled();
  });

  it('drops the inbox entry after delivering to a legacy socket that never acknowledges', () => {
    const { service, registry, ack } = buildService();
    registry.register(RECIPIENT_UID, { send: () => undefined });

    service.deliverLocal(RECIPIENT_UID, buildEnvelope(), INBOX_ID);

    expect(ack).toHaveBeenCalledWith(RECIPIENT_UID, [INBOX_ID]);
  });

  it('omits the id when the publishing node sent none', () => {
    const { service, registry } = buildService();
    const frames: unknown[] = [];
    registry.register(RECIPIENT_UID, { send: (frame) => frames.push(frame), protocol: 2 });
    const envelope = buildEnvelope();

    service.deliverLocal(RECIPIENT_UID, envelope);

    expect(frames).toEqual([{ kind: 'deliver', envelope }]);
  });

  it('returns 0 when the recipient holds no local socket', () => {
    const { service } = buildService();
    expect(service.deliverLocal('nobody', buildEnvelope(), INBOX_ID)).toBe(0);
  });
});
