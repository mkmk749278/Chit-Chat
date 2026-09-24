import type { CiphertextEnvelope } from '@chat-app/types';

import {
  INBOX_TTL_SECONDS,
  InboxService,
  MAX_ACK_IDS_PER_FRAME,
  MAX_INBOX_ENTRIES,
} from './inbox.service';

/**
 * Unit tests for {@link InboxService} (reliable delivery, protocol v2). A fake `ioredis` records
 * the pipeline calls and feeds back canned replies, so the test asserts the stream bounds (length
 * cap, age trim, idle TTL), non-destructive replay, id-validated acknowledgement, the legacy
 * destructive drain, and that corrupt entries are skipped — without a real Redis.
 */

const RECIPIENT = 'recipient-uid';
const KEY = `inbox:${RECIPIENT}`;

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

/** A stream reply entry as ioredis returns it: `[id, [field, value]]`. */
function streamEntry(id: string, envelope: CiphertextEnvelope | string): [string, string[]] {
  return [id, ['e', typeof envelope === 'string' ? envelope : JSON.stringify(envelope)]];
}

function fakeRedis(opts: { execResult?: unknown; xrange?: unknown; xdel?: number; eval?: unknown }) {
  const calls: Array<[string, unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const cmd of ['xadd', 'xtrim', 'expire', 'xrange', 'del'] as const) {
    chain[cmd] = (...args: unknown[]) => {
      calls.push([cmd, args]);
      return chain;
    };
  }
  chain.exec = jest.fn().mockResolvedValue(opts.execResult ?? []);
  const redis = {
    multi: jest.fn().mockReturnValue(chain),
    xrange: jest.fn().mockResolvedValue(opts.xrange ?? []),
    xdel: jest.fn().mockResolvedValue(opts.xdel ?? 0),
    eval: jest.fn().mockResolvedValue(opts.eval ?? 0),
  };
  const service = new InboxService(redis as unknown as ConstructorParameters<typeof InboxService>[0]);
  return { service, redis, calls };
}

describe('InboxService.append', () => {
  it('adds to the stream with the length cap, age trim, and idle TTL in one transaction', async () => {
    const { service, calls } = fakeRedis({ execResult: [[null, '1700000000000-0'], [null, 0], [null, 1]] });
    const envelope = buildEnvelope(1);
    const before = Date.now();

    const id = await service.append(RECIPIENT, envelope);

    expect(id).toBe('1700000000000-0');
    expect(calls[0]).toEqual([
      'xadd',
      [KEY, 'MAXLEN', MAX_INBOX_ENTRIES, '*', 'e', JSON.stringify(envelope)],
    ]);
    const [cmd, [key, strategy, minId]] = calls[1] as [string, [string, string, string]];
    expect([cmd, key, strategy]).toEqual(['xtrim', KEY, 'MINID']);
    const cutoff = Number(minId);
    expect(cutoff).toBeGreaterThanOrEqual(before - INBOX_TTL_SECONDS * 1000);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - INBOX_TTL_SECONDS * 1000);
    expect(calls[2]).toEqual(['expire', [KEY, INBOX_TTL_SECONDS]]);
  });

  it('throws when the write fails, so the relay never ACKs an unstored message', async () => {
    const { service } = fakeRedis({ execResult: [[new Error('OOM'), null]] });
    await expect(service.append(RECIPIENT, buildEnvelope(1))).rejects.toThrow('inbox append failed');
  });

  it('throws when the transaction is aborted', async () => {
    const { service } = fakeRedis({ execResult: null });
    await expect(service.append(RECIPIENT, buildEnvelope(1))).rejects.toThrow();
  });
});

describe('InboxService.list', () => {
  it('replays pending entries in order WITHOUT deleting them', async () => {
    const e1 = buildEnvelope(1);
    const e2 = buildEnvelope(2);
    const { service, redis } = fakeRedis({ xrange: [streamEntry('1-0', e1), streamEntry('2-0', e2)] });

    const entries = await service.list(RECIPIENT);

    expect(entries).toEqual([
      { id: '1-0', envelope: e1 },
      { id: '2-0', envelope: e2 },
    ]);
    expect(redis.xrange).toHaveBeenCalledWith(KEY, '-', '+', 'COUNT', MAX_INBOX_ENTRIES);
    expect(redis.multi).not.toHaveBeenCalled();
    expect(redis.xdel).not.toHaveBeenCalled();
  });

  it('skips corrupt entries instead of failing the whole replay', async () => {
    const e2 = buildEnvelope(2);
    const { service } = fakeRedis({
      xrange: [streamEntry('1-0', '{not json'), ['2-0', ['x', 'y']], streamEntry('3-0', e2)],
    });
    expect(await service.list(RECIPIENT)).toEqual([{ id: '3-0', envelope: e2 }]);
  });
});

describe('InboxService.ack', () => {
  it('deletes only well-formed stream ids from the caller inbox', async () => {
    const { service, redis } = fakeRedis({ xdel: 2 });

    const removed = await service.ack(RECIPIENT, ['1-0', 'bogus', 42, '2-5', '../x']);

    expect(removed).toBe(2);
    expect(redis.xdel).toHaveBeenCalledWith(KEY, '1-0', '2-5');
  });

  it('is a no-op (no Redis call) when nothing valid is supplied', async () => {
    const { service, redis } = fakeRedis({});
    expect(await service.ack(RECIPIENT, ['nope'])).toBe(0);
    expect(redis.xdel).not.toHaveBeenCalled();
  });

  it(`processes at most ${MAX_ACK_IDS_PER_FRAME} ids per call`, async () => {
    const { service, redis } = fakeRedis({});
    const ids = Array.from({ length: MAX_ACK_IDS_PER_FRAME + 50 }, (_v, i) => `${i + 1}-0`);
    await service.ack(RECIPIENT, ids);
    const args = redis.xdel.mock.calls[0] as string[];
    expect(args).toHaveLength(MAX_ACK_IDS_PER_FRAME + 1); // key + ids
  });
});

describe('InboxService.takeAll (legacy clients)', () => {
  it('reads and deletes the whole inbox atomically', async () => {
    const e1 = buildEnvelope(1);
    const { service, calls } = fakeRedis({
      execResult: [[null, [streamEntry('1-0', e1)]], [null, 1]],
    });

    const entries = await service.takeAll(RECIPIENT);

    expect(entries).toEqual([{ id: '1-0', envelope: e1 }]);
    expect(calls).toEqual([
      ['xrange', [KEY, '-', '+']],
      ['del', [KEY]],
    ]);
  });

  it('returns nothing when the transaction is aborted', async () => {
    const { service } = fakeRedis({ execResult: null });
    expect(await service.takeAll(RECIPIENT)).toEqual([]);
  });
});

describe('InboxService.migrateLegacy', () => {
  it('moves the pre-v2 offline list into the stream with one atomic script', async () => {
    const { service, redis } = fakeRedis({ eval: 3 });

    expect(await service.migrateLegacy(RECIPIENT)).toBe(3);

    const [, numKeys, legacyKey, inboxKey, maxLen, ttl] = redis.eval.mock.calls[0] as unknown[];
    expect(numKeys).toBe(2);
    expect(legacyKey).toBe(`offline:${RECIPIENT}`);
    expect(inboxKey).toBe(KEY);
    expect(maxLen).toBe(MAX_INBOX_ENTRIES);
    expect(ttl).toBe(INBOX_TTL_SECONDS);
  });
});
