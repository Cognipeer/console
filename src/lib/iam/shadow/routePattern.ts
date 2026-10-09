/**
 * Canonical route label for the shadow diff store.
 *
 * Prefer the framework's route pattern (`/api/groups/:id`), which is exactly
 * the cardinality we want. Without one (unmatched route, test doubles) fall
 * back to the request path with every id-looking segment masked, never the
 * query string. Always bounded in length.
 */

const MAX_LEN = 200;

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
/** Long opaque tokens: hashes, keys, base64-ish blobs. */
const OPAQUE = /^(?=.*\d)[A-Za-z0-9_-]{20,}$/;
/** Prefixed ids such as tok_abc123 / ses-12345678. */
const PREFIXED_ID = /^[A-Za-z]{1,12}[_-](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,}$/;

export function maskPathSegment(segment: string): string {
  if (!segment) return segment;
  if (OBJECT_ID.test(segment) || UUID.test(segment) || NUMERIC.test(segment) || OPAQUE.test(segment) || PREFIXED_ID.test(segment)) {
    return ':id';
  }
  return segment;
}

export function maskPath(pathname: string): string {
  const path = pathname.split('?')[0].split('#')[0];
  return path
    .split('/')
    .map(maskPathSegment)
    .join('/');
}

function clamp(value: string): string {
  return value.length > MAX_LEN ? `${value.slice(0, MAX_LEN - 1)}…` : value;
}

/**
 * @param routePattern the framework route pattern when available
 * @param pathname canonical request pathname (no query string)
 */
export function canonicalRoute(routePattern: string | undefined | null, pathname: string): string {
  if (typeof routePattern === 'string' && routePattern.startsWith('/') && routePattern !== '/*') {
    return clamp(routePattern);
  }
  return clamp(maskPath(pathname));
}
