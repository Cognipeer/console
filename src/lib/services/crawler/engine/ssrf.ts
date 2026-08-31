/**
 * SSRF guard – reject URLs that resolve to private / link-local / metadata
 * IP space unless the caller explicitly opts in.
 *
 * Limitation: `assertSafeUrl` only inspects the host literal. A motivated
 * attacker can still use a DNS name that resolves to a private IP (DNS
 * rebinding). `assertSafeUrlResolved` below closes most of that gap with an
 * async resolve-and-check step; full TOCTOU-proof protection would require
 * pinning the resolved address for the actual outbound connection too.
 */
import { lookup } from 'node:dns/promises';

const PRIVATE_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  '169.254.169.254', // AWS / GCP metadata
]);

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h.startsWith('fe80')) return true;
  return false;
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_HOSTS.has(h)) return true;
  if (isPrivateIPv4(h)) return true;
  if (h.includes(':') && isPrivateIPv6(h)) return true;
  return false;
}

export function assertSafeUrl(rawUrl: string, allowPrivate?: boolean): void {
  if (allowPrivate) return;
  try {
    const u = new URL(rawUrl);
    if (isPrivateHost(u.hostname)) {
      throw new Error(`Refusing to crawl private/loopback host: ${u.hostname}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Refusing')) throw err;
    // URL parse error – let the fetcher surface it as a fetch failure
  }
}

/**
 * DNS-aware variant of `assertSafeUrl`. Resolves the hostname and checks
 * every returned address against the private/loopback/link-local ranges,
 * closing the common DNS-rebinding case where a public-looking hostname
 * resolves to a private IP.
 *
 * Best-effort: if DNS resolution itself fails (offline sandbox, NXDOMAIN,
 * etc.) we don't block here — the caller's own fetch will fail on its DNS
 * lookup right after, so we avoid turning a transient resolver error into a
 * false SSRF rejection.
 */
export async function assertSafeUrlResolved(rawUrl: string, allowPrivate?: boolean): Promise<void> {
  assertSafeUrl(rawUrl, allowPrivate);
  if (allowPrivate) return;

  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return; // malformed URL — let the fetcher report it
  }
  if (isPrivateHost(hostname)) return; // literal IP, already checked above

  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    for (const record of records) {
      if (isPrivateHost(record.address)) {
        throw new Error(
          `Refusing to crawl — hostname resolves to a private address: ${hostname} -> ${record.address}`,
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Refusing')) throw err;
    // DNS lookup error — let the real fetch surface it as a connection failure.
  }
}
