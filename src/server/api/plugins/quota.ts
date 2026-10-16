import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  isTenantWideKind,
  type QuotaDomain,
  type QuotaPolicyInput,
  type QuotaScope,
} from '@/lib/quota/types';
import {
  QuotaPolicyValidationError,
  assertValidQuotaPolicy,
  createQuotaPolicy,
  deleteQuotaPolicy,
  describeQuotaPolicies,
  getLicenseDefaults,
  getQuotaPolicyRow,
  listQuotaPolicies,
  pickQuotaPolicyFields,
  updateQuotaPolicy,
} from '@/lib/services/quota/quotaService';
import {
  authorizeServiceForRequest,
  parseBooleanQuery,
  parseCsvQuery,
  readJsonBody,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:quota');

function isQuotaAdmin(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export const quotaApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/quota/defaults', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);

      const license = await getLicenseDefaults(session.tenantId);
      return reply.code(200).send({
        defaults: license.limits,
        license,
        licenseType: license.licenseType,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Get quota defaults error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/quota/policies', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as {
        domain?: QuotaDomain;
        enabled?: string;
        include?: string;
        projectId?: string;
        scope?: QuotaScope;
      };

      const policies = await listQuotaPolicies(session.tenantDbName, session.tenantId, {
        domain: query.domain || undefined,
        enabled: parseBooleanQuery(query.enabled),
        projectId: query.projectId || undefined,
        scope: query.scope || undefined,
      });

      // `?include=targets`: name the user / group / token / agent each policy
      // points at and the project it lives in (the Limits table). Opt-in so the
      // plain list stays one query. It puts people's names and e-mail addresses
      // in the answer, so it is for those who may see people elsewhere in the
      // console: tenant owners and admins, and anyone who can read the IAM center.
      if (parseCsvQuery(query.include)?.includes('targets')) {
        if (!isQuotaAdmin(session.userRole)) {
          const iam = await authorizeServiceForRequest(request, 'iam', { level: 'read' });
          if (!iam.allowed) return reply.code(403).send({ error: 'Forbidden' });
        }
        return reply.code(200).send({
          policies: await describeQuotaPolicies(session.tenantDbName, session.tenantId, policies),
        });
      }

      return reply.code(200).send({ policies });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      // The engine could not decide (the handler-level IAM check above): answered as the gate would, with its 503.
      const refused = sendProjectContextError(reply, error);
      if (refused) return refused;
      logger.error('List quota policies error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/quota/policies', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isQuotaAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const query = (request.query ?? {}) as { projectId?: string };
      const body = readJsonBody<Partial<QuotaPolicyInput>>(request);

      if (!body.scope || !body.domain || !body.limits) {
        return reply.code(400).send({ error: 'scope, domain and limits are required' });
      }

      // The project the row is STORED in is `?projectId=` when the caller sent one, else the
      // body's: validate that one, not just the body's (the two can differ).
      const projectId = query.projectId ?? body.projectId;
      const fields = pickQuotaPolicyFields(body as Record<string, unknown>);
      await assertValidQuotaPolicy(
        session.tenantDbName,
        session.tenantId,
        projectId ? { ...fields, projectId } : fields,
        null,
      );

      const policy = await createQuotaPolicy(session.tenantDbName, session.tenantId, {
        createdBy: session.userId,
        description: body.description,
        domain: body.domain,
        enabled: body.enabled ?? true,
        label: body.label ?? 'Custom policy',
        limits: body.limits,
        priority: Number(body.priority ?? 100),
        projectId,
        scope: body.scope,
        scopeId: body.scopeId,
        ...(body.scope === 'group' ? { groupMode: body.groupMode ?? 'perMember' } : {}),
        updatedBy: session.userId,
      });

      // A policy without a project is only ever loaded for the group and
      // agent-run kinds; for the others it would sit unused, so say so.
      const warnings = !projectId && !isTenantWideKind(body as Pick<QuotaPolicyInput, 'scope' | 'domain'>)
        ? ['project_required']
        : undefined;

      return reply.code(201).send({ policy, ...(warnings ? { warnings } : {}) });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      if (error instanceof QuotaPolicyValidationError) {
        return reply.code(error.status).send({ error: error.message, code: error.code });
      }
      logger.error('Create quota policy error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/quota/policies/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!isQuotaAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const query = (request.query ?? {}) as { projectId?: string };
      const body = readJsonBody<Partial<QuotaPolicyInput>>(request);

      const fields = pickQuotaPolicyFields(body as Record<string, unknown>);
      const existing = await getQuotaPolicyRow(session.tenantDbName, session.tenantId, id);
      // `?projectId=` asserts which project the policy is in (IAM → Limits
      // sends it); a mismatch is a 404, as it always was.
      if (!existing || (query.projectId && String(existing.projectId ?? '') !== query.projectId)) {
        return reply.code(404).send({ error: 'Policy not found' });
      }
      await assertValidQuotaPolicy(session.tenantDbName, session.tenantId, fields, existing);

      // The row is addressed by the project it is in NOW; `projectId` in the
      // body is where it goes (null / '' = every project) and is stored as data.
      const policy = await updateQuotaPolicy(
        session.tenantDbName,
        session.tenantId,
        id,
        { ...fields, updatedBy: session.userId },
        existing.projectId ? String(existing.projectId) : undefined,
      );

      if (!policy) {
        return reply.code(404).send({ error: 'Policy not found' });
      }

      return reply.code(200).send({ policy });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      if (error instanceof QuotaPolicyValidationError) {
        return reply.code(error.status).send({ error: error.message, code: error.code });
      }
      logger.error('Update quota policy error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/quota/policies/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!isQuotaAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const query = (request.query ?? {}) as { projectId?: string };
      const deleted = await deleteQuotaPolicy(
        session.tenantDbName,
        session.tenantId,
        id,
        query.projectId || undefined,
      );

      if (!deleted) {
        return reply.code(404).send({ error: 'Policy not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Delete quota policy error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
