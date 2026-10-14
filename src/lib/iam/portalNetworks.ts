/**
 * A portal's NETWORK BOUNDARY: the list of address ranges the portal may be used from.
 *
 * The setting lives on the portal (`access.networks { mode, cidrs }`) and reaches the
 * policy engine as attributes of the Portal entity (portalEntities.ts), where the managed
 * rules `managed:portal:network-boundary` / `managed:portal:agent-network-boundary`
 * compare the request's `context.ip` with them (Cedar `ipaddr.isInRange`). Nothing is
 * stored per portal as policy text.
 *
 * Why numbered attributes (`net0` ... `net31`) and not one set: Cedar can test whether an
 * address is in ONE range, but it has no way to ask "in any range of this set". The rule is
 * therefore written over a fixed number of optional slots, and PORTAL_MAX_NETWORKS is the
 * number of slots. Aggregate ranges (a /16 instead of 256 /24s) when a list gets longer.
 *
 * This module is pure: it validates and normalises the setting (what the portal form saves),
 * builds the entity attributes (what the engine reads) and answers "is this address inside
 * the list?" in plain TypeScript (what the form's self-test shows, so an administrator sees
 * whether their own address would be let in before they save). A parity test keeps the
 * TypeScript answer and the Cedar answer identical.
 *
 * Fail closed: an `allow_list` that ends up with no usable range admits nobody, and an
 * address the engine could not read is never inside the list.
 */

import { normalizeIp, parseCidr } from './context';

/** Ranges one portal can list (the number of `netN` slots in the managed rules and in the schema). */
export const PORTAL_MAX_NETWORKS = 32;

export type PortalNetworkMode = 'any' | 'allow_list';

/** The stored form of the setting (`access.networks`, without the host's refusal message). */
export interface PortalNetworks {
  mode: PortalNetworkMode;
  /** Normalised CIDR texts (`10.0.0.0/8`, `192.168.1.7` for one address, `2001:db8::/32`), without duplicates. */
  cidrs: string[];
}

export const NO_PORTAL_NETWORKS: Readonly<PortalNetworks> = Object.freeze({ mode: 'any', cidrs: [] as string[] });

export type PortalNetworksIssueCode =
  | 'not_an_object'
  | 'invalid_mode'
  | 'cidrs_not_a_list'
  | 'invalid_cidr'
  | 'too_many'
  | 'empty_allow_list';

export interface PortalNetworksIssue {
  code: PortalNetworksIssueCode;
  /** The entry the problem is about (position in the submitted list), when it is about one. */
  index?: number;
  value?: string;
  message: string;
}

export type PortalNetworksResult = { ok: true; value: PortalNetworks } | { ok: false; issues: PortalNetworksIssue[] };

/**
 * Validate and normalise the submitted setting. An absent or null setting is "any network".
 * Duplicates are folded, ranges are written in their canonical form, and an `allow_list` needs at least
 * one range (an empty one would lock everybody out, which is never what was meant).
 */
export function validatePortalNetworks(input: unknown): PortalNetworksResult {
  if (input === undefined || input === null) return { ok: true, value: { mode: 'any', cidrs: [] } };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ code: 'not_an_object', message: 'The network setting must be an object { mode, cidrs }' }] };
  }
  const raw = input as { mode?: unknown; cidrs?: unknown };
  const issues: PortalNetworksIssue[] = [];

  const mode = raw.mode === undefined ? 'any' : raw.mode;
  if (mode !== 'any' && mode !== 'allow_list') {
    issues.push({ code: 'invalid_mode', value: String(mode), message: 'mode must be "any" or "allow_list"' });
  }

  let list: unknown[] = [];
  if (raw.cidrs !== undefined && raw.cidrs !== null) {
    if (Array.isArray(raw.cidrs)) list = raw.cidrs;
    else issues.push({ code: 'cidrs_not_a_list', message: 'cidrs must be a list of IP ranges' });
  }

  const cidrs: string[] = [];
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    const parsed = parseCidr(entry);
    if (!parsed.ok) {
      issues.push({ code: 'invalid_cidr', index, value: typeof entry === 'string' ? entry.slice(0, 80) : String(entry), message: parsed.error });
      return;
    }
    if (seen.has(parsed.cidr)) return;
    seen.add(parsed.cidr);
    cidrs.push(parsed.cidr);
  });
  if (cidrs.length > PORTAL_MAX_NETWORKS) {
    issues.push({
      code: 'too_many',
      message: `A portal can list at most ${PORTAL_MAX_NETWORKS} ranges; combine neighbouring ranges into larger ones`,
    });
  }
  if (mode === 'allow_list' && cidrs.length === 0 && !issues.some((i) => i.code === 'invalid_cidr')) {
    issues.push({ code: 'empty_allow_list', message: 'An allow list needs at least one IP range, otherwise nobody could open the portal' });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { mode: mode as PortalNetworkMode, cidrs } };
}

// ── what the engine reads ────────────────────────────────────────────────

const slot = (i: number): string => `net${i}`;

/** Names of the numbered range attributes of the Portal entity (`net0` ... `net31`). */
export const PORTAL_NETWORK_SLOTS: readonly string[] = Object.freeze(Array.from({ length: PORTAL_MAX_NETWORKS }, (_, i) => slot(i)));

/**
 * The Portal entity attributes of the setting: `networkMode` and one `netN` per range.
 * Nothing is added for an absent setting or for mode `any` beyond the mode itself, so a portal
 * that never opted in carries no network attribute at all and the rule does not apply to it.
 * Entries beyond the slots, or that do not parse, are left out: for an allow list that is the safe
 * direction (fewer addresses are admitted, never more).
 */
export function portalNetworkAttrs(networks: PortalNetworks | null | undefined): Record<string, unknown> {
  if (!networks || (networks.mode !== 'any' && networks.mode !== 'allow_list')) return {};
  if (networks.mode === 'any') return { networkMode: 'any' };
  const attrs: Record<string, unknown> = { networkMode: 'allow_list' };
  let used = 0;
  for (const entry of Array.isArray(networks.cidrs) ? networks.cidrs : []) {
    if (used >= PORTAL_MAX_NETWORKS) break;
    const parsed = parseCidr(entry);
    if (!parsed.ok) continue;
    attrs[slot(used++)] = { __extn: { fn: 'ip', arg: parsed.cidr } };
  }
  return attrs;
}

// ── the same test in TypeScript ──────────────────────────────────────────

interface Address {
  bits: 32 | 128;
  value: bigint;
}

function parseV4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = BigInt(0);
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << BigInt(8)) | BigInt(n);
  }
  return value;
}

/** An IPv6 address in the compressed form `normalizeIp` / `parseCidr` produce (hex groups, at most one `::`). */
function parseV6(text: string): bigint | null {
  if (text.includes('.')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): string[] | null => {
    if (part === '') return [];
    const out = part.split(':');
    return out.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) ? out : null;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let value = BigInt(0);
  for (const g of all) value = (value << BigInt(16)) | BigInt(Number.parseInt(g, 16));
  return value;
}

function parseAddress(text: string): Address | null {
  if (text.includes(':')) {
    const value = parseV6(text);
    return value === null ? null : { bits: 128, value };
  }
  const value = parseV4(text);
  return value === null ? null : { bits: 32, value };
}

/** Is the (already normalised) address inside the (already normalised) range? Different families never match. */
export function cidrContainsAddress(cidr: string, address: string): boolean {
  const slash = cidr.indexOf('/');
  const base = parseAddress(slash === -1 ? cidr : cidr.slice(0, slash));
  const candidate = parseAddress(address);
  if (!base || !candidate || base.bits !== candidate.bits) return false;
  const prefix = slash === -1 ? base.bits : Number.parseInt(cidr.slice(slash + 1), 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > base.bits) return false;
  const shift = BigInt(base.bits - prefix);
  return (base.value >> shift) === (candidate.value >> shift);
}

export type PortalNetworkVerdict =
  /** The portal has no network boundary. */
  | { allowed: true; reason: 'any' }
  | { allowed: true; reason: 'listed'; matched: string }
  | { allowed: false; reason: 'not_listed' }
  /** The address is missing or not an address; an allow list never admits it. */
  | { allowed: false; reason: 'unknown_address' };

/**
 * Would a request from `ip` pass the portal's network boundary? The same answer the managed rules give
 * (the Cedar side is `context has ip && context.ip.isInRange(netN)` for some N).
 */
export function checkPortalNetwork(networks: PortalNetworks | null | undefined, ip: unknown): PortalNetworkVerdict {
  if (!networks || networks.mode !== 'allow_list') return { allowed: true, reason: 'any' };
  const address = normalizeIp(ip);
  if (!address) return { allowed: false, reason: 'unknown_address' };
  let used = 0;
  for (const entry of Array.isArray(networks.cidrs) ? networks.cidrs : []) {
    if (used >= PORTAL_MAX_NETWORKS) break;
    const parsed = parseCidr(entry);
    if (!parsed.ok) continue;
    used++;
    if (cidrContainsAddress(parsed.cidr, address)) return { allowed: true, reason: 'listed', matched: parsed.cidr };
  }
  return { allowed: false, reason: 'not_listed' };
}
