/**
 * Display labels of users and tokens for the Authorization center: audit rows,
 * policy rows and decision records only carry ids. One batched read per kind.
 */

import { runWithTenantScope } from '@/lib/database';

/** Resolve the display labels of user / token ids found in audit rows (one batched read each). */
export async function resolvePrincipalLabels(
  tenant: { tenantDbName: string; tenantId: string },
  ids: { users?: Iterable<string>; tokens?: Iterable<string> },
): Promise<{ users: Map<string, string>; tokens: Map<string, string> }> {
  const users = new Map<string, string>();
  const tokens = new Map<string, string>();
  const userIds = [...new Set(ids.users ?? [])].slice(0, 500);
  const tokenIds = [...new Set(ids.tokens ?? [])].slice(0, 500);
  await runWithTenantScope(tenant.tenantDbName, async (db) => {
    if (userIds.length > 0) {
      const page = await db.iamListUsers({ tenantId: tenant.tenantId, ids: userIds, limit: 200 });
      for (const u of page.items) users.set(String(u._id), u.name || u.email);
      if (userIds.length > 200) {
        const more = await db.iamListUsers({ tenantId: tenant.tenantId, ids: userIds.slice(200), limit: 200 });
        for (const u of more.items) users.set(String(u._id), u.name || u.email);
      }
    }
    if (tokenIds.length > 0) {
      const page = await db.iamListTokens({ tenantId: tenant.tenantId, ids: tokenIds, limit: 200 });
      for (const t of page.items) tokens.set(String(t._id), t.label);
    }
  });
  return { users, tokens };
}
