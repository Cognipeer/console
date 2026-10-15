/**
 * The people operations the endpoints share: a lookup that treats an id the
 * database cannot parse as "no such person", one place that writes a profile or a
 * role (cache invalidation and audit included), and the bulk runner that applies
 * one action to a page of people - one result per person, the same guards as the
 * single-person endpoints.
 *
 * The rules themselves live in peoplePolicy.ts; this module only applies them.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope, type IGroup, type IUser } from '@/lib/database';
import type { DatabaseProvider } from '@/lib/database';
import { recordPeopleAudit, type PeopleAuditActor } from './peopleAudit';
import {
  canSeeTokensOf,
  checkGroupMembership,
  checkStatusChange,
  targetOf,
  type PolicyActor,
  type PolicyRefusal,
} from './peoplePolicy';
import { invalidateUserAuthState } from './userAuthState';
import { revokeUserApiTokens, setUserStatus, type UserStatusActor } from './userLifecycle';

const logger = createLogger('service:users:people');

/** The messages of the errors a database raises for an id it cannot parse (Mongo's ObjectId constructor). */
const ID_FORMAT_ERROR = /objectid|24 character|hex string|BSONError|Argument passed in must/i;

/**
 * The person `id` of this workspace, or null when there is none: no such id, a
 * person of another workspace, or an id the database cannot parse (SQLite finds
 * nothing for it, Mongo throws; here both are "not found", never a 500). Any other
 * database error is thrown.
 */
export async function findUserByIdSafe(
  db: Pick<DatabaseProvider, 'findUserById'>,
  id: unknown,
  tenantId: string,
): Promise<IUser | null> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) return null;
  try {
    const user = await db.findUserById(id);
    if (!user) return null;
    return user.tenantId && String(user.tenantId) !== String(tenantId) ? null : user;
  } catch (error) {
    if (error instanceof Error && ID_FORMAT_ERROR.test(`${error.name} ${error.message}`)) return null;
    throw error;
  }
}

// ── a profile or a role ──────────────────────────────────────────────────

export interface PersonPatch {
  name?: string;
  email?: string;
  role?: 'admin' | 'project_admin' | 'user' | 'portal_user';
}

export interface PersonUpdateContext {
  tenantDbName: string;
  tenantId: string;
  actor: PeopleAuditActor;
}

/**
 * Write a profile and/or role change and leave the trail. A role change drops the
 * cached state of the person at once (their very next request is judged on the new
 * role); the provider already drops their authorization cache on every user write.
 * Returns the updated row, or null when the person vanished in between.
 */
export async function updatePerson(
  context: PersonUpdateContext,
  before: IUser,
  patch: PersonPatch,
): Promise<IUser | null> {
  const userId = String(before._id);
  const data: Partial<IUser> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.email !== undefined) data.email = patch.email;
  if (patch.role !== undefined) data.role = patch.role;
  if (Object.keys(data).length === 0) return before;

  const updated = await runWithTenantScope(context.tenantDbName, (db) => db.updateUser(userId, data));
  if (!updated) return null;

  if (patch.role !== undefined) await invalidateUserAuthState(context.tenantDbName, userId);

  const changedFields = (['name', 'email'] as const).filter((field) => patch[field] !== undefined);
  if (changedFields.length > 0) {
    recordPeopleAudit(context, context.actor, {
      event: 'user.profile.update',
      resourceType: 'user',
      resourceId: userId,
      metadata: { changedFields },
    });
  }
  if (patch.role !== undefined) {
    recordPeopleAudit(context, context.actor, {
      event: 'user.role.change',
      resourceType: 'user',
      resourceId: userId,
      metadata: { from: before.role, to: patch.role },
    });
  }
  return updated;
}

// ── bulk ─────────────────────────────────────────────────────────────────

export const BULK_ACTIONS = ['disable', 'enable', 'revoke-tokens', 'add-to-group', 'remove-from-group'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/** People in one bulk request: a page of the directory, no more. */
export const MAX_BULK_IDS = 100;
const BULK_CONCURRENCY = 8;

export type BulkResultCode =
  | 'self_not_allowed'
  | 'owner_immutable'
  | 'higher_privileges'
  | 'user_not_found'
  | 'already_in_state'
  | 'not_a_member'
  | 'failed';

export interface BulkResult {
  id: string;
  outcome: 'ok' | 'skipped' | 'failed';
  code?: BulkResultCode;
  message?: string;
  /** revoke-tokens: how many tokens went. */
  revoked?: number;
}

export interface BulkRun {
  tenantDbName: string;
  tenantId: string;
  actor: PolicyActor;
  /** Who is recorded in the trail, and how (user session or API token). */
  audit: PeopleAuditActor;
  action: BulkAction;
  ids: string[];
  reason?: string;
  /** Required for the two group actions: a local group of this workspace. */
  group?: IGroup;
  /** Evaluate the guards only; write nothing. */
  dryRun: boolean;
  batchId: string;
}

/** The code a person gets in a bulk answer for a policy refusal. */
function codeOf(refusal: PolicyRefusal): BulkResultCode {
  switch (refusal.code) {
    case 'self_not_allowed':
    case 'cannot_change_own_role':
      return 'self_not_allowed';
    case 'owner_immutable':
      return 'owner_immutable';
    default:
      return 'higher_privileges';
  }
}

const skipped = (id: string, code: BulkResultCode, message?: string): BulkResult => ({ id, outcome: 'skipped', code, ...(message ? { message } : {}) });
const failed = (id: string, message?: string): BulkResult => ({ id, outcome: 'failed', code: 'failed', ...(message ? { message } : {}) });

/** A fresh identifier shared by every audit row one bulk request writes. */
export function newBatchId(): string {
  return randomUUID();
}

async function runOne(run: BulkRun, id: string): Promise<BulkResult> {
  const { tenantDbName, tenantId, actor, action, dryRun } = run;
  try {
    const target = await runWithTenantScope(tenantDbName, (db) => findUserByIdSafe(db, id, tenantId));
    if (!target) return skipped(id, 'user_not_found');
    const person = targetOf(target);

    if (action === 'disable' || action === 'enable') {
      const verdict = checkStatusChange(actor, person);
      if (!verdict.ok) return skipped(id, codeOf(verdict), verdict.message);
      const disabled = target.status === 'disabled';
      if ((action === 'disable') === disabled) return skipped(id, 'already_in_state');
      if (dryRun) return { id, outcome: 'ok' };

      const statusActor: UserStatusActor = {
        type: run.audit.type,
        userId: run.audit.userId,
        email: run.audit.email,
        role: run.audit.role,
        apiTokenId: run.audit.apiTokenId,
      };
      const result = await setUserStatus({
        actor: statusActor,
        batchId: run.batchId,
        ipAddress: run.audit.ipAddress,
        reason: run.reason,
        requestId: run.audit.requestId,
        status: action === 'disable' ? 'disabled' : 'active',
        targetUserId: id,
        tenantDbName,
        tenantId,
        userAgent: run.audit.userAgent,
      });
      if (!result.ok) {
        return result.httpStatus === 404 ? skipped(id, 'user_not_found') : skipped(id, result.httpStatus === 400 ? 'self_not_allowed' : 'owner_immutable', result.error);
      }
      return result.changed ? { id, outcome: 'ok' } : skipped(id, 'already_in_state');
    }

    if (action === 'revoke-tokens') {
      // Whose tokens the actor may touch is the same rule that decides who may see them.
      if (!canSeeTokensOf(actor, person)) return skipped(id, 'higher_privileges');
      if (dryRun) return { id, outcome: 'ok' };
      const result = await revokeUserApiTokens(tenantDbName, id);
      if (result.revoked > 0) {
        recordPeopleAudit({ tenantDbName, tenantId }, run.audit, {
          event: 'token.revoke',
          resourceType: 'token',
          resourceId: id,
          metadata: {
            ownerUserId: id,
            revoked: result.revoked,
            failed: result.failed,
            tokenIds: result.revokedIds.slice(0, 25),
            batchId: run.batchId,
          },
        });
      }
      if (result.failed > 0) return { ...failed(id, `${result.failed} token(s) could not be revoked`), revoked: result.revoked };
      return { id, outcome: 'ok', revoked: result.revoked };
    }

    // add-to-group / remove-from-group
    const group = run.group;
    if (!group) return failed(id, 'No group');
    const groupId = String(group._id);
    const verdict = checkGroupMembership(actor, person, group);
    if (!verdict.ok) return skipped(id, codeOf(verdict), verdict.message);
    const memberships = await runWithTenantScope(tenantDbName, (db) => db.listGroupMembersByUser(id));
    const isMember = memberships.some((membership) => String(membership.groupId) === groupId);

    if (action === 'add-to-group') {
      if (isMember) return skipped(id, 'already_in_state');
      if (dryRun) return { id, outcome: 'ok' };
      await runWithTenantScope(tenantDbName, (db) => db.addGroupMember({
        tenantId,
        groupId,
        userId: id,
        role: 'member',
        source: 'local',
        addedBy: actor.id,
      }));
    } else {
      if (!isMember) return skipped(id, 'not_a_member');
      if (dryRun) return { id, outcome: 'ok' };
      const removed = await runWithTenantScope(tenantDbName, (db) => db.removeGroupMember(groupId, id));
      if (!removed) return skipped(id, 'not_a_member');
    }
    recordPeopleAudit({ tenantDbName, tenantId }, run.audit, {
      event: action === 'add-to-group' ? 'group.member.add' : 'group.member.remove',
      resourceType: 'group',
      resourceId: groupId,
      metadata: { userId: id, batchId: run.batchId },
    });
    return { id, outcome: 'ok' };
  } catch (error) {
    logger.error('A bulk step failed', {
      action,
      userId: id.slice(0, 64),
      error: error instanceof Error ? error.message : String(error),
    });
    return failed(id);
  }
}

/** Apply the action to each person, a few at a time, and return one result per id in the order given. */
export async function runBulk(run: BulkRun): Promise<BulkResult[]> {
  const results: BulkResult[] = new Array(run.ids.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= run.ids.length) return;
      results[index] = await runOne(run, run.ids[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, run.ids.length) }, worker));
  return results;
}

export interface BulkSummary {
  ok: number;
  skipped: number;
  failed: number;
}

export function summarizeBulk(results: readonly BulkResult[]): BulkSummary {
  return {
    ok: results.filter((result) => result.outcome === 'ok').length,
    skipped: results.filter((result) => result.outcome === 'skipped').length,
    failed: results.filter((result) => result.outcome === 'failed').length,
  };
}
