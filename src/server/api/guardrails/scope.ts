import type { IUser } from '@/lib/database';
import { getGuardrailByKey } from '@/lib/services/guardrail';
import type { GuardrailView } from '@/lib/services/guardrail';

/**
 * The same scoping, by KEY — what the hook-plane routes address a guardrail by,
 * because a key is what an enforcement point has in its configuration.
 *
 * The tenant-wide second lookup is not a convenience: `findGuardrailByKey`
 * with a project emits `projectId = @projectId`, a predicate that EXCLUDES
 * NULL, so a workspace-level guardrail is invisible to every project-scoped
 * caller. `resolveGuardrail` (hooks/engine.ts) falls back for exactly that
 * reason, and without the same fallback here this API would report "not
 * found" for a guardrail the engine happily enforces.
 *
 * The fallback asks for the tenant-wide row by name (`null`), never for "any
 * row with this key" (`undefined`): two projects can legitimately hold the same
 * key (keys are unique per project), and on an authenticated surface the
 * first-match answer would hand one project another project's policy — or,
 * once filtered, hide the workspace-wide row behind it. Only an owner or admin,
 * who already have tenant-wide reach, get the any-project lookup as a last
 * resort.
 */
export async function guardrailByKeyInScope(
  tenantDbName: string,
  key: string,
  projectId: string,
  user?: Pick<IUser, 'role'>,
): Promise<GuardrailView | null> {
  const scoped = await getGuardrailByKey(tenantDbName, key, projectId);
  if (scoped) return scoped;

  const tenantWide = await getGuardrailByKey(tenantDbName, key, null);
  if (tenantWide) return tenantWide;

  if (user?.role === 'owner' || user?.role === 'admin') {
    return getGuardrailByKey(tenantDbName, key);
  }
  return null;
}
