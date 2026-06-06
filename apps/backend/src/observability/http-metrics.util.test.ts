import {
  extractClientIp,
  resolveMethodLabel,
  resolveRouteLabel,
  resolveStatusLabel,
} from './http-metrics.util';

/**
 * Unit tests for the HTTP metric label helpers (task 9.2, Requirement 12.3).
 */
describe('resolveRouteLabel', () => {
  it('prefers the matched route pattern (bounded cardinality)', () => {
    expect(
      resolveRouteLabel({ baseUrl: '/api', route: { path: '/devices/:id' } }),
    ).toBe('/api/devices/:id');
  });

  it('falls back to the URL path with the query string stripped', () => {
    expect(resolveRouteLabel({ url: '/ws/connect?token=secret' })).toBe('/ws/connect');
  });

  it('prefers originalUrl over url and defaults empty paths to "/"', () => {
    expect(resolveRouteLabel({ originalUrl: '/health', url: '/ignored' })).toBe('/health');
    expect(resolveRouteLabel({})).toBe('/');
  });
});

describe('resolveMethodLabel', () => {
  it('upper-cases the method and defaults to UNKNOWN', () => {
    expect(resolveMethodLabel('get')).toBe('GET');
    expect(resolveMethodLabel(undefined)).toBe('UNKNOWN');
  });
});

describe('resolveStatusLabel', () => {
  it('stringifies a numeric status and defaults to "0"', () => {
    expect(resolveStatusLabel(200)).toBe('200');
    expect(resolveStatusLabel(undefined)).toBe('0');
  });
});

describe('extractClientIp', () => {
  it('reads the real socket address, never X-Forwarded-For', () => {
    expect(
      extractClientIp({ socket: { remoteAddress: '10.0.0.9' }, ip: '1.2.3.4' }),
    ).toBe('10.0.0.9');
  });

  it('falls back to connection then req.ip', () => {
    expect(extractClientIp({ connection: { remoteAddress: '10.0.0.8' } })).toBe('10.0.0.8');
    expect(extractClientIp({ ip: '10.0.0.7' })).toBe('10.0.0.7');
    expect(extractClientIp({})).toBeUndefined();
  });
});
