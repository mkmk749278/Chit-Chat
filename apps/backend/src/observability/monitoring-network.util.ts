/**
 * Framework-agnostic monitoring-network access control (Requirements 12.7, 13.6).
 *
 * The Prometheus `/metrics` endpoint must be reachable *only* from the monitoring
 * network. This module holds the security-sensitive decision — "is this source IP
 * inside the monitoring allowlist?" — as pure functions so the rule can be unit /
 * property tested without booting NestJS.
 *
 * Design notes:
 *   - The allowlist is a set of CIDR ranges. The default set is the loopback and
 *     RFC1918 / RFC4193 private ranges, which is exactly where the Prometheus
 *     scraper lives: in the deployment it shares the Docker `monitoring` bridge
 *     network with the backend (infra/docker/docker-compose.yml), so its source
 *     address is always a private/container address. Public clients are therefore
 *     rejected by default.
 *   - Operators can override the allowlist via the `MONITORING_CIDRS` env var
 *     (comma-separated CIDRs) when the scraper sits on a known external subnet.
 *   - Access control must NOT trust the `X-Forwarded-For` header (it is
 *     client-controllable and trivially spoofable). The caller is expected to use
 *     the real transport source address (`req.socket.remoteAddress`).
 */

/**
 * Default monitoring allowlist: loopback + private (non-routable) ranges. These
 * are the only places a co-located Prometheus scraper can originate from, so any
 * request from a public address is denied unless an operator widens the list.
 */
export const DEFAULT_MONITORING_CIDRS: readonly string[] = [
  '127.0.0.0/8', // IPv4 loopback
  '10.0.0.0/8', // RFC1918 private
  '172.16.0.0/12', // RFC1918 private (Docker default bridge subnets live here)
  '192.168.0.0/16', // RFC1918 private
  '::1/128', // IPv6 loopback
  'fc00::/7', // RFC4193 unique-local
  'fe80::/10', // IPv6 link-local
];

/** An IP address parsed into its version and 128/32-bit numeric value. */
interface ParsedIp {
  readonly version: 4 | 6;
  readonly value: bigint;
}

/** A CIDR range parsed into its network address and prefix length. */
interface ParsedCidr {
  readonly version: 4 | 6;
  readonly network: bigint;
  readonly prefix: number;
}

/**
 * Parse the raw `MONITORING_CIDRS` configuration value into an allowlist.
 *
 * Accepts a comma- (or whitespace-) separated list of CIDRs. When the value is
 * absent or blank, the {@link DEFAULT_MONITORING_CIDRS} are used so the endpoint is
 * always locked down to private/loopback ranges out of the box. Entries that are
 * not valid CIDRs are ignored defensively; if every entry is invalid the defaults
 * are restored so a typo can never silently open the endpoint to the world.
 */
export function parseMonitoringCidrs(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null || raw.trim().length === 0) {
    return [...DEFAULT_MONITORING_CIDRS];
  }

  const entries = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => parseCidr(entry) !== null);

  return entries.length > 0 ? entries : [...DEFAULT_MONITORING_CIDRS];
}

/**
 * Normalise a transport/source IP string into a comparable form:
 *   - strips an IPv6 zone id (`fe80::1%eth0` → `fe80::1`);
 *   - unwraps an IPv4-mapped IPv6 address (`::ffff:127.0.0.1` → `127.0.0.1`) so it
 *     is matched against IPv4 CIDRs as the operator expects.
 */
export function normalizeIp(ip: string): string {
  let value = ip.trim();
  const zone = value.indexOf('%');
  if (zone !== -1) {
    value = value.slice(0, zone);
  }
  const mappedPrefix = /^::ffff:/i;
  if (mappedPrefix.test(value)) {
    const tail = value.replace(mappedPrefix, '');
    if (isIpv4(tail)) {
      return tail;
    }
  }
  return value;
}

/**
 * Decide whether `ip` falls within any CIDR in `cidrs`.
 *
 * Returns `false` for an empty/undefined ip, an unparseable ip, or when no range
 * matches — i.e. the secure default is to deny. The check is exact and
 * version-aware: an IPv4 address only matches IPv4 ranges and vice versa.
 */
export function isIpAllowed(ip: string | undefined | null, cidrs: readonly string[]): boolean {
  if (ip === undefined || ip === null || ip.trim().length === 0) {
    return false;
  }
  const parsed = parseIp(normalizeIp(ip));
  if (parsed === null) {
    return false;
  }
  return cidrs.some((cidr) => {
    const range = parseCidr(cidr);
    return range !== null && ipInRange(parsed, range);
  });
}

/** True when `parsed` is contained in the CIDR `range`. */
function ipInRange(parsed: ParsedIp, range: ParsedCidr): boolean {
  if (parsed.version !== range.version) {
    return false;
  }
  const totalBits = range.version === 4 ? 32 : 128;
  const hostBits = BigInt(totalBits - range.prefix);
  // Mask off the host portion of both addresses and compare the network parts.
  const ipNetwork = hostBits === 0n ? parsed.value : (parsed.value >> hostBits) << hostBits;
  return ipNetwork === range.network;
}

/** Parse a CIDR string (`a.b.c.d/prefix` or `ipv6/prefix`) or return null. */
export function parseCidr(cidr: string): ParsedCidr | null {
  const slash = cidr.indexOf('/');
  if (slash === -1) {
    return null;
  }
  const address = cidr.slice(0, slash);
  const prefixText = cidr.slice(slash + 1);

  const parsedIp = parseIp(address);
  if (parsedIp === null) {
    return null;
  }

  if (!/^\d+$/.test(prefixText)) {
    return null;
  }
  const prefix = Number(prefixText);
  const maxPrefix = parsedIp.version === 4 ? 32 : 128;
  if (prefix < 0 || prefix > maxPrefix) {
    return null;
  }

  const hostBits = BigInt(maxPrefix - prefix);
  const network = hostBits === 0n ? parsedIp.value : (parsedIp.value >> hostBits) << hostBits;
  return { version: parsedIp.version, network, prefix };
}

/** Parse an IPv4 or IPv6 address into {@link ParsedIp} or return null. */
function parseIp(ip: string): ParsedIp | null {
  if (isIpv4(ip)) {
    return { version: 4, value: ipv4ToBigInt(ip) };
  }
  const v6 = ipv6ToBigInt(ip);
  return v6 === null ? null : { version: 6, value: v6 };
}

/** True when `value` is a syntactically valid dotted-quad IPv4 address. */
function isIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

/** Convert a validated IPv4 address to its 32-bit integer value. */
function ipv4ToBigInt(ip: string): bigint {
  return ip
    .split('.')
    .reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n);
}

/**
 * Convert an IPv6 address (with optional `::` compression and optional embedded
 * IPv4 tail) to its 128-bit integer value, or return null when malformed.
 */
function ipv6ToBigInt(ip: string): bigint | null {
  if (ip.length === 0 || !ip.includes(':')) {
    return null;
  }

  const doubleColon = ip.split('::');
  if (doubleColon.length > 2) {
    return null; // at most one "::" is allowed
  }

  const expandHextets = (segment: string): string[] | null => {
    if (segment.length === 0) {
      return [];
    }
    const groups: string[] = [];
    for (const group of segment.split(':')) {
      if (group.includes('.')) {
        // Embedded IPv4 tail (e.g. "::ffff:1.2.3.4") → two hextets.
        if (!isIpv4(group)) {
          return null;
        }
        const v4 = ipv4ToBigInt(group);
        groups.push(((v4 >> 16n) & 0xffffn).toString(16));
        groups.push((v4 & 0xffffn).toString(16));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
          return null;
        }
        groups.push(group);
      }
    }
    return groups;
  };

  let hextets: string[];
  if (doubleColon.length === 2) {
    const head = expandHextets(doubleColon[0]);
    const tail = expandHextets(doubleColon[1]);
    if (head === null || tail === null) {
      return null;
    }
    const fill = 8 - head.length - tail.length;
    if (fill < 0) {
      return null;
    }
    hextets = [...head, ...new Array<string>(fill).fill('0'), ...tail];
  } else {
    const all = expandHextets(ip);
    if (all === null) {
      return null;
    }
    hextets = all;
  }

  if (hextets.length !== 8) {
    return null;
  }

  return hextets.reduce((acc, hextet) => (acc << 16n) + BigInt(parseInt(hextet, 16)), 0n);
}
