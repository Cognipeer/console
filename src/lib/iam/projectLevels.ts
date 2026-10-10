/**
 * Project-level service permissions: the activation date and the rule that
 * goes with it.
 *
 * A project membership (a user's or a group's assignment to a project) can carry
 * per-service levels. The engine applies them as a ceiling:
 * `effective = min(workspace level, project level)` (projectNarrowing.ts).
 *
 * Before the engine existed those levels were stored and shown in the member
 * screens but never read by any gate. The screen of that time also rendered a
 * service nobody had set as "None", and saved a service that was touched and
 * then put back as an explicit `none`. Read literally, such a row would suddenly
 * cut a member off from services nobody meant to restrict, on the first request
 * the engine decides. So:
 *
 *   - the first time the engine evaluates anything for a workspace, that moment
 *     is recorded once in `iam_meta` (doc `project_levels_since`);
 *   - an explicit `none` in a membership row whose `updatedAt` is OLDER than that
 *     moment is read as "not set" (the workspace level stands);
 *   - `read`, `write` and `admin` entries are always honoured, and so is every
 *     entry of a row saved after the moment (the member screens save an explicit
 *     "No access" deliberately now).
 *
 * Edge case, by design: the rule looks at the row's `updatedAt`, and every save
 * of the row bumps it - also an unrelated one, such as a change of the member's
 * project role. After such a save an old `none` in that row is honoured, because
 * from then on the row has been saved after the activation date.
 *
 * Nothing is migrated: the moment is one small lazily created document, written
 * once per workspace, and a workspace that never evaluates never gets one.
 */

import { runWithTenantScope } from '@/lib/database';
import {
  normalizeServicePermissions,
  type UserServicePermissions,
} from '@/lib/security/rbac';

const META = 'iam_meta' as const;
/** Document id inside `iam_meta`. */
export const PROJECT_LEVELS_DOC_ID = 'project_levels_since';
const MAX_TENANTS = 5_000;

/** tenant -> activation instant (ms). The value never changes once written, so it is cached for the life of the process. */
const known = new Map<string, number>();
const inflight = new Map<string, Promise<number>>();

function parseSince(data: Record<string, unknown> | undefined): number | null {
  const raw = data?.since;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function remember(tenantDbName: string, since: number): void {
  if (!known.has(tenantDbName) && known.size >= MAX_TENANTS) {
    const oldest = known.keys().next().value as string | undefined;
    if (oldest !== undefined) known.delete(oldest);
  }
  known.set(tenantDbName, since);
}

async function readOrCreate(tenantDbName: string): Promise<number> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const existing = parseSince((await db.iamDocGet(META, PROJECT_LEVELS_DOC_ID))?.data);
    if (existing !== null) return existing;
    const now = Date.now();
    await db.iamDocPut(META, PROJECT_LEVELS_DOC_ID, { since: new Date(now).toISOString() });
    // Two nodes can race on the very first evaluation; whoever wrote last wins in
    // the store, so read it back and let every node settle on that one value.
    return parseSince((await db.iamDocGet(META, PROJECT_LEVELS_DOC_ID))?.data) ?? now;
  });
}

/**
 * The instant (ms since epoch) from which the project levels of this workspace
 * are enforced in full; created on first use. Throws when the store cannot be
 * read or written - the caller cannot build a principal then, and the request
 * is refused as "authorization unavailable" rather than decided with a guess.
 */
export async function getProjectLevelsSince(tenantDbName: string): Promise<number> {
  const hit = known.get(tenantDbName);
  if (hit !== undefined) return hit;
  let pending = inflight.get(tenantDbName);
  if (!pending) {
    pending = readOrCreate(tenantDbName)
      .then((since) => {
        remember(tenantDbName, since);
        return since;
      })
      .finally(() => {
        inflight.delete(tenantDbName);
      });
    inflight.set(tenantDbName, pending);
  }
  return pending;
}

/** Is a row last saved at `updatedAt` older than the activation instant? A row without a usable date is older than everything. */
export function isBeforeActivation(updatedAt: Date | string | number | null | undefined, since: number): boolean {
  if (updatedAt === null || updatedAt === undefined || updatedAt === '') return true;
  const ms = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  return !Number.isFinite(ms) || ms < since;
}

/**
 * The service levels of one membership row as the engine reads them: the stored
 * map, minus the explicit `none` entries of a row that predates the activation.
 */
export function effectiveProjectLevels(
  row: { servicePermissions?: unknown; updatedAt?: Date | string | number | null },
  since: number,
): UserServicePermissions {
  const levels = normalizeServicePermissions(row.servicePermissions);
  if (!isBeforeActivation(row.updatedAt, since)) return levels;
  const kept: UserServicePermissions = {};
  for (const [service, level] of Object.entries(levels) as Array<[keyof UserServicePermissions, UserServicePermissions[keyof UserServicePermissions]]>) {
    if (level !== 'none') kept[service] = level;
  }
  return kept;
}

/**
 * The services whose stored explicit `none` the engine reads as "not set" in one
 * membership row: the `none` entries of a row saved before the activation
 * instant, i.e. exactly what `effectiveProjectLevels` leaves out. Empty for a row
 * saved after it. The member screens show these entries as Inherit and drop them
 * on the next save.
 */
export function ignoredProjectLevels(
  row: { servicePermissions?: unknown; updatedAt?: Date | string | number | null },
  since: number,
): string[] {
  if (!isBeforeActivation(row.updatedAt, since)) return [];
  return Object.entries(normalizeServicePermissions(row.servicePermissions))
    .filter(([, level]) => level === 'none')
    .map(([service]) => service);
}

export function resetProjectLevelsForTests(): void {
  known.clear();
  inflight.clear();
}

/** Test seam: pin the activation instant of a workspace without touching the store. */
export function primeProjectLevelsForTests(tenantDbName: string, since: number): void {
  remember(tenantDbName, since);
}
