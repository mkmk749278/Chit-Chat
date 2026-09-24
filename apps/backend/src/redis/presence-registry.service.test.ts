import {
  NODE_ALIVE_TTL_SECONDS,
  PRESENCE_TTL_SECONDS,
  PresenceRegistryService,
} from './presence-registry.service';

/**
 * Unit tests for the node-liveness side of {@link PresenceRegistryService}. Presence entries whose
 * owning node has no `node-alive:{nodeId}` marker (it crashed or was redeployed without running
 * disconnect cleanup) must be ignored and pruned — otherwise the relay treats the recipient as
 * online forever and publishes their messages into a channel nobody listens on.
 */

function build(opts: { entries?: Record<string, string>; markers?: Array<string | null> }) {
  const hgetall = jest.fn().mockResolvedValue(opts.entries ?? {});
  const mget = jest.fn().mockResolvedValue(opts.markers ?? []);
  const hdel = jest.fn().mockResolvedValue(1);
  const set = jest.fn().mockResolvedValue('OK');
  const del = jest.fn().mockResolvedValue(1);
  const pipelineCalls: Array<[string, unknown[]]> = [];
  const pipeline: Record<string, unknown> = {};
  for (const cmd of ['hset', 'expire'] as const) {
    pipeline[cmd] = (...args: unknown[]) => {
      pipelineCalls.push([cmd, args]);
      return pipeline;
    };
  }
  pipeline.exec = jest.fn().mockResolvedValue([]);
  const redis = { hgetall, mget, hdel, set, del, pipeline: () => pipeline };
  const service = new PresenceRegistryService(
    redis as unknown as ConstructorParameters<typeof PresenceRegistryService>[0],
  );
  return { service, hgetall, mget, hdel, set, del, pipelineCalls };
}

describe('PresenceRegistryService.lookupLive', () => {
  it('returns every entry when all owning nodes are alive (no prune)', async () => {
    const entries = { c1: 'node-a', c2: 'node-b' };
    const { service, hdel, mget } = build({ entries, markers: ['1', '1'] });

    expect(await service.lookupLive('bob')).toEqual(entries);
    expect(mget).toHaveBeenCalledWith('node-alive:node-a', 'node-alive:node-b');
    expect(hdel).not.toHaveBeenCalled();
  });

  it('drops and prunes entries owned by dead nodes', async () => {
    const { service, hdel } = build({
      entries: { c1: 'node-dead', c2: 'node-live', c3: 'node-dead' },
      markers: [null, '1'],
    });

    expect(await service.lookupLive('bob')).toEqual({ c2: 'node-live' });
    expect(hdel).toHaveBeenCalledWith('presence:bob', 'c1', 'c3');
  });

  it('is offline with no Redis marker lookup when there are no entries', async () => {
    const { service, mget } = build({ entries: {} });
    expect(await service.lookupLive('bob')).toEqual({});
    expect(await service.isOnline('bob')).toBe(false);
    expect(mget).not.toHaveBeenCalled();
  });

  it('reports offline when the only entry is stale', async () => {
    const { service } = build({ entries: { c1: 'node-dead' }, markers: [null] });
    expect(await service.isOnline('bob')).toBe(false);
  });

  it('still answers correctly when pruning fails', async () => {
    const { service, hdel } = build({ entries: { c1: 'node-dead' }, markers: [null] });
    hdel.mockRejectedValueOnce(new Error('redis down'));
    expect(await service.lookupLive('bob')).toEqual({});
  });
});

describe('PresenceRegistryService node liveness', () => {
  it('marks a node alive with a bounded TTL and clears it on shutdown', async () => {
    const { service, set, del } = build({});
    await service.markNodeAlive('node-a');
    expect(set).toHaveBeenCalledWith('node-alive:node-a', expect.any(String), 'EX', NODE_ALIVE_TTL_SECONDS);
    await service.clearNodeAlive('node-a');
    expect(del).toHaveBeenCalledWith('node-alive:node-a');
  });

  it('re-asserts held connections and refreshes their hash expiry in one pipeline', async () => {
    const { service, pipelineCalls } = build({});
    await service.refresh([{ uid: 'bob', connId: 'c1' }], 'node-a');
    expect(pipelineCalls).toEqual([
      ['hset', ['presence:bob', 'c1', 'node-a']],
      ['expire', ['presence:bob', PRESENCE_TTL_SECONDS]],
    ]);
  });
});
