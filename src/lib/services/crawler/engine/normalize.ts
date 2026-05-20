/**
 * URL normalization & filtering helpers.
 *
 * Mirrors the logic that was battle-tested in cognipeer-studio's
 * crawler.js so existing user expectations stay intact.
 */

const JUNK_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'fbclid', 'gclid', 'ref', '_ga', 'mc_cid', 'mc_eid',
]);

const SKIPPABLE_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ogg', '.wav',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dmg', '.deb', '.rpm', '.msi',
  '.woff', '.woff2', '.ttf', '.eot',
  '.css', '.js', '.map',
];

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    for (const key of [...u.searchParams.keys()]) {
      if (JUNK_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    if ([...u.searchParams.keys()].length > 0) {
      const entries = [...u.searchParams.entries()].sort((a, b) =>
        a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1,
      );
      u.search = '';
      for (const [k, v] of entries) u.searchParams.append(k, v);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export function getHostname(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isSameOrSubdomain(
  candidate: string,
  root: string,
  includeSubdomains: boolean,
): boolean {
  if (!root || !candidate) return false;
  const c = candidate.toLowerCase();
  const r = root.toLowerCase();
  if (c === r) return true;
  return includeSubdomains && c.endsWith(`.${r}`);
}

export function isSupportedHttpUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = String(raw).trim();
  if (!s || s === '#') return false;
  const lower = s.toLowerCase();
  if (
    lower.startsWith('mailto:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('data:') ||
    lower.startsWith('ftp:')
  ) {
    return false;
  }
  return lower.startsWith('http://') || lower.startsWith('https://');
}

export function isSkippableExtension(urlStr: string): boolean {
  try {
    const pathname = new URL(urlStr).pathname.toLowerCase();
    return SKIPPABLE_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

export function parseContentTypeBase(ct: string | null | undefined): string {
  if (!ct) return '';
  return String(ct).split(';')[0].trim().toLowerCase();
}

/**
 * Match a hostname against a list of glob-like patterns (only `*` supported).
 * Empty / undefined list returns `false` for `allowList` semantics (caller
 * decides whether absence means "allow all" – use `matchesAny`).
 */
export function matchesAny(host: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  const h = host.toLowerCase();
  for (const p of patterns) {
    const trimmed = p.trim().toLowerCase();
    if (!trimmed) continue;
    if (!trimmed.includes('*')) {
      if (h === trimmed) return true;
      continue;
    }
    const regex = new RegExp(
      '^' + trimmed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    if (regex.test(h)) return true;
  }
  return false;
}
