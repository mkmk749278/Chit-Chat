import { HEALTH_PING_TIMEOUT_MS } from './health.constants';
import { HealthService } from './health.service';

/**
 * Unit tests for {@link HealthService} (task 8.1, Requirement 11). The service's dependency probes
 * are the truth source behind `/health`, so they are exercised directly with stub DataSource/Redis
 * clients rather than booting Nest:
 *
 * - `ok` iff both probes succeed; `degraded` with the failing dependency marked `down` otherwise
 *   (Requirements 11.1, 11.4).
 * - a probe that never settles is bounded by the ping budget and reported `down` (Requirement 11.5).
 * - the report body carries only non-sensitive fields (Requirement 11.3).
 */

type Stubs = {
  query: jest.Mock;
  ping: jest.Mock;
};

function buildService(stubs: Partial<Stubs> = {}): { service: HealthService } & Stubs {
  const query = stubs.query ?? jest.fn().mockResolvedValue([{ '?column?': 1 }]);
  const ping = stubs.ping ?? jest.fn().mockResolvedValue('PONG');
  const dataSource = { query } as unknown as ConstructorParameters<typeof HealthService>[0];
  const redis = { ping } as unknown as ConstructorParameters<typeof HealthService>[1];
  return { service: new HealthService(dataSource, redis), query, ping };
}

describe('HealthService.check', () => {
  it('reports ok with both dependencies up when both pings succeed', async () => {
    const { service } = buildService();

    const report = await service.check();

    expect(report.status).toBe('ok');
    expect(report.checks).toEqual({ postgres: 'up', redis: 'up' });
  });

  it('reports degraded and marks postgres down when the SELECT fails', async () => {
    const { service } = buildService({
      query: jest.fn().mockRejectedValue(new Error('connection refused')),
    });

    const report = await service.check();

    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({ postgres: 'down', redis: 'up' });
  });

  it('reports degraded and marks redis down when the PING fails', async () => {
    const { service } = buildService({
      ping: jest.fn().mockRejectedValue(new Error('NOAUTH')),
    });

    const report = await service.check();

    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({ postgres: 'up', redis: 'down' });
  });

  it('marks both dependencies down when neither ping succeeds', async () => {
    const { service } = buildService({
      query: jest.fn().mockRejectedValue(new Error('down')),
      ping: jest.fn().mockRejectedValue(new Error('down')),
    });

    const report = await service.check();

    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({ postgres: 'down', redis: 'down' });
  });

  it('bounds a stalled dependency by the ping budget and reports it down', async () => {
    jest.useFakeTimers();
    try {
      // A probe that never settles must not hang the endpoint (Requirement 11.5).
      const { service } = buildService({
        query: jest.fn().mockReturnValue(new Promise(() => {})),
      });

      const pending = service.check();
      await jest.advanceTimersByTimeAsync(HEALTH_PING_TIMEOUT_MS);
      const report = await pending;

      expect(report.status).toBe('degraded');
      expect(report.checks.postgres).toBe('down');
      expect(report.checks.redis).toBe('up');
    } finally {
      jest.useRealTimers();
    }
  });

  it('restricts the report to non-sensitive fields only', async () => {
    const { service } = buildService();

    const report = await service.check();

    expect(Object.keys(report).sort()).toEqual(
      ['checks', 'status', 'uptimeSeconds', 'version'].sort(),
    );
    expect(typeof report.uptimeSeconds).toBe('number');
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof report.version).toBe('string');
  });
});
