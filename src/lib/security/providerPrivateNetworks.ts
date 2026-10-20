/**
 * Private networks that provider endpoints may reach, per organization.
 *
 * The provider endpoint guard (`providerEndpointGuard`) refuses private, loopback and link-local targets wherever
 * it blocks them: always on SaaS, and on a self-hosted deployment that sets `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK=true`.
 * A customer's own store or model server (MinIO, Ceph, a GridFS database, vLLM) sits on a private address of the
 * customer's network, which the operator has connected to the deployment (a VPN, a peering). This module is the
 * operator's list of those networks.
 *
 *   PROVIDER_PRIVATE_NETWORKS="<tenantId or *>=<cidr>[,<cidr>...];..."
 *   PROVIDER_PRIVATE_NETWORKS_DENY="<cidr>,<cidr>,..."
 *
 * - Entries are separated by `;`. `*` stands for every organization. Two entries for one organization merge.
 *   Whitespace around the pieces is ignored. IPv4 and IPv6 ranges are accepted and a bare address is one host.
 * - Ranges only, never host names: a name entry would trust whatever the name resolves to.
 * - An entry or range that cannot be read opens nothing, and is reported once at boot (`logProviderPrivateNetworks`).
 *   A deny list that cannot be read closes everything, since what it was meant to keep out is unknown.
 * - The deny ranges stay refused inside an opened network. So do these, which no entry can open:
 *   0.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16 (link-local, the cloud metadata services), 168.63.129.16, 100.100.100.200,
 *   192.0.0.0/24, 224.0.0.0/3, `::`, `::1`, fe80::/10, ff00::/8, fd00:ec2::254, every IPv6 form that carries an IPv4
 *   address (compatible, translated, NAT64, 6to4, Teredo) and every address of this machine's network interfaces
 *   (plus `KUBERNETES_SERVICE_HOST` when it is an address). An IPv4-mapped IPv6 address is matched as the IPv4
 *   address it carries.
 *
 * The decision for one address is `guardRefusesAddress` in `outboundFetch`: a public address is not this module's
 * concern, a private one passes only when `permits` says so. The opened networks are looked up by organization at
 * every call site; no organization means none opened.
 */

import os from 'node:os';

import { getConfig, getConfigSource } from '@/lib/core/config';
import type { PrivateNetworkAllowance } from '@/lib/security/outboundFetch';
import {
  checkCidr,
  ipMatchesRange,
  isRangeWithin,
  parseClientIp,
  type ParsedCidr,
  type ParsedIp,
} from '@/lib/services/apiTokens/ipAllowlist';

/** `*` in place of an organization id: the ranges are opened for every organization. */
const WILDCARD = '*';
/** An organization id as the databases write it (an ObjectId, a UUID). */
const TENANT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Longest piece of configuration text that is written to a log line. */
const MAX_LOGGED_TEXT = 64;

/** Ranges no entry can open. */
const ALWAYS_REFUSED_TEXT: readonly string[] = [
  '0.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '168.63.129.16/32',
  '100.100.100.200/32',
  '192.0.0.0/24',
  '224.0.0.0/3',
  '255.255.255.255/32',
  '::/128',
  '::1/128',
  'fe80::/10',
  'ff00::/8',
  'fd00:ec2::254/128',
  // IPv6 forms that carry an IPv4 address keep the verdict they always had and are never opened. (The plain
  // IPv4-mapped form is not here: it is matched as the IPv4 address it carries.)
  '::/96', // IPv4-compatible
  '::ffff:0:0:0/96', // IPv4-translated
  '64:ff9b::/96', // NAT64
  '64:ff9b:1::/48', // local-use NAT64
  '2002::/16', // 6to4
  '2001::/32', // Teredo
];

const ALWAYS_REFUSED: readonly ParsedCidr[] = ALWAYS_REFUSED_TEXT.map((text) => {
  const check = checkCidr(text);
  if (!check.ok) throw new Error(`providerPrivateNetworks: the built-in range ${text} does not parse`);
  return check.cidr;
});

interface Range {
  /** The range as written back by `checkCidr`. */
  readonly text: string;
  readonly cidr: ParsedCidr;
}

export interface ProviderPrivateNetworksReport {
  /** Organizations with at least one opened range of their own. */
  tenants: number;
  /** Opened ranges, the ones for every organization included. */
  ranges: number;
  /** Of those, the ranges opened for every organization. */
  wildcardRanges: number;
  /** Deny ranges that were read. */
  denyRanges: number;
  /** Entries and ranges of `PROVIDER_PRIVATE_NETWORKS` that open nothing, cut to a loggable length. */
  invalid: string[];
  /** Tokens of `PROVIDER_PRIVATE_NETWORKS_DENY` that could not be read. */
  invalidDeny: string[];
  /** Opened ranges that contain addresses which are never opened; that part stays refused. */
  overlaps: Array<{ range: string; with: Array<'built-in' | 'deny' | 'own-address'> }>;
  /** Nothing is opened for anyone, and why. Absent when the policy works. */
  closed?: string;
}

export interface ProviderPrivateNetworkPolicy {
  /**
   * The networks opened for one organization (its own entries plus those for every organization), or `undefined`
   * when it has none. No organization id means none: the answer fails closed.
   */
  forTenant(tenantId: string | undefined): PrivateNetworkAllowance | undefined;
  /** Whether the policy never opens `address`: a built-in range, a deny range or an address of this machine. */
  isAlwaysRefused(address: string): boolean;
  readonly report: ProviderPrivateNetworksReport;
}

export interface CompileInput {
  /** `PROVIDER_PRIVATE_NETWORKS`, already split at `;`. */
  entries: readonly string[];
  /** `PROVIDER_PRIVATE_NETWORKS_DENY`, already split at `,`. */
  deny: readonly string[];
  /** The addresses of this machine, as text. `null` when they could not be read. */
  ownAddresses: readonly string[] | null;
}

/** Text that goes into a log line: cut to a fixed length, with control characters replaced. */
function excerpt(text: string): string {
  return Array.from(text.slice(0, MAX_LOGGED_TEXT), (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : char;
  }).join('');
}

function toRange(text: string): Range | null {
  const check = checkCidr(text);
  return check.ok ? { text: check.normalized, cidr: check.cidr } : null;
}

/** Whether two ranges share an address. Ranges nest or are disjoint, so one containing the other is the test. */
function overlaps(a: ParsedCidr, b: ParsedCidr): boolean {
  return isRangeWithin(a, b) || isRangeWithin(b, a);
}

function hostRange(text: string): ParsedCidr | null {
  const ip = parseClientIp(text);
  return ip ? { ...ip, prefix: ip.family === 4 ? 32 : 128 } : null;
}

/**
 * Reads `PROVIDER_PRIVATE_NETWORKS` and its deny list into a policy. Pure: the machine's own addresses are an
 * input, so tests can state them.
 */
export function compileProviderPrivateNetworks(input: CompileInput): ProviderPrivateNetworkPolicy {
  const invalid: string[] = [];
  const byTenant = new Map<string, Range[]>();
  const wildcard: Range[] = [];

  for (const raw of input.entries) {
    const entry = raw.trim();
    if (entry === '') continue;
    const equals = entry.indexOf('=');
    const tenant = equals === -1 ? '' : entry.slice(0, equals).trim();
    if (equals === -1 || (tenant !== WILDCARD && !TENANT_TOKEN.test(tenant))) {
      invalid.push(excerpt(entry));
      continue;
    }

    const opened: Range[] = [];
    const invalidBefore = invalid.length;
    for (const token of entry.slice(equals + 1).split(',')) {
      const text = token.trim();
      if (text === '') continue;
      const range = toRange(text);
      if (range) opened.push(range);
      else invalid.push(excerpt(text));
    }
    // An entry that names no range at all (`tenant=`) is as unreadable as one that names nothing readable.
    if (opened.length === 0 && invalid.length === invalidBefore) invalid.push(excerpt(entry));
    if (opened.length === 0) continue;

    if (tenant === WILDCARD) {
      wildcard.push(...opened);
    } else {
      const existing = byTenant.get(tenant);
      if (existing) existing.push(...opened);
      else byTenant.set(tenant, opened);
    }
  }

  const deny: Range[] = [];
  const invalidDeny: string[] = [];
  for (const raw of input.deny) {
    const text = raw.trim();
    if (text === '') continue;
    const range = toRange(text);
    if (range) deny.push(range);
    else invalidDeny.push(excerpt(text));
  }

  const own: ParsedCidr[] = [];
  for (const address of input.ownAddresses ?? []) {
    const range = hostRange(address);
    if (range) own.push(range);
  }

  // A deny list that cannot be read, or a machine whose addresses are unknown, leaves no way to say what has to
  // stay out: nothing is opened until that is fixed.
  let closed: string | undefined;
  if (invalidDeny.length > 0) closed = 'PROVIDER_PRIVATE_NETWORKS_DENY has entries that cannot be read';
  else if (input.ownAddresses === null) closed = 'the network addresses of this machine could not be read';

  const refused: readonly ParsedCidr[] = [...ALWAYS_REFUSED, ...deny.map((range) => range.cidr), ...own];
  const refusesAddress = (ip: ParsedIp): boolean => refused.some((range) => ipMatchesRange(ip, range));

  const allowanceOf = (ranges: readonly Range[]): PrivateNetworkAllowance => {
    const cidrs = ranges.map((range) => range.cidr);
    return Object.freeze({
      hasRanges: cidrs.length > 0,
      permits(address: string): boolean {
        const ip = parseClientIp(address);
        if (!ip) return false;
        if (refusesAddress(ip)) return false;
        return cidrs.some((range) => ipMatchesRange(ip, range));
      },
    });
  };

  const wildcardAllowance = wildcard.length > 0 ? allowanceOf(wildcard) : undefined;
  const perTenant = new Map<string, PrivateNetworkAllowance>();
  for (const [tenant, ranges] of byTenant) perTenant.set(tenant, allowanceOf([...ranges, ...wildcard]));

  const overlapping: ProviderPrivateNetworksReport['overlaps'] = [];
  const seen = new Set<string>();
  for (const range of [...wildcard, ...[...byTenant.values()].flat()]) {
    if (seen.has(range.text)) continue;
    seen.add(range.text);
    const found: Array<'built-in' | 'deny' | 'own-address'> = [];
    if (ALWAYS_REFUSED.some((other) => overlaps(range.cidr, other))) found.push('built-in');
    if (deny.some((other) => overlaps(range.cidr, other.cidr))) found.push('deny');
    if (own.some((other) => overlaps(range.cidr, other))) found.push('own-address');
    if (found.length > 0) overlapping.push({ range: excerpt(range.text), with: found });
  }

  const rangeCount = wildcard.length + [...byTenant.values()].reduce((sum, ranges) => sum + ranges.length, 0);
  return {
    forTenant(tenantId) {
      if (closed || typeof tenantId !== 'string' || tenantId === '') return undefined;
      return perTenant.get(tenantId) ?? wildcardAllowance;
    },
    isAlwaysRefused(address) {
      const ip = parseClientIp(address);
      return !ip || refusesAddress(ip);
    },
    report: {
      tenants: byTenant.size,
      ranges: rangeCount,
      wildcardRanges: wildcard.length,
      denyRanges: deny.length,
      invalid,
      invalidDeny,
      overlaps: overlapping,
      ...(closed ? { closed } : {}),
    },
  };
}

/** Every address of this machine's network interfaces, plus the cluster API server's when it is an address. `null` when they cannot be read. */
function readOwnAddresses(kubernetesServiceHost: string): string[] | null {
  let interfaces: ReturnType<typeof os.networkInterfaces>;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return null;
  }
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) addresses.push(entry.address);
  }
  if (kubernetesServiceHost !== '') addresses.push(kubernetesServiceHost);
  return addresses;
}

let memo: { settings: object; kubernetesServiceHost: string; policy: ProviderPrivateNetworkPolicy } | undefined;

/**
 * The policy for the current configuration, built once: it is rebuilt when the configuration object changes (a new
 * config source, a reload) and when `KUBERNETES_SERVICE_HOST` does. The machine's interface addresses are read when
 * it is built, and only when some range is configured.
 */
export function getProviderPrivateNetworks(): ProviderPrivateNetworkPolicy {
  const settings = getConfig().outboundHttp;
  const kubernetesServiceHost = (getConfigSource().get('KUBERNETES_SERVICE_HOST') ?? '').trim();
  if (!memo || memo.settings !== settings || memo.kubernetesServiceHost !== kubernetesServiceHost) {
    const entries = settings.providerPrivateNetworks ?? [];
    memo = {
      settings,
      kubernetesServiceHost,
      policy: compileProviderPrivateNetworks({
        entries,
        deny: settings.providerPrivateNetworksDeny ?? [],
        ownAddresses: entries.length > 0 ? readOwnAddresses(kubernetesServiceHost) : [],
      }),
    };
  }
  return memo.policy;
}

/** Forgets the built policy, so the next read builds it again (after a test changed the environment it reads). */
export function resetProviderPrivateNetworksForTests(): void {
  memo = undefined;
}

type LogMethod = (message: string, meta?: Record<string, unknown>) => unknown;

/** The part of a logger this module writes to. */
export interface ProviderPrivateNetworksLogger {
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

/**
 * The startup report: one line with the counts, and a line each for what opens nothing and what overlaps the
 * addresses that are never opened. The ranges themselves are not written out; the offending text of an unreadable
 * entry is, cut to 64 characters.
 */
export function logProviderPrivateNetworks(log: ProviderPrivateNetworksLogger): void {
  const { report } = getProviderPrivateNetworks();
  log.info(
    `Provider private networks: ${report.tenants} organization(s) with ranges of their own, ${report.ranges} opened range(s) `
    + `(${report.wildcardRanges} for every organization), ${report.denyRanges} deny range(s)`,
    {
      tenants: report.tenants,
      ranges: report.ranges,
      wildcardRanges: report.wildcardRanges,
      denyRanges: report.denyRanges,
    },
  );
  if (report.invalid.length > 0) {
    log.error(
      `PROVIDER_PRIVATE_NETWORKS has ${report.invalid.length} entr${report.invalid.length === 1 ? 'y' : 'ies'} that cannot be read; `
      + 'they open nothing',
      { invalid: report.invalid },
    );
  }
  if (report.invalidDeny.length > 0) {
    log.error(
      'PROVIDER_PRIVATE_NETWORKS_DENY has entries that cannot be read; no private network is opened until they are fixed',
      { invalid: report.invalidDeny },
    );
  }
  if (report.closed && report.invalidDeny.length === 0) {
    log.warn(`No private network is opened: ${report.closed}`);
  }
  if (report.overlaps.length > 0) {
    log.warn(
      'Opened private network ranges contain addresses that are never opened (the overlapping part stays refused)',
      { ranges: report.overlaps },
    );
  }
}
