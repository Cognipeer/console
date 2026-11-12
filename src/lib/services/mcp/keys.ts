import slugify from 'slugify';
import { randomUUID } from 'crypto';
import { runWithTenantScope } from '@/lib/database';
const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;

// ── Key generation ────────────────────────────────────────────────────────

function normalizeKey(input: string): string {
  const fallback = input?.trim().length ? input.trim() : 'mcp-server';
  return slugify(fallback, SLUG_OPTIONS);
}

/** `excludeId` lets a rename check uniqueness without colliding with itself. */
export async function generateUniqueKey(
  tenantDbName: string,
  projectId: string | undefined,
  desiredKey: string,
  excludeId?: string,
): Promise<string> {
  return runWithTenantScope(tenantDbName, async (db) => {

    const base = normalizeKey(desiredKey);
    let attempt = 0;
    let candidate = base;

    while (attempt < MAX_KEY_ATTEMPTS) {
      const existing = await db.findMcpServerByKey(candidate, projectId);
      if (!existing || String(existing._id) === excludeId) return candidate;
      attempt++;
      candidate = `${base}-${attempt}`;
    }

    throw new Error(`Could not generate a unique key for MCP server "${desiredKey}"`);
  });
}

function generateEndpointSlug(): string {
  return randomUUID().replace(/-/g, '').substring(0, 16);
}

// The public-MCP route (public-mcp.ts) rejects any slug under 8 chars
// outright (same floor `a2aExposure.ts` uses for agent slugs) — keep this in
// sync with that so a custom path never gets saved just to 404 at call time.
const MIN_ENDPOINT_SLUG_LENGTH = 8;
const MAX_ENDPOINT_SLUG_LENGTH = 80;

function normalizeCustomEndpointSlug(desired: string): string {
  const slug = slugify(desired, SLUG_OPTIONS).substring(0, MAX_ENDPOINT_SLUG_LENGTH);
  if (slug.length < MIN_ENDPOINT_SLUG_LENGTH) {
    throw new Error(
      `Custom path must be at least ${MIN_ENDPOINT_SLUG_LENGTH} characters (letters, numbers, hyphens).`,
    );
  }
  return slug;
}

/**
 * Resolve the path segment a server (or MCP Hub) is addressed by under
 * `/api/public/mcp/:tenantId/:endpointSlug`. Omitting `desired` mints a
 * random unguessable slug, same as before custom paths existed. A
 * caller-supplied `desired` becomes this server's public URL path — unlike
 * `key` it is never silently de-duplicated with a numeric suffix (that would
 * surprise whoever the URL was shared with), so it must be unique or the
 * caller picks a different one. `excludeId` lets a rename check uniqueness
 * without colliding with the record being renamed.
 */
export async function resolveEndpointSlug(
  tenantDbName: string,
  desired: string | undefined,
  excludeId?: string,
): Promise<string> {
  if (!desired?.trim()) return generateEndpointSlug();
  const slug = normalizeCustomEndpointSlug(desired);
  return runWithTenantScope(tenantDbName, async (db) => {
    const existing = await db.findMcpServerByEndpointSlug(slug);
    if (existing && String(existing._id) !== excludeId) {
      throw new Error(`The path "${slug}" is already used by another MCP server. Choose a different one.`);
    }
    return slug;
  });
}
