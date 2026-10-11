/**
 * Which groups do the workspace's custom policies name?
 *
 * A group that a custom policy names carries access the group list does not show (a policy can permit the group
 * something, or forbid it), so a group like that is not one a host application's token may put people into. The answer
 * is one read of the policy version and, only when the version moved, one read of the policies.
 *
 * The cache is keyed by workspace (the group's `tenantId`) and invalidated by the policy version, which every policy
 * write bumps and every node reads, so a policy saved on another node is noticed on the next call.
 */

import type { DatabaseProvider } from '@/lib/database';
import { policyGroupIds } from './policyRows';
import { readPolicies, readPolicyVersion } from './store';

type PolicyReadDb = Pick<DatabaseProvider, 'iamDocGet' | 'iamDocList'>;

const CACHE_MAX = 1_000;
const EMPTY: ReadonlySet<string> = new Set();
const cache = new Map<string, { version: number; groups: ReadonlySet<string> }>();

/**
 * The ids of the groups any custom policy (enabled or not: it may be enabled later) names. `db` is a provider in the
 * scope of the workspace; `cacheKey` names the workspace (omit it to read every time).
 */
export async function listGroupIdsNamedByPolicies(db: PolicyReadDb, cacheKey?: string): Promise<ReadonlySet<string>> {
  const version = await readPolicyVersion(db);
  if (version === 0) return EMPTY; // the workspace never had a custom policy
  const hit = cacheKey ? cache.get(cacheKey) : undefined;
  if (hit && hit.version === version) return hit.groups;

  const groups = new Set<string>();
  for (const policy of await readPolicies(db)) {
    for (const id of policyGroupIds(policy)) groups.add(id);
  }
  if (cacheKey) {
    cache.delete(cacheKey);
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(cacheKey, { version, groups });
  }
  return groups;
}

/** Forget what was read (tests). */
export function resetGroupPolicyRefsForTests(): void {
  cache.clear();
}
