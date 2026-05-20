/**
 * SSRF guard – reject URLs that resolve to private / link-local / metadata
 * IP space unless the caller explicitly opts in.
 *
 * Limitation: in F1 we only inspect the host literal. A motivated attacker
 * can still use a DNS name that resolves to a private IP. F2 will add an
 * async resolve step before fetch.
 */

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
