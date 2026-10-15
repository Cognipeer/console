import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { IUser } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import { isDelegationIssuer, listDelegationIssuers } from '@/lib/iam/delegationIssuers';
import { forbiddenBody } from '@/lib/iam/enforce';
import { createExternalAccount } from '@/lib/iam/externalAccount';
import {
  isDirectoryManaged,
  isGroupDirectoryManaged,
  providerOf,
  type PeopleErrorCode,
} from '@/lib/iam/identity';
import { authz } from '@/lib/iam/routeAuthz';
import { MAX_EXTERNAL_ISSUER_LENGTH, MAX_EXTERNAL_SUBJECT_LENGTH } from '@/lib/database/provider/externalIds';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import {
  normalizeServicePermissions,
  RBAC_SERVICE_DEFINITIONS,
  SERVICE_PERMISSION_LEVELS,
} from '@/lib/security/rbac';
import { createInvitationUrl } from '@/lib/services/auth/invitation';
import { collectAccessibleProjectIds } from '@/lib/services/projects/accessibleProjects';
import { sendAccessRequestEmails, sendProjectsAddedEmail } from '@/lib/services/users/accessMail';
import {
  applyProjectGrants,
  inviteGrantsOf,
  loadTenantProjects,
  parseProjectGrants,
  projectsAdministeredBy,
  unknownProjectIds,
} from '@/lib/services/users/projectGrants';
import { generateSecurePassword } from '@/lib/services/auth/passwordGenerator';
import { checkRateLimit, type RateLimitConfig } from '@/lib/services/auth/rateLimiter';
import {
  CsvImportError,
  importProgrammaticUsers,
  MAX_BULK_IMPORT_ROWS,
  parseUserCsv,
  rowAlreadyExists,
} from '@/lib/services/users/csvImport';
import { BCRYPT_ROUNDS } from '@/lib/services/auth/passwordPolicy';
import { ensureDefaultProject } from '@/lib/services/projects/projectService';
import { cleanupDeletedUser, setUserStatus } from '@/lib/services/users/userLifecycle';
import { isUserLoginBlocked } from '@/lib/services/users/userAuthState';
import { recordPeopleAudit, type PeopleAuditActor } from '@/lib/services/users/peopleAudit';
import { isRoleManagedByDirectory } from '@/lib/services/users/roleManagement';
import {
  canActOnPerson,
  canAdministerPeople,
  checkDelete,
  checkGroupMembership,
  checkPermissionsEdit,
  checkProfileChange,
  checkRoleChange,
  targetOf,
  type PolicyRefusal,
  type ProfileField,
} from '@/lib/services/users/peoplePolicy';
import {
  BULK_ACTIONS,
  MAX_BULK_IDS,
  findUserByIdSafe,
  newBatchId,
  runBulk,
  summarizeBulk,
  updatePerson,
  type BulkAction,
  type PersonPatch,
} from '@/lib/services/users/peopleService';
import {
  authorizeServiceForRequest,
  getClientIp,
  readJsonBody,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
  type ApiSessionContext,
} from '../fastify-utils';
import { resolveRequestedTokenScope } from './tokens';

const logger = createLogger('api:users');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 120;
const MAX_BULK_REASON_LENGTH = 500;
const MAX_ACCESS_REQUEST_MESSAGE_LENGTH = 500;
/** One access request per person in this long. */
const ACCESS_REQUEST_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Edits of one person per minute and per actor (a script, not a person, makes more). */
const EDIT_RATE_LIMIT: RateLimitConfig = { maxAttempts: 30, windowSeconds: 60 };
/** Bulk requests per minute and per actor. */
const BULK_RATE_LIMIT: RateLimitConfig = { maxAttempts: 20, windowSeconds: 60 };

/** The person's last request for access, as the screens read it (null = never asked). */
function serializeAccessRequest(user: Pick<IUser, 'accessRequest'>) {
  const request = user.accessRequest;
  if (!request?.at) return null;
  const at = new Date(request.at);
  return Number.isNaN(at.getTime()) ? null : { at: at.toISOString(), message: request.message ?? null };
}

function serializeUser(user: IUser) {
  return {
    _id: user._id,
    accessRequest: serializeAccessRequest(user),
    authProvider: providerOf(user),
    canLogin: user.canLogin !== false,
    createdAt: user.createdAt,
    directoryManaged: isDirectoryManaged(user),
    disabledAt: user.disabledAt ?? null,
    disabledBy: user.disabledBy ?? null,
    disabledReason: user.disabledReason ?? null,
    email: user.email,
    inviteAcceptedAt: user.inviteAcceptedAt,
    invitedAt: user.invitedAt,
    invitedBy: user.invitedBy,
    name: user.name,
    projectIds: user.projectIds ?? [],
    role: user.role,
    servicePermissions: normalizeServicePermissions(user.servicePermissions),
    // Missing status = active (legacy / on-prem rows have no such field).
    status: user.status ?? 'active',
    updatedAt: user.updatedAt,
  };
}

/** An error answer: the English text for logs and fallbacks, and the stable code screens translate by. */
function fail(
  reply: FastifyReply,
  status: number,
  code: PeopleErrorCode,
  error: string,
  details?: Array<{ field?: string; message: string }>,
) {
  return reply.code(status).send({ error, code, ...(details && details.length > 0 ? { details } : {}) });
}

function refuse(reply: FastifyReply, refusal: PolicyRefusal) {
  return fail(reply, refusal.status, refusal.code, refusal.message);
}

/** Who is recorded in the audit trail for a request of this session. */
function auditActorOf(request: FastifyRequest, session: ApiSessionContext): PeopleAuditActor {
  return {
    type: 'user',
    userId: session.userId,
    email: session.userEmail,
    role: session.userRole,
    requestId: session.requestId,
    ipAddress: getClientIp(request),
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
    method: request.method.toUpperCase(),
    path: (request.raw.url ?? '').split('?')[0],
  };
}

function tooManyRequests(reply: FastifyReply, retryAfterSeconds: number) {
  return reply
    .code(429)
    .header('Retry-After', String(retryAfterSeconds))
    .send({ error: 'Too many requests. Please try again shortly.', code: 'rate_limited' });
}

export const usersApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/users/permissions/services', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canAdministerPeople(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      return reply.code(200).send({
        levels: SERVICE_PERMISSION_LEVELS,
        services: RBAC_SERVICE_DEFINITIONS,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('List permission services error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/users', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canAdministerPeople(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const users = await db.listUsers();
      return reply.code(200).send({ users: users.map(serializeUser) });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('List users error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/users/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!canAdministerPeople(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const user = await findUserByIdSafe(db, id, session.tenantId);
      if (!user) {
        return fail(reply, 404, 'user_not_found', 'User not found');
      }

      return reply.code(200).send({ user: serializeUser(user) });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Get user error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  /**
   * Edit one person: name, email and role (at least one). A value equal to the
   * stored one is ignored. The rules - who may edit whom, the owner role is
   * immutable, nobody changes their own role, a directory account keeps its name
   * and email in the directory - are peoplePolicy.ts's, the same ones the
   * directory reports as `allowedActions`. The change is audited as what it is
   * (`user.profile.update`, `user.role.change`), not as a bare PATCH.
   */
  app.patch('/users/:id', { config: { skipAuditOnSuccess: true } }, withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!canAdministerPeople(session.userRole)) {
        return fail(reply, 403, 'forbidden', 'Only owners and admins can edit users');
      }

      let body: unknown;
      try {
        body = readJsonBody<unknown>(request);
      } catch {
        return fail(reply, 400, 'invalid_body', 'The request body must be a JSON object');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return fail(reply, 400, 'invalid_body', 'The request body must be a JSON object');
      }
      const input = body as Record<string, unknown>;
      const unknownKeys = Object.keys(input).filter((key) => key !== 'name' && key !== 'email' && key !== 'role');
      if (unknownKeys.length > 0) {
        return fail(reply, 400, 'invalid_body', 'Only name, email and role can be changed', unknownKeys.map((field) => ({ field, message: 'Unknown field' })));
      }
      if (input.name === undefined && input.email === undefined && input.role === undefined) {
        return fail(reply, 400, 'invalid_body', 'Send at least one of name, email and role');
      }

      const limit = checkRateLimit(`people-edit:${session.userId}`, EDIT_RATE_LIMIT);
      if (!limit.allowed) return tooManyRequests(reply, limit.retryAfterSeconds);

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);
      const target = await findUserByIdSafe(db, id, session.tenantId);
      if (!target) return fail(reply, 404, 'user_not_found', 'User not found');
      const actor = { id: session.userId, role: session.userRole };
      // A role that follows the directory at every sign-in is not changed by hand (409 directory_managed).
      const person = targetOf(target, {
        roleManaged: input.role !== undefined && input.role !== target.role
          ? await isRoleManagedByDirectory({ tenantDbName: session.tenantDbName, tenantId: session.tenantId }, target)
          : false,
      });

      // What would actually change: a value equal to the stored one is not a change.
      const patch: PersonPatch = {};
      if (input.name !== undefined) {
        if (typeof input.name !== 'string') return fail(reply, 400, 'invalid_body', 'name must be a string', [{ field: 'name', message: 'Must be a string' }]);
        const name = input.name.trim();
        if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
          return fail(reply, 400, 'invalid_body', `name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters`, [{ field: 'name', message: `Between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters` }]);
        }
        if (name !== target.name) patch.name = name;
      }
      if (input.email !== undefined) {
        if (typeof input.email !== 'string') return fail(reply, 400, 'invalid_body', 'email must be a string', [{ field: 'email', message: 'Must be a string' }]);
        const email = input.email.trim();
        if (email === '' && target.canLogin !== false) {
          return fail(reply, 400, 'email_required', 'Email is required unless the account cannot sign in');
        }
        if (email !== '' && !EMAIL_PATTERN.test(email)) {
          return fail(reply, 400, 'invalid_body', 'Invalid email format', [{ field: 'email', message: 'Invalid email format' }]);
        }
        if (email !== (target.email ?? '')) patch.email = email;
      }
      if (input.role !== undefined && input.role !== target.role) {
        patch.role = input.role as PersonPatch['role'];
      }

      // The same rules the directory reports, judged on the role the actor has NOW (the session context carries it).
      const profileFields: ProfileField[] = [];
      if (patch.name !== undefined) profileFields.push('name');
      if (patch.email !== undefined) profileFields.push('email');
      if (profileFields.length > 0) {
        const verdict = checkProfileChange(actor, person, profileFields);
        if (!verdict.ok) return refuse(reply, verdict);
      }
      if (patch.role !== undefined) {
        const verdict = checkRoleChange(actor, person, patch.role);
        if (!verdict.ok) return refuse(reply, verdict);
      }

      if (patch.email) {
        const taken = await db.findUserByEmail(patch.email);
        if (taken && String(taken._id) !== String(target._id)) {
          return fail(reply, 409, 'email_taken', 'User with this email already exists in your organization');
        }
      }

      const changed = (['name', 'email', 'role'] as const).filter((field) => patch[field] !== undefined);
      if (changed.length === 0) {
        return reply.code(200).send({ user: serializeUser(target), changed });
      }

      const updated = await updatePerson(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, actor: auditActorOf(request, session) },
        target,
        patch,
      );
      if (!updated) return fail(reply, 404, 'user_not_found', 'User not found');
      return reply.code(200).send({ user: serializeUser(updated), changed });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Update user error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/users/:id', { config: { skipAuditOnSuccess: true } }, withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!canAdministerPeople(session.userRole)) {
        return fail(reply, 403, 'forbidden', 'Only owners and admins can delete users');
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      if (id === session.userId) {
        return fail(reply, 400, 'self_not_allowed', 'You cannot delete your own account');
      }

      const userToDelete = await findUserByIdSafe(db, id, session.tenantId);
      if (!userToDelete) {
        return fail(reply, 404, 'user_not_found', 'User not found');
      }

      // The owner and the signed-in person are never deleted, nobody deletes upward, and an
      // account of a directory is disabled instead (it would be created again at its next sign-in).
      const verdict = checkDelete({ id: session.userId, role: session.userRole }, targetOf(userToDelete));
      if (!verdict.ok) return refuse(reply, verdict);

      const deleted = await db.deleteUser(id);
      if (!deleted) {
        return reply.code(500).send({ error: 'Failed to delete user' });
      }

      // The row is gone, so what hung on it would otherwise be orphaned: its tokens, its
      // group and project memberships. Never fails the delete.
      const cleanup = await cleanupDeletedUser(session.tenantDbName, id, session.tenantId);

      recordPeopleAudit(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
        auditActorOf(request, session),
        {
          event: 'user.delete',
          resourceType: 'user',
          resourceId: id,
          metadata: {
            targetName: userToDelete.name,
            targetRole: userToDelete.role,
            cleanup: {
              revokedTokens: cleanup.revokedTokens,
              removedGroupMemberships: cleanup.removedGroupMemberships,
              removedProjectMemberships: cleanup.removedProjectMemberships,
            },
          },
        },
      );

      return reply.code(200).send({
        message: 'User deleted successfully',
        cleanup: {
          revokedTokens: cleanup.revokedTokens,
          removedGroupMemberships: cleanup.removedGroupMemberships,
          removedProjectMemberships: cleanup.removedProjectMemberships,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Delete user error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // Disable / enable share one handler: the guards (self, owner, tenant) and the
  // audit trail live in setUserStatus, so the route only gates on role.
  const statusRouteHandler = (action: 'disable' | 'enable') => {
    const status = action === 'disable' ? 'disabled' : 'active';
    return withApiRequestContext(async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const session = requireSessionContext(request);
        if (!canAdministerPeople(session.userRole)) {
          return reply.code(403).send({ error: `Only owners and admins can ${action} users` });
        }

        // The body is optional (only `disable` reads a reason).
        let reason: string | undefined;
        if (action === 'disable' && request.body) {
          const body = readJsonBody<{ reason?: unknown }>(request);
          if (typeof body.reason === 'string') reason = body.reason;
        }

        const result = await setUserStatus({
          actor: {
            email: session.userEmail,
            role: session.userRole,
            type: 'user',
            userId: session.userId,
          },
          ipAddress: getClientIp(request),
          reason,
          requestId: session.requestId,
          status,
          targetUserId: id,
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          userAgent: typeof request.headers['user-agent'] === 'string'
            ? request.headers['user-agent']
            : undefined,
        });
        if (!result.ok) {
          const code: PeopleErrorCode = result.httpStatus === 404 ? 'user_not_found' : result.httpStatus === 403 ? 'owner_immutable' : 'self_not_allowed';
          return reply.code(result.httpStatus).send({ error: result.error, code });
        }

        return reply.code(200).send({ user: serializeUser(result.user) });
      } catch (error) {
        if (error instanceof Error && error.message === 'Unauthorized') {
          return reply.code(401).send({ error: 'Unauthorized' });
        }
        if (error instanceof SyntaxError) {
          return reply.code(400).send({ error: 'Invalid request body' });
        }
        logger.error(`${action} user error`, { error });
        return reply.code(500).send({ error: 'Internal server error' });
      }
    });
  };
  // Literal paths (not a template) so the endpoint auth-coverage gate can see them.
  app.post('/users/:id/disable', statusRouteHandler('disable'));
  app.post('/users/:id/enable', statusRouteHandler('enable'));

  app.patch('/users/:id/permissions', { config: { skipAuditOnSuccess: true } }, withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!canAdministerPeople(session.userRole)) {
        return fail(reply, 403, 'forbidden', 'Only owners and admins can manage permissions');
      }

      const body = readJsonBody<{ servicePermissions?: unknown }>(request);
      // A body without the map used to wipe every override; say what is wrong instead.
      const requested = body?.servicePermissions;
      if (requested === null || typeof requested !== 'object' || Array.isArray(requested)) {
        return fail(reply, 400, 'invalid_body', 'servicePermissions must be an object', [{ field: 'servicePermissions', message: 'Must be an object' }]);
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const target = await findUserByIdSafe(db, id, session.tenantId);
      if (!target) {
        return fail(reply, 404, 'user_not_found', 'User not found');
      }
      const verdict = checkPermissionsEdit({ id: session.userId, role: session.userRole }, targetOf(target));
      if (!verdict.ok) return refuse(reply, verdict);

      // Clamped to the granting admin's own effective permission, same as
      // POST /users/invite — an admin can never grant a target user a
      // service level they don't themselves have.
      const servicePermissions = (await resolveRequestedTokenScope(
        db,
        session.userId,
        requested,
      )) ?? {};

      const updated = await db.updateUser(id, { servicePermissions });
      if (!updated) {
        return reply.code(500).send({ error: 'Failed to update permissions' });
      }

      recordPeopleAudit(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
        auditActorOf(request, session),
        {
          event: 'user.permissions.update',
          resourceType: 'user',
          resourceId: id,
          metadata: { services: Object.keys(servicePermissions).sort() },
        },
      );

      return reply.code(200).send({ user: serializeUser(updated) });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      if (error instanceof SyntaxError) {
        return fail(reply, 400, 'invalid_body', 'The request body must be JSON');
      }
      logger.error('Update user permissions error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  /**
   * One action for a page of people (at most MAX_BULK_IDS): disable, enable, revoke
   * their API tokens, add them to / remove them from a group. Every person is judged
   * by the same guards as the single-person endpoints and gets a result of their own,
   * so one refused person (yourself, the owner) does not stop the rest.
   * `dryRun` evaluates the guards and writes nothing. One `user.bulk` audit row
   * summarises the request; the rows the single actions write carry its `batchId`.
   */
  app.post('/users/bulk', { config: { skipAuditOnSuccess: true } }, withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canAdministerPeople(session.userRole)) {
        return fail(reply, 403, 'forbidden', 'Only owners and admins can manage users');
      }

      let body: unknown;
      try {
        body = readJsonBody<unknown>(request);
      } catch {
        return fail(reply, 400, 'invalid_body', 'The request body must be a JSON object');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return fail(reply, 400, 'invalid_body', 'The request body must be a JSON object');
      }
      const input = body as Record<string, unknown>;

      if (typeof input.action !== 'string' || !(BULK_ACTIONS as readonly string[]).includes(input.action)) {
        return fail(reply, 400, 'invalid_action', `action must be one of ${BULK_ACTIONS.join(', ')}`);
      }
      const action = input.action as BulkAction;
      if (!Array.isArray(input.ids) || input.ids.length === 0 || input.ids.some((id) => typeof id !== 'string' || id === '')) {
        return fail(reply, 400, 'invalid_body', 'ids must be a non-empty list of user ids', [{ field: 'ids', message: 'Must be a non-empty list of user ids' }]);
      }
      if (input.ids.length > MAX_BULK_IDS) {
        return fail(reply, 400, 'too_many_ids', `At most ${MAX_BULK_IDS} people can be changed at once`);
      }
      if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > MAX_BULK_REASON_LENGTH)) {
        return fail(reply, 400, 'invalid_body', `reason must be text of at most ${MAX_BULK_REASON_LENGTH} characters`, [{ field: 'reason', message: `At most ${MAX_BULK_REASON_LENGTH} characters` }]);
      }
      if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
        return fail(reply, 400, 'invalid_body', 'dryRun must be true or false', [{ field: 'dryRun', message: 'Must be true or false' }]);
      }
      const groupAction = action === 'add-to-group' || action === 'remove-from-group';
      if (groupAction && (typeof input.groupId !== 'string' || input.groupId === '')) {
        return fail(reply, 400, 'invalid_body', 'groupId is required for this action', [{ field: 'groupId', message: 'Required' }]);
      }

      const ids = [...new Set(input.ids as string[])];
      const dryRun = input.dryRun === true;

      const limit = checkRateLimit(`people-bulk:${session.userId}`, BULK_RATE_LIMIT);
      if (!limit.allowed) return tooManyRequests(reply, limit.retryAfterSeconds);

      // The route is gated on `members`; revoking tokens is also a decision of the `tokens` service,
      // so a policy that forbids it cannot be sidestepped through this route. A refusal that the
      // engine could not decide is thrown and answered as the gate would (the catch below).
      if (action === 'revoke-tokens') {
        const tokens = await authorizeServiceForRequest(request, 'tokens', { method: 'POST', level: 'write' });
        if (!tokens.allowed) {
          return reply.code(403).send(forbiddenBody({ service: 'tokens', required: tokens.required, decisionId: tokens.decisionId ?? '' }));
        }
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      let group;
      if (groupAction) {
        try {
          group = await db.findGroupById(input.groupId as string);
        } catch {
          group = null; // an id the database cannot parse names no group
        }
        if (!group || String(group.tenantId) !== String(session.tenantId)) {
          return fail(reply, 404, 'group_not_found', 'Group not found');
        }
        if (isGroupDirectoryManaged(group)) {
          return fail(reply, 409, 'group_directory_managed', 'Membership of directory groups is managed by the directory');
        }
      }

      const batchId = newBatchId();
      const audit = auditActorOf(request, session);
      const results = await runBulk({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        actor: { id: session.userId, role: session.userRole },
        audit,
        action,
        ids,
        reason: typeof input.reason === 'string' ? input.reason : undefined,
        group: group ?? undefined,
        dryRun,
        batchId,
      });
      const summary = summarizeBulk(results);

      if (!dryRun) {
        recordPeopleAudit(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          audit,
          {
            event: 'user.bulk',
            resourceType: 'user',
            resourceId: batchId,
            metadata: {
              action,
              batchId,
              requested: ids.length,
              ok: summary.ok,
              skipped: summary.skipped,
              failed: summary.failed,
              ...(group ? { groupId: String(group._id) } : {}),
            },
          },
        );
      }

      return reply.code(200).send({
        action,
        dryRun,
        requested: ids.length,
        ...summary,
        batchId,
        results,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      // The engine could not decide the tokens check: answered as the gate would, with its 503.
      const refused = sendProjectContextError(reply, error);
      if (refused) return refused;
      logger.error('Bulk user action error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  /**
   * Bulk import from a CSV, creating PROGRAMMATIC users (`canLogin: false`).
   *
   * The single-user dialog next to this covers a teammate you want to invite;
   * this covers the five hundred developers who will never sign in and only
   * need an identity to attribute usage to. Same user records either way, so
   * groups, RBAC, projects and reports need no special case.
   *
   * The quota is checked for the WHOLE batch before anything is written: an
   * import that would cross the tenant's user limit is refused rather than
   * half-applied, which is the only outcome an admin can actually recover from.
   * Because a concurrent import or invite can eat that headroom while rows are
   * being written, the loop re-checks every 50 creations and stops (reporting
   * `halted`) rather than overshooting `maxUsers`. Files over
   * `MAX_BULK_IMPORT_ROWS` usable rows are refused up front (400).
   */
  app.post('/users/bulk-import', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canAdministerPeople(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can import users' });
      }

      const body = readJsonBody<{ csv?: unknown; role?: unknown; projectId?: unknown }>(request);
      if (typeof body.csv !== 'string' || !body.csv.trim()) {
        return reply.code(400).send({ error: 'Paste or upload a CSV first' });
      }
      const role = typeof body.role === 'string' && ['user', 'admin', 'project_admin', 'portal_user'].includes(body.role)
        ? body.role as 'user' | 'admin' | 'project_admin' | 'portal_user'
        : 'user';

      // Throws CsvImportError(400, { maxRows }) past the cap — handled below.
      const { rows, invalid } = parseUserCsv(body.csv, { maxRows: MAX_BULK_IMPORT_ROWS });
      if (rows.length === 0) {
        return reply.code(400).send({ error: 'No usable rows found in that file', invalid });
      }

      const db = await getDatabase();
      const tenant = await db.findTenantById(session.tenantId);
      if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });
      await db.switchToTenant(session.tenantDbName);

      const existingUsers = await db.listUsers();
      // Same rule the insert loop applies (email if present, else name), so the
      // quota is charged for exactly the rows that will be created — not for
      // name-only rows the loop is going to skip.
      const knownEmails = new Set(
        existingUsers.filter((u) => u.email).map((u) => String(u.email).toLowerCase()),
      );
      const knownNames = new Set(existingUsers.map((u) => String(u.name ?? '').toLowerCase()));
      const newcomers = rows.filter((r) => !rowAlreadyExists(r, knownEmails, knownNames));

      const defaultProject = await ensureDefaultProject(
        session.tenantDbName,
        session.tenantId,
        session.userId || session.tenantId,
      );
      const defaultProjectId = defaultProject._id ? String(defaultProject._id) : undefined;
      if (!defaultProjectId) {
        return reply.code(400).send({ error: 'Project context is missing' });
      }

      const quotaContext = {
        domain: 'global' as const,
        licenseType: tenant.licenseType as LicenseType,
        projectId: defaultProjectId,
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        userId: session.userId,
      };

      // Checked against the count AFTER the import, so a batch that would cross
      // the limit is refused whole. A re-upload with nothing new to create is
      // a no-op and must not 429 at the limit.
      if (newcomers.length > 0) {
        const quota = await checkResourceQuota(
          quotaContext,
          'users',
          existingUsers.length + newcomers.length - 1,
        );
        if (!quota.allowed) {
          return reply.code(429).send({
            error: quota.reason || 'User quota exceeded',
            wouldCreate: newcomers.length,
            current: existingUsers.length,
          });
        }
      }

      const projectIds = typeof body.projectId === 'string' && body.projectId
        ? [body.projectId]
        : undefined;
      const { created, halted } = await importProgrammaticUsers({
        tenantId: session.tenantId,
        rows,
        role,
        projectIds,
        licenseId: tenant.licenseType,
        createdBy: session.userId,
        // The table was read above for the quota arithmetic; the import reuses it instead of reading it again.
        existing: existingUsers,
        checkQuota: (currentCount) => checkResourceQuota(quotaContext, 'users', currentCount),
      });

      const createdEmails = new Set(created.map((c) => (c.email ?? '').toLowerCase()));
      const skippedExisting = rows
        .filter((r) => !created.some((c) => c.name === r.name && (c.email ?? '') === (r.email ?? '')))
        .map((r) => r.email ?? r.name)
        .filter((v) => !createdEmails.has(v.toLowerCase()));

      return reply.code(201).send({
        created,
        createdCount: created.length,
        skippedExisting,
        invalid: invalid.slice(0, 25),
        invalidCount: invalid.length,
        ...(halted ? { halted } : {}),
      });
    } catch (error) {
      if (error instanceof CsvImportError) {
        return reply.code(error.status).send({ error: error.message, ...error.details });
      }
      logger.error('Bulk user import error', { error });
      return reply.code(500).send({ error: 'Failed to import users' });
    }
  }));

  app.post('/users/invite', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canAdministerPeople(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can invite users' });
      }

      const body = readJsonBody<{
        canLogin?: boolean;
        email?: string;
        name?: string;
        projectId?: string;
        /** Several projects, each with its own role: `[{ projectId, role: 'member' | 'project_admin' }]`. `projectId` stays for older callers. */
        projects?: unknown;
        role?: string;
        sendInvite?: boolean;
        servicePermissions?: unknown;
      }>(request);

      // canLogin defaults to true (normal user). When explicitly false this is
      // a service account with no password login capability — there is
      // nothing to invite, so sendInvite is forced off regardless of what was
      // sent.
      const canLogin = body.canLogin !== false;
      const sendInvite = canLogin && body.sendInvite !== false;

      if (!body.name || !body.role) {
        return reply.code(400).send({ error: 'Name and role are required', code: 'invalid_body' });
      }

      if (canLogin && !body.email) {
        return reply.code(400).send({
          error: 'Email is required unless "Can log in" is turned off',
          code: 'email_required',
        });
      }

      if (body.email && !EMAIL_PATTERN.test(body.email)) {
        return reply.code(400).send({ error: 'Invalid email format', code: 'invalid_body' });
      }

      if (!['user', 'admin', 'project_admin', 'portal_user'].includes(body.role)) {
        return reply.code(400).send({
          error: 'Invalid role. Must be user, project_admin, portal_user, or admin',
          code: 'invalid_role',
        });
      }

      const grantsResult = inviteGrantsOf(body);
      if (!grantsResult.ok) {
        return fail(reply, 400, 'invalid_body', grantsResult.error);
      }
      const grants = grantsResult.grants;

      const db = await getDatabase();
      const tenant = await db.findTenantById(session.tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      await db.switchToTenant(session.tenantDbName);
      if (grants.length > 0) {
        const missing = unknownProjectIds(grants, await loadTenantProjects(db, session.tenantId));
        if (missing.length > 0) {
          return fail(reply, 400, 'project_not_found', `Unknown project: ${missing.join(', ')}`);
        }
      }
      const trimmedEmail = (body.email ?? '').trim();
      if (trimmedEmail) {
        const existingUser = await db.findUserByEmail(trimmedEmail);
        if (existingUser) {
          return reply.code(409).send({
            error: 'User with this email already exists in your organization',
            code: 'email_taken',
          });
        }
      }

      // Always CSPRNG-generated (never Math.random) — for the invite-email
      // path it's a one-time temp password emailed to the user; for the
      // no-invite path it's returned once in the response as
      // `generatedPassword`.
      const tempPassword = generateSecurePassword();
      const hashedPassword = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);
      // sendInvite path: force a change on first login (unchanged behavior).
      // No-invite path: force a change only if the account can actually log
      // in — a canLogin=false user has no login to force a change on.
      const mustChangePassword = sendInvite ? true : canLogin;

      const defaultProject = await ensureDefaultProject(
        session.tenantDbName,
        session.tenantId,
        session.userId || session.tenantId,
      );
      const defaultProjectId = defaultProject._id
        ? String(defaultProject._id)
        : undefined;

      if (!defaultProjectId) {
        return reply.code(400).send({ error: 'Project context is missing' });
      }

      const userQuotaCheck = await checkResourceQuota(
        {
          domain: 'global',
          licenseType: tenant.licenseType as LicenseType,
          projectId: defaultProjectId,
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          userId: session.userId,
        },
        'users',
        // a count, not the whole table: the quota only needs how many there are
        await db.iamCountUsers({ tenantId: session.tenantId }),
      );

      if (!userQuotaCheck.allowed) {
        return reply.code(429).send({
          error: userQuotaCheck.reason || 'User quota exceeded',
          code: 'quota_exceeded',
        });
      }

      const initialProjectIds = grants.length > 0 ? grants.map((grant) => grant.projectId) : undefined;

      // Clamped to the inviting admin's own effective permission — an admin
      // can never grant a new user a higher service permission than they
      // themselves hold (same rule as token minting in tokens.ts).
      const servicePermissions = (await resolveRequestedTokenScope(
        db,
        session.userId,
        body.servicePermissions,
      )) ?? {};

      const user = await db.createUser({
        canLogin,
        email: trimmedEmail,
        features: [],
        invitedAt: new Date(),
        invitedBy: session.userId,
        licenseId: tenant.licenseType,
        mustChangePassword,
        name: body.name,
        password: hashedPassword,
        projectIds: initialProjectIds,
        role: body.role as 'user' | 'admin' | 'project_admin' | 'portal_user',
        servicePermissions,
        tenantId: session.tenantId,
      });

      for (const grant of grants) {
        await db.upsertUserProject({
          invitedBy: session.userId,
          projectId: grant.projectId,
          role: grant.role,
          servicePermissions: undefined,
          source: 'manual',
          tenantId: session.tenantId,
          userId: String(user._id),
        });
      }

      const invitationUrl = sendInvite
        ? await createInvitationUrl(user, tenant.slug)
        : undefined;
      let invitationEmailSent = false;
      if (sendInvite) {
        try {
          invitationEmailSent = await sendEmail(trimmedEmail, 'user-invitation', {
            companyName: tenant.companyName,
            email: trimmedEmail,
            // The person who invites, by name: the mail says who asked, not what role they have.
            inviterName: request.rbacUser?.name || session.userEmail || 'An administrator',
            inviteUrl: invitationUrl,
            name: body.name,
            slug: tenant.slug,
          });
        } catch (error) {
          logger.error('Failed to send invitation email', { error });
        }

        if (!invitationEmailSent) {
          logger.warn('Invitation email was not delivered', {
            userId: String(user._id),
          });
        }
      }

      return reply.code(201).send({
        message: sendInvite ? 'User invited successfully' : 'User created successfully',
        user: {
          canLogin: user.canLogin !== false,
          email: user.email,
          id: user._id,
          name: user.name,
          role: user.role,
          servicePermissions: normalizeServicePermissions(user.servicePermissions),
        },
        ...(sendInvite ? { invitationEmailSent, invitationUrl } : {}),
        // Shown once, mirroring POST /tokens' one-time plaintext `token`
        // field — never retrievable again after this response.
        ...(sendInvite ? {} : { generatedPassword: tempPassword }),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Invite user error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/users/:id/invitation-link', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canAdministerPeople(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can copy invitation links' });
      }

      const { id } = request.params as { id: string };
      const db = await getDatabase();
      const tenant = await db.findTenantById(session.tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      await db.switchToTenant(session.tenantDbName);
      const user = await findUserByIdSafe(db, id, session.tenantId);
      if (!user || isUserLoginBlocked(user) || !user.invitedBy || user.inviteAcceptedAt) {
        return reply.code(404).send({ error: 'Pending invitation not found', code: 'no_pending_invite' });
      }
      // The rule the directory reports as allowedActions.copyInvitationLink (never upward, the owner only by themself):
      // the link signs whoever opens it in as that person, so it follows the same rule as every other act on them.
      const verdict = canActOnPerson({ id: session.userId, role: session.userRole }, targetOf(user));
      if (!verdict.ok) return refuse(reply, verdict);

      return reply.code(200).send({
        invitationUrl: await createInvitationUrl(user, tenant.slug),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Create invitation link error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  /**
   * Add one person to several projects at once, each with its own role. Who may: owners and admins, and a project admin
   * of EVERY project named (like the single add under /projects/:id/members); the gate is the `projects` service, the
   * per-project rule is here. Owners and admins already reach every project and an external account never joins one.
   * A person who already has the role in a project is left alone (`skipped`); a different role is an update.
   */
  app.post('/users/:id/projects', { config: { ...authz.service('projects'), skipAuditOnSuccess: true } }, withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);

      let body: { projects?: unknown; servicePermissions?: unknown; notify?: unknown };
      try {
        body = readJsonBody<typeof body>(request);
      } catch {
        return fail(reply, 400, 'invalid_body', 'The request body is not valid JSON');
      }
      const parsed = parseProjectGrants(body?.projects);
      if (!parsed.ok) return fail(reply, 400, 'invalid_body', parsed.error);
      if (parsed.grants.length === 0) return fail(reply, 400, 'invalid_body', 'Name at least one project');
      const custom = body.servicePermissions;
      if (custom !== undefined && custom !== null && (typeof custom !== 'object' || Array.isArray(custom))) {
        return fail(reply, 400, 'invalid_body', 'servicePermissions must be an object or null');
      }
      if (body.notify !== undefined && typeof body.notify !== 'boolean') {
        return fail(reply, 400, 'invalid_body', 'notify must be true or false');
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const target = await findUserByIdSafe(db, id, session.tenantId);
      if (!target) return fail(reply, 404, 'user_not_found', 'User not found');
      if (target.kind === 'external') {
        return fail(reply, 400, 'external_user', 'External users cannot be project members');
      }
      if (target.role === 'owner' || target.role === 'admin') {
        return fail(reply, 400, 'implicit_access', 'Owners and admins are implicitly assigned to all projects');
      }

      const projects = await loadTenantProjects(db, session.tenantId);
      const skipped: Array<{ projectId: string; reason: string }> = [];
      const known = parsed.grants.filter((grant) => {
        if (projects.has(grant.projectId)) return true;
        skipped.push({ projectId: grant.projectId, reason: 'project_not_found' });
        return false;
      });

      const administered = await projectsAdministeredBy(db, { userId: session.userId, role: session.userRole }, known.map((grant) => grant.projectId));
      if (known.some((grant) => !administered.has(grant.projectId))) {
        return fail(reply, 403, 'forbidden', 'You can only add people to projects you administer');
      }

      // Service access a person is given is clamped to what the actor holds themself (the same rule as inviting a person).
      const servicePermissions = custom === undefined || custom === null
        ? custom
        : (await resolveRequestedTokenScope(db, session.userId, custom)) ?? {};

      const applied = await applyProjectGrants(db, {
        actorId: session.userId,
        grants: known,
        servicePermissions,
        tenantId: session.tenantId,
        userId: String(target._id),
      });
      skipped.push(...applied.skipped);

      if (applied.added.length > 0 || applied.updated.length > 0) {
        recordPeopleAudit(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          auditActorOf(request, session),
          {
            event: 'user.projects.add',
            resourceType: 'user',
            resourceId: String(target._id),
            metadata: { added: applied.added, updated: applied.updated },
          },
        );
      }

      if (body.notify === true && applied.added.length > 0) {
        const tenant = await db.findTenantById(session.tenantId);
        // A mail that cannot be sent (no mail server, no address) never undoes the memberships.
        await sendProjectsAddedEmail({
          adderName: request.rbacUser?.name || session.userEmail || 'An administrator',
          companyName: tenant?.companyName ?? '',
          projects: applied.added.map((projectId) => ({
            name: projects.get(projectId)?.name ?? projectId,
            role: known.find((grant) => grant.projectId === projectId)?.role ?? 'member',
          })),
          to: target,
        });
      }

      return reply.code(200).send({ added: applied.added, updated: applied.updated, skipped });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Add user to projects error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  /** The issuers an external person can be added under: those with a token delegation in this workspace. */
  app.get('/users/external/issuers', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canAdministerPeople(session.userRole)) {
        return fail(reply, 403, 'forbidden', 'Only owners and admins can manage external users');
      }
      return reply.code(200).send({ issuers: await listDelegationIssuers(session.tenantDbName) });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('List delegation issuers error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  /**
   * Add an external person by hand: a person of a host application, known by `(issuer, subject)` - the same account a
   * verified assertion would create on first sight (`createExternalAccount`). The issuer must be one the workspace trusts;
   * the identity is unique. Groups may be given (never one that grants access); projects never.
   */
  app.post('/users/external', { config: { skipAuditOnSuccess: true } }, withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canAdministerPeople(session.userRole)) {
        return fail(reply, 403, 'forbidden', 'Only owners and admins can add external users');
      }

      let body: { issuer?: unknown; subject?: unknown; name?: unknown; email?: unknown; groupIds?: unknown; active?: unknown };
      try {
        body = readJsonBody<typeof body>(request);
      } catch {
        return fail(reply, 400, 'invalid_body', 'The request body is not valid JSON');
      }

      const issuer = typeof body.issuer === 'string' ? body.issuer.trim() : '';
      const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
      if (!issuer || issuer.length > MAX_EXTERNAL_ISSUER_LENGTH) return fail(reply, 400, 'invalid_body', 'issuer is required');
      if (!subject || subject.length > MAX_EXTERNAL_SUBJECT_LENGTH) return fail(reply, 400, 'invalid_body', 'subject is required');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (body.name !== undefined && typeof body.name !== 'string') return fail(reply, 400, 'invalid_body', 'name must be text');
      if (name.length > MAX_NAME_LENGTH) return fail(reply, 400, 'invalid_body', `name is at most ${MAX_NAME_LENGTH} characters`);
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (body.email !== undefined && typeof body.email !== 'string') return fail(reply, 400, 'invalid_body', 'email must be text');
      if (email && !EMAIL_PATTERN.test(email)) return fail(reply, 400, 'invalid_body', 'Invalid email format');
      if (body.active !== undefined && typeof body.active !== 'boolean') return fail(reply, 400, 'invalid_body', 'active must be true or false');
      let groupIds: string[] = [];
      if (body.groupIds !== undefined) {
        if (!Array.isArray(body.groupIds) || body.groupIds.some((g) => typeof g !== 'string' || !g.trim()) || body.groupIds.length > 50) {
          return fail(reply, 400, 'invalid_body', 'groupIds must be a list of group ids');
        }
        groupIds = [...new Set((body.groupIds as string[]).map((g) => g.trim()))];
      }

      if (!(await isDelegationIssuer(session.tenantDbName, issuer))) {
        return fail(reply, 400, 'invalid_issuer', 'This issuer is not configured in the workspace');
      }

      const db = await getDatabase();
      const tenant = await db.findTenantById(session.tenantId);
      if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });
      await db.switchToTenant(session.tenantDbName);

      if (email && (await db.findUserByEmail(email))) {
        return fail(reply, 409, 'email_taken', 'An account with this email address already exists');
      }

      const holders = await db.findUsersByExternalIdentity(issuer, subject);
      if (holders.some((holder) => !holder.tenantId || String(holder.tenantId) === String(session.tenantId))) {
        return fail(reply, 409, 'identity_taken', 'An account with this identity already exists');
      }

      // Groups first, so a refused group leaves no half-made account behind. An external account joins no group that grants access.
      const groups = [];
      for (const groupId of groupIds) {
        const group = await db.findGroupById(groupId).catch(() => null);
        if (!group || String(group.tenantId) !== String(session.tenantId)) {
          return fail(reply, 400, 'group_not_found', 'Group not found');
        }
        const verdict = checkGroupMembership(
          { id: session.userId, role: session.userRole },
          targetOf({ role: 'user', kind: 'external', canLogin: false }),
          group,
        );
        if (!verdict.ok) return refuse(reply, verdict);
        groups.push(group);
      }

      // Counts toward the licence's user limit, like every other account (and like the one a verified assertion creates).
      const defaultProject = await ensureDefaultProject(session.tenantDbName, session.tenantId, session.userId || session.tenantId);
      const quota = await checkResourceQuota(
        {
          domain: 'global',
          licenseType: tenant.licenseType as LicenseType,
          projectId: defaultProject._id ? String(defaultProject._id) : '',
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          userId: session.userId,
        },
        'users',
        await db.iamCountUsers({ tenantId: session.tenantId }),
      );
      if (!quota.allowed) {
        return fail(reply, 429, 'quota_exceeded', quota.reason || 'User quota exceeded');
      }

      const user = await createExternalAccount(db, {
        email: email || undefined,
        issuer,
        licenseId: tenant.licenseType,
        name: name || undefined,
        subject,
        tenantId: session.tenantId,
      });

      // No unique index (by design): of the accounts that hold the identity the OLDEST wins, a later one removes itself.
      const rivals = await db.findUsersByExternalIdentity(issuer, subject);
      const winner = rivals.find((candidate) => !candidate.tenantId || String(candidate.tenantId) === String(session.tenantId));
      if (winner && String(winner._id) !== String(user._id)) {
        await db.deleteUser(String(user._id)).catch((error: unknown) => {
          logger.warn('Could not remove the duplicate of a concurrently created account', { error: error instanceof Error ? error.message : String(error) });
        });
        return fail(reply, 409, 'identity_taken', 'An account with this identity already exists');
      }

      for (const group of groups) {
        await db.addGroupMember({
          addedBy: session.userId,
          groupId: String(group._id),
          role: 'member',
          source: 'local',
          tenantId: session.tenantId,
          userId: String(user._id),
        });
      }

      let created: IUser = user;
      if (body.active === false) {
        const disabled = await setUserStatus({
          actor: { type: 'user', userId: session.userId, email: session.userEmail, role: session.userRole },
          ipAddress: getClientIp(request),
          requestId: session.requestId,
          status: 'disabled',
          targetUserId: String(user._id),
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
        });
        if (disabled.ok) created = disabled.user;
      }

      recordPeopleAudit(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
        auditActorOf(request, session),
        {
          event: 'user.external.create',
          resourceType: 'user',
          resourceId: String(user._id),
          metadata: { issuer, groups: groups.map((group) => String(group._id)), active: body.active !== false },
        },
      );

      return reply.code(201).send({ user: serializeUser(created) });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Create external user error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  /**
   * A signed-in person with no accessible project asks the workspace's owners and admins for access: the request is kept
   * on the person (`accessRequest`, which the people list shows while they still have no project), the owners and admins
   * are mailed (when mail is configured) and the request is audited. One request per person per 24 hours.
   */
  app.post('/users/me/access-request', { config: { ...authz.authenticated(), skipAuditOnSuccess: true } }, withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);

      let body: { message?: unknown };
      try {
        body = readJsonBody<{ message?: unknown }>(request) ?? {};
      } catch {
        body = {};
      }
      if (body.message !== undefined && body.message !== null && typeof body.message !== 'string') {
        return fail(reply, 400, 'invalid_body', 'message must be text');
      }
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (message.length > MAX_ACCESS_REQUEST_MESSAGE_LENGTH) {
        return fail(reply, 400, 'invalid_body', `message is at most ${MAX_ACCESS_REQUEST_MESSAGE_LENGTH} characters`);
      }

      const db = await getDatabase();
      const tenant = await db.findTenantById(session.tenantId);
      if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });
      await db.switchToTenant(session.tenantDbName);

      const user = await findUserByIdSafe(db, session.userId, session.tenantId);
      if (!user) return fail(reply, 404, 'user_not_found', 'User not found');

      // A stale id (a deleted project) is no access.
      let hasAccess = user.role === 'owner' || user.role === 'admin';
      if (!hasAccess) {
        const reachable = await collectAccessibleProjectIds(db, String(user._id), user.projectIds);
        if (reachable.length > 0) {
          const existing = await loadTenantProjects(db, session.tenantId);
          hasAccess = reachable.some((projectId) => existing.has(projectId));
        }
      }
      if (hasAccess) {
        return fail(reply, 409, 'already_has_access', 'You already have access to a project');
      }

      const now = new Date();
      const last = user.accessRequest?.at ? new Date(user.accessRequest.at).getTime() : 0;
      const waitMs = last + ACCESS_REQUEST_INTERVAL_MS - now.getTime();
      if (last > 0 && waitMs > 0) {
        return tooManyRequests(reply, Math.ceil(waitMs / 1000));
      }

      const accessRequest = { at: now, ...(message ? { message } : {}) };
      await db.updateUser(String(user._id), { accessRequest });

      recordPeopleAudit(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
        auditActorOf(request, session),
        {
          event: 'user.access.request',
          resourceType: 'user',
          resourceId: String(user._id),
          metadata: { hasMessage: message.length > 0 },
        },
      );

      await sendAccessRequestEmails(db, {
        at: now,
        companyName: tenant.companyName,
        message: message || undefined,
        requester: user,
        tenantId: session.tenantId,
      });

      return reply.code(200).send({ accessRequest: { at: now.toISOString(), message: message || null } });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Access request error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
