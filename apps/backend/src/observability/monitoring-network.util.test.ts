import {
  DEFAULT_MONITORING_CIDRS,
  isIpAllowed,
  normalizeIp,
  parseCidr,
  parseMonitoringCidrs,
} from './monitoring-network.util';

/**
 * Unit tests for the monitoring-network access control logic (task 9.2,
 * Requirements 12.7 / 13.6). These are the security-critical decisions behind the
 * `/metrics` guard, so they are exercised directly without booting Nest.
 */
describe('parseMonitoringCidrs', () => {
  it('falls back to the private/loopback defaults when unset or blank', () => {
    expect(parseMonitoringCidrs(undefined)).toEqual([...DEFAULT_MONITORING_CIDRS]);
    expect(parseMonitoringCidrs(null)).toEqual([...DEFAULT_MONITORING_CIDRS]);
    expect(parseMonitoringCidrs('   ')).toEqual([...DEFAULT_MONITORING_CIDRS]);
  });

  it('parses a comma/whitespace-separated CIDR list', () => {
    expect(parseMonitoringCidrs('10.0.0.0/8, 192.168.0.0/16')).toEqual([
      '10.0.0.0/8',
      '192.168.0.0/16',
    ]);
  });

  it('restores the defaults when every supplied entry is invalid', () => {
    expect(parseMonitoringCidrs('not-a-cidr, also/bad')).toEqual([
      ...DEFAULT_MONITORING_CIDRS,
    ]);
  });
});

describe('parseCidr', () => {
  it('rejects values without a prefix or with an out-of-range prefix', () => {
    expect(parseCidr('10.0.0.0')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('::1/129')).toBeNull();
  });
});

describe('normalizeIp', () => {
  it('unwraps IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
  });

  it('strips an IPv6 zone id', () => {
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
  });
});

describe('isIpAllowed (default monitoring allowlist)', () => {
  const allow = (ip: string | undefined | null) =>
    isIpAllowed(ip, DEFAULT_MONITORING_CIDRS);

  it('allows loopback and private/container source addresses', () => {
    expect(allow('127.0.0.1')).toBe(true);
    expect(allow('10.1.2.3')).toBe(true);
    expect(allow('172.18.0.5')).toBe(true); // typical Docker bridge address
    expect(allow('192.168.1.10')).toBe(true);
    expect(allow('::1')).toBe(true);
    expect(allow('::ffff:10.0.0.4')).toBe(true); // IPv4-mapped private
  });

  it('rejects public addresses', () => {
    expect(allow('8.8.8.8')).toBe(false);
    expect(allow('203.0.113.7')).toBe(false);
    expect(allow('2001:4860:4860::8888')).toBe(false);
  });

  it('rejects boundary addresses just outside a private range', () => {
    expect(allow('172.15.255.255')).toBe(false); // just below 172.16.0.0/12
    expect(allow('172.32.0.0')).toBe(false); // just above 172.31.255.255
  });

  it('denies an empty, missing, or unparseable source address', () => {
    expect(allow(undefined)).toBe(false);
    expect(allow(null)).toBe(false);
    expect(allow('')).toBe(false);
    expect(allow('not-an-ip')).toBe(false);
  });
});

describe('isIpAllowed (custom allowlist)', () => {
  it('matches only the configured range and is version-aware', () => {
    const cidrs = ['198.51.100.0/24'];
    expect(isIpAllowed('198.51.100.42', cidrs)).toBe(true);
    expect(isIpAllowed('198.51.101.1', cidrs)).toBe(false);
    // An IPv4 address never matches an IPv6 range and vice versa.
    expect(isIpAllowed('::1', cidrs)).toBe(false);
  });
});
