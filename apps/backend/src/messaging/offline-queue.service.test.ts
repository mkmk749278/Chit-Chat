import type { CiphertextEnvelope } from '@chat-app/types';

import {
  MAX_QUEUED_MESSAGES,
  OfflineQueueService,
  QUEUE_TTL_SECONDS,
} from './offline-queue.service';

/**
 * Unit tests for {@link OfflineQueueService} (store-and-forward for offline recipients).
 * A fake `ioredis` records the `multi()` pipeline calls and feeds back canned `exec()`
 * results, so the test asserts the queue bounds (cap + TTL), FIFO drain semantics, the
 * atomic LRANGE+DEL on drain, and that malformed entries are skipped — without a real Redis.
 */

const RECIPIENT = 'recipient-uid';
const KEY = `offline:${RECIPIENT}`;

function buildEnvelope(seq: number): CiphertextEnvelope {
  return {
    senderUid: 'sender-uid',
    recipientUid: RECIPIENT,
    senderDeviceId: 'device-1',
    seq,
    type: 3,
    ciphertext: `Y2lwaGVy${seq}`,
  };
}

/** A chainable fake of the ioredis pipeline that records calls and returns canned exec data. */
function fakeRedis(execResult: unknown) {
  const calls: Array<[string, unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const cmd of ['rpush', 'ltrim', 'expire', 'lrange', 'del'] as const) {
    chain[cmd] = (...args: unknown[]) => {
      calls.push([cmd, args]);
      return chain;
    };
  }
  chain.exec = jest.fn().mockResolvedValue(execResult);
  const redis = { multi: jest.fn().mockReturnValue(chain) };
  return { redis, calls, chain };
}

function buildService(execResult: unknown = []) {
  const { redis, calls, chain } = fakeRedis(execResult);
  const service = new OfflineQueueService(redis as unknown as ConstructorParameters<typeof OfflineQueueService>[0]);
  return { service, calls, chain };
}

describe('OfflineQueueService.enqueue', () => {
  it('appends to the tail, trims to the cap, and sets the TTL in one transaction', async () => {
    const { service, calls } = buildService([]);
    const envelope = buildEnvelope(1);

    await service.enqueue(RECIPIENT, envelope);

    expect(calls).toEqual([
      ['rpush', [KEY, JSON.stringify(envelope)]],
      ['ltrim', [KEY, -MAX_QUEUED_MESSAGES, -1]],
      ['expire', [KEY, QUEUE_TTL_SECONDS]],
    ]);
  });
});

describe('OfflineQueueService.drain', () => {
  it('returns queued envelopes in FIFO order and atomically deletes the queue', async () => {
    const queued = [buildEnvelope(1), buildEnvelope(2), buildEnvelope(3)];
    const exec = [
      [null, queued.map((e) => JSON.stringify(e))],
      [null, 1],
    ];
    const { service, calls } = buildService(exec);

    const drained = await service.drain(RECIPIENT);

    expect(drained).toEqual(queued);
    expect(calls).toEqual([
      ['lrange', [KEY, 0, -1]],
      ['del', [KEY]],
    ]);
  });

  it('returns an empty array when nothing is queued', async () => {
    const { service } = buildService([
      [null, []],
      [null, 0],
    ]);
    expect(await service.drain(RECIPIENT)).toEqual([]);
  });

  it('skips malformed entries rather than failing the whole drain', async () => {
    const good = buildEnvelope(7);
    const { service } = buildService([
      [null, ['not-json{', JSON.stringify(good)]],
      [null, 1],
    ]);

    expect(await service.drain(RECIPIENT)).toEqual([good]);
  });

  it('treats an aborted transaction (null exec) as nothing drained', async () => {
    const { service } = buildService(null);
    expect(await service.drain(RECIPIENT)).toEqual([]);
  });
});
