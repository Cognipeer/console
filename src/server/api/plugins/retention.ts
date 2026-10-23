/**
 * Central log retention API (src/lib/retention).
 *
 * Mapped to the `audit` admin service: reads need `audit:read`, every change
 * (policy, purge) needs `audit:admin`. The two preview endpoints only count,
 * so they are declared read.
 */

import type { FastifyPluginAsync } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import { authz } from '@/lib/iam/routeAuthz';
import { listAuditLogs, sanitizeAuditLog } from '@/lib/services/audit';
import { RETENTION_CLASS_IDS, RETENTION_CLASSES, RETENTION_PRESETS, isRetentionClassId, type RetentionClassId } from '@/lib/retention/classes';
import { countWork, planWork, totalsByClass, type PlanOptions, type RetentionItemResult } from '@/lib/retention/engine';
import {
  RetentionPolicyError,
  cancelPending,
  loadPolicy,
  parsePolicyInput,
  resolveClasses,
  savePolicy,
  type RetentionPolicyInput,
} from '@/lib/retention/policy';
import {
  RetentionPurgeConflictError,
  cancelPurge,
  getLastSweep,
  getPurgeStatus,
  requestPurge,
  type PurgeRequest,
} from '@/lib/retention/scheduler';
import { getLegacyRetentionTargets, getRetentionTargets, policyDrivenClasses } from '@/lib/retention/targets';
import {
  readJsonObjectBody,
  requireSessionContext,
  safeReadJsonBody,
  withApiRequestContext,
  type ApiSessionContext,
} from '../fastify-utils';

const logger = createLogger('api:retention');

const READ = { config: authz.service('audit', 'read') } as const;
const MAX_PURGE_DAYS = 3650;
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class BadRequest extends Error {}

function parsePurgeRequest(body: unknown): PurgeRequest {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  let mode: PurgeRequest['mode'];
  if (raw.mode === 'policy') {
    mode = { kind: 'policy' };
  } else if (raw.mode === 'olderThan') {
    const days = raw.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > MAX_PURGE_DAYS) {
      throw new BadRequest(`days must be a whole number between 0 and ${MAX_PURGE_DAYS}`);
    }
    mode = { kind: 'olderThan', days };
  } else {
    throw new BadRequest('mode must be "policy" or "olderThan"');
  }

  const request: PurgeRequest = { mode };
  if (raw.classes !== undefined && raw.classes !== null) {
    const editable = policyDrivenClasses();
    if (!Array.isArray(raw.classes) || raw.classes.length === 0
      || raw.classes.some((id) => !isRetentionClassId(id) || !editable.has(id))) {
      throw new BadRequest('classes must be a non-empty list of retention classes');
    }
    request.classes = [...new Set(raw.classes as RetentionClassId[])];
  }
  if (raw.projectId !== undefined && raw.projectId !== null && raw.projectId !== '') {
    if (typeof raw.projectId !== 'string' || !PROJECT_ID_RE.test(raw.projectId)) throw new BadRequest('invalid projectId');
    request.projectId = raw.projectId;
  }
  return request;
}

function summarize(items: RetentionItemResult[]) {
  const byClass = totalsByClass(items);
  let deleted = 0;
  let redacted = 0;
  for (const totals of Object.values(byClass)) {
    deleted += totals?.deleted ?? 0;
    redacted += totals?.redacted ?? 0;
  }
  return {
    deleted,
    redacted,
    byClass,
    targets: items.map(({ targetId, collection, class: cls, action, days, affected, error }) => ({
      targetId, collection, class: cls, action, days, affected, ...(error ? { error } : {}),
    })),
    errors: items.filter((i) => i.error).length,
  };
}

async function preview(session: ApiSessionContext, policy: RetentionPolicyInput | null, plan: Omit<PlanOptions, 'now'>) {
  return runWithTenantScope(session.tenantDbName, async (db) => {
    const effective = policy ?? await loadPolicy(db);
    return summarize(await countWork(db, planWork(effective, { ...plan, now: new Date() })));
  });
}

function actorOf(session: ApiSessionContext): string | null {
  return session.userEmail || session.userId || null;
}

export const retentionApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/retention', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const cfg = getConfig().retention;
      const policy = await runWithTenantScope(session.tenantDbName, (db) => loadPolicy(db));
      const resolved = resolveClasses(policy);
      const editable = policyDrivenClasses();
      const deployment = resolveClasses({ preset: 'custom', classes: {}, projects: {} });
      const daysOf = (id: RetentionClassId) => resolved[id].days;

      return reply.code(200).send({
        // What a purge confirmation must repeat.
        workspace: { slug: session.tenantSlug },
        engine: {
          enabled: cfg.enabled,
          dryRun: cfg.dryRun,
          intervalSeconds: cfg.intervalSeconds,
          shortenDelayHours: cfg.shortenDelayHours,
          auditMinDays: cfg.auditMinDays,
          recordsDays: cfg.recordsDays,
        },
        policy,
        classes: RETENTION_CLASS_IDS.map((id) => ({
          id,
          action: RETENTION_CLASSES[id].action,
          editable: editable.has(id),
          days: resolved[id].days,
          source: resolved[id].source,
          defaultDays: deployment[id].days,
          minDays: resolved[id].minDays,
          maxDays: resolved[id].maxDays,
        })),
        presets: RETENTION_PRESETS,
        targets: getRetentionTargets().map((target) => ({
          id: target.id,
          collection: target.collection,
          label: target.label,
          edition: target.edition,
          projectScoped: Boolean(target.projectField),
          phases: target.phases.map((phase) => ({
            class: phase.class,
            action: phase.action,
            days: phase.fixedDays ? phase.fixedDays() : daysOf(phase.class),
            fixed: Boolean(phase.fixedDays),
          })),
        })),
        legacy: getLegacyRetentionTargets().map((target) => ({
          id: target.id,
          collection: target.collection,
          label: target.label,
          edition: target.edition,
          class: target.class,
          managedBy: target.managedBy,
          setting: target.setting,
          days: target.days(),
        })),
        lastSweep: await getLastSweep(session.tenantDbName),
        purge: await getPurgeStatus(session.tenantDbName),
      });
    } catch (error) {
      logger.error('Get retention error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.put('/retention/policy', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const input = parsePolicyInput(readJsonObjectBody(request));
      const policy = await runWithTenantScope(session.tenantDbName, (db) => savePolicy(db, input, actorOf(session)));
      return reply.code(200).send({ policy });
    } catch (error) {
      if (error instanceof SyntaxError) return reply.code(400).send({ error: 'Invalid JSON body' });
      if (error instanceof RetentionPolicyError) {
        return reply.code(400).send({ error: error.message, details: error.details });
      }
      logger.error('Save retention policy error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/retention/policy/pending', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const policy = await runWithTenantScope(session.tenantDbName, (db) => cancelPending(db, actorOf(session)));
      return reply.code(200).send({ policy });
    } catch (error) {
      logger.error('Cancel pending retention policy error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/retention/policy/preview', READ, withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const draft = parsePolicyInput(readJsonObjectBody(request));
      return reply.code(200).send(await preview(session, draft, { mode: { kind: 'policy' } }));
    } catch (error) {
      if (error instanceof SyntaxError) return reply.code(400).send({ error: 'Invalid JSON body' });
      if (error instanceof RetentionPolicyError) {
        return reply.code(400).send({ error: error.message, details: error.details });
      }
      logger.error('Preview retention policy error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/retention/purge/preview', READ, withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const purge = parsePurgeRequest(safeReadJsonBody(request));
      return reply.code(200).send(await preview(session, null, purge));
    } catch (error) {
      if (error instanceof BadRequest) return reply.code(400).send({ error: error.message });
      logger.error('Preview retention purge error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/retention/purge', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const body = safeReadJsonBody(request);
      const purge = parsePurgeRequest(body);
      const confirm = body.confirm;
      if (typeof confirm !== 'string' || confirm.trim() !== session.tenantSlug) {
        return reply.code(400).send({ error: 'Type the workspace slug to confirm', code: 'confirmation_required' });
      }
      const estimate = await preview(session, null, purge);
      const status = await requestPurge(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, tenantSlug: session.tenantSlug },
        purge,
        actorOf(session),
        estimate.deleted + estimate.redacted,
      );
      return reply.code(202).send({ purge: status });
    } catch (error) {
      if (error instanceof BadRequest) return reply.code(400).send({ error: error.message });
      if (error instanceof RetentionPurgeConflictError) return reply.code(409).send({ error: error.message });
      logger.error('Start retention purge error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/retention/purge', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      return reply.code(200).send({ purge: await getPurgeStatus(session.tenantDbName) });
    } catch (error) {
      logger.error('Get retention purge error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/retention/purge', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      return reply.code(200).send({ purge: await cancelPurge(session.tenantDbName) });
    } catch (error) {
      logger.error('Cancel retention purge error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/retention/runs', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as { limit?: string; skip?: string };
      const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
      const skip = Math.max(Number(query.skip) || 0, 0);
      const logs = await listAuditLogs(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
        { service: 'retention', limit, skip },
      );
      return reply.code(200).send({ runs: logs.map(sanitizeAuditLog) });
    } catch (error) {
      logger.error('List retention runs error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
