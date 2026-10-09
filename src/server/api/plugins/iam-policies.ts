/**
 * Authorization center API, part 1: the policy catalog, custom policies, the
 * compile / preview / simulate tools and decision lookup. Registered by
 * plugins/iam.ts, so every path is under `/api/iam` (RBAC service `iam`:
 * GET = read, writes = admin).
 *
 *   GET    /iam/catalog                    services, actions, resource types, context attrs, channels
 *   GET    /iam/policies                   { managed, custom }
 *   GET    /iam/policies/:policyId
 *   POST   /iam/policies                   create (spec | cedar)              admin
 *   PUT    /iam/policies/:policyId         update                             admin
 *   DELETE /iam/policies/:policyId         delete                             admin
 *   POST   /iam/policies/compile           spec | cedar -> Cedar + problems   read (computes only)
 *   POST   /iam/policies/preview           impact of a draft                  read (computes only)
 *   POST   /iam/simulate                   access check                       read (computes only)
 *   GET    /iam/decisions/:decisionId      a denial the caller saw -> access check input
 *
 * Errors are always `{ error, code, details? }`; `code: 'validation'` carries
 * `details: [{ message, line?, col?, field? }]`.
 *
 * The three compute-only POSTs are declared at `read` level and skip the success
 * audit row: they change nothing, and the editor calls compile on every pause.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { cedarAvailable } from '@/lib/iam/cedar';
import { authz } from '@/lib/iam/routeAuthz';
import { buildCatalog } from '@/lib/iam/catalog';
import { listManagedPolicyViews, summarizeEffect, toPolicyRow, toPolicyRows } from '@/lib/iam/policyRows';
import { cedarIssues, compileSpec, isSameSpec, trustedProxiesWarning, type PolicyIssue, type PolicySpec } from '@/lib/iam/policySpec';
import { trustsEveryHop } from '@/lib/security/trustedProxy';
import { validateCustomPolicyText } from '@/lib/iam/policyText';
import {
  IamPolicyError,
  MAX_POLICIES_PER_TENANT,
  createPolicy,
  deletePolicy,
  getPolicy,
  listPolicies,
  updatePolicy,
  type IIamPolicy,
  type IamPolicyMode,
} from '@/lib/iam/store';
import { policyAuditMetadata, recordIamChange, type IamActor } from '@/lib/iam/audit';
import { clearPolicyMonitorStats } from '@/lib/iam/shadow/aggregate';
import { previewPolicy, PreviewInputError } from '@/lib/iam/preview';
import { simulate, SimulateInputError } from '@/lib/iam/simulate';
import { checkRateLimit, type RateLimitConfig } from '@/lib/services/auth/rateLimiter';
import { DECISION_ID_RE, getDecision } from '@/lib/iam/decisions';
import {
  requireSessionContext,
  safeReadJsonBody,
  withApiRequestContext,
  type ApiSessionContext,
} from '../fastify-utils';

const logger = createLogger('api:iam-policies');

export { MAX_POLICIES_PER_TENANT };
const MAX_NAME = 120;
const MAX_DESCRIPTION = 1_000;
const POLICY_ID_PARAM_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

type Details = PolicyIssue[] | undefined;

function fail(reply: FastifyReply, status: number, code: string, error: string, details?: Details) {
  return reply.code(status).send({ error, code, ...(details && details.length > 0 ? { details } : {}) });
}

/**
 * Per-person budgets for the compute-only POSTs. They are declared at `read`
 * level (so a read-only auditor can use the Access check) and each one costs real
 * work - directory reads, Cedar evaluations - so a loop must not be free.
 * The editor compiles once per pause in typing (~2 / s at most) and previews on a click.
 */
const COMPUTE_LIMITS = {
  compile: { maxAttempts: 240, windowSeconds: 60 },
  simulate: { maxAttempts: 120, windowSeconds: 60 },
  preview: { maxAttempts: 12, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitConfig>;

/** A 429 reply when this person has used up the budget of `bucket`, else null. */
function overBudget(reply: FastifyReply, session: ApiSessionContext, bucket: keyof typeof COMPUTE_LIMITS) {
  const verdict = checkRateLimit(`iam:${bucket}:${session.tenantDbName}:${session.userId}`, COMPUTE_LIMITS[bucket]);
  if (verdict.allowed) return null;
  reply.header('Retry-After', String(Math.max(1, verdict.retryAfterSeconds)));
  return fail(reply, 429, 'rate_limited', 'Too many requests. Wait a moment and try again.');
}

const tenantOf = (session: ApiSessionContext) => ({ tenantDbName: session.tenantDbName, tenantId: session.tenantId });

const actorOf = (session: ApiSessionContext): IamActor => ({
  tenantDbName: session.tenantDbName,
  tenantId: session.tenantId,
  userId: session.userId,
  userEmail: session.userEmail,
  userRole: session.userRole,
  requestId: session.requestId,
});

/**
 * An allow rule that takes effect GRANTS access, which is permission management:
 * everywhere else in the product that is for workspace owners and admins only (a
 * delegated `iam` admin can restrict, not grant). So a policy that has a permit
 * statement, is enforcing and is enabled may only be saved - or changed while in
 * that state - by an owner or admin. Designing one (monitor mode, or disabled) is
 * open to any iam admin; promoting it is not.
 */
function permitNeedsAdmin(
  session: ApiSessionContext,
  next: { cedar: string; mode: IamPolicyMode; enabled: boolean },
  previous?: Pick<IIamPolicy, 'cedar' | 'mode' | 'enabled'>,
): boolean {
  if (session.userRole === 'owner' || session.userRole === 'admin') return false;
  const grants = (cedar: string) => summarizeEffect(cedar).effect !== 'forbid';
  const takesEffect = next.mode === 'enforce' && next.enabled && grants(next.cedar);
  if (!takesEffect) return false;
  const alreadyEffective = !!previous && previous.mode === 'enforce' && previous.enabled && grants(previous.cedar);
  return !alreadyEffective || next.cedar !== previous?.cedar;
}

const PERMIT_NEEDS_ADMIN = 'Only workspace owners and admins can make a rule that allows access take effect. Save it in monitor mode, or ask an owner or admin.';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ── body ─────────────────────────────────────────────────────────────────

interface PolicyBody {
  name?: string;
  description?: string | null;
  mode?: IamPolicyMode;
  enabled?: boolean;
  spec?: unknown;
  cedar?: string;
}

function parsePolicyBody(raw: unknown, creating: boolean): { ok: true; body: PolicyBody } | { ok: false; details: PolicyIssue[] } {
  const issues: PolicyIssue[] = [];
  if (!isRecord(raw)) return { ok: false, details: [{ message: 'The request body must be a JSON object' }] };
  const body: PolicyBody = {};
  for (const key of Object.keys(raw)) {
    if (!['name', 'description', 'mode', 'enabled', 'spec', 'cedar'].includes(key)) issues.push({ message: `Unknown field "${key}"`, field: key });
  }

  if (raw.name !== undefined || creating) {
    if (typeof raw.name !== 'string' || raw.name.trim().length === 0) issues.push({ message: 'name is required', field: 'name' });
    else if (raw.name.trim().length > MAX_NAME) issues.push({ message: `name is at most ${MAX_NAME} characters`, field: 'name' });
    else body.name = raw.name.trim();
  }
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== 'string') issues.push({ message: 'description must be text', field: 'description' });
    else if (raw.description.length > MAX_DESCRIPTION) issues.push({ message: `description is at most ${MAX_DESCRIPTION} characters`, field: 'description' });
    else body.description = raw.description.trim();
  } else if (raw.description === null) {
    body.description = null;
  }
  if (raw.mode !== undefined || creating) {
    if (raw.mode !== 'monitor' && raw.mode !== 'enforce') issues.push({ message: 'mode must be "monitor" or "enforce"', field: 'mode' });
    else body.mode = raw.mode;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') issues.push({ message: 'enabled must be true or false', field: 'enabled' });
    else body.enabled = raw.enabled;
  } else if (creating) {
    body.enabled = true;
  }

  const hasSpec = raw.spec !== undefined && raw.spec !== null;
  const hasCedar = raw.cedar !== undefined && raw.cedar !== null;
  if (hasSpec && hasCedar) issues.push({ message: 'Send either a spec or Cedar text, not both', field: 'spec' });
  else if (creating && !hasSpec && !hasCedar) issues.push({ message: 'Send a spec or Cedar text', field: 'spec' });
  if (hasSpec) body.spec = raw.spec;
  if (hasCedar) {
    if (typeof raw.cedar !== 'string') issues.push({ message: 'cedar must be text', field: 'cedar' });
    else body.cedar = raw.cedar;
  }
  return issues.length > 0 ? { ok: false, details: issues } : { ok: true, body };
}

/** The Cedar (+ spec) a body asks to store; problems become a 400 `validation`. */
async function materialize(
  session: ApiSessionContext,
  body: PolicyBody,
  stored?: PolicySpec | null,
): Promise<{ ok: true; cedar: string; spec: PolicySpec | null } | { ok: false; details: PolicyIssue[] } | null> {
  if (body.spec !== undefined) {
    // A spec that is exactly the stored one is not re-checked against the directory: the people
    // and groups it names may have left since, and that must not stop an admin from switching
    // the policy to monitor or turning it off. Anything that CHANGES is verified in full.
    const out = await compileSpec(body.spec, isSameSpec(body.spec, stored) ? undefined : tenantOf(session));
    return out.ok && out.spec ? { ok: true, cedar: out.cedar, spec: out.spec } : { ok: false, details: out.errors };
  }
  if (body.cedar !== undefined) {
    const validation = validateCustomPolicyText(body.cedar);
    if (!validation.valid) return { ok: false, details: cedarIssues(validation.errors, body.cedar, validation.statements) };
    return { ok: true, cedar: body.cedar, spec: null };
  }
  return null; // nothing to (re)write
}

function mapStoreError(reply: FastifyReply, error: unknown) {
  if (error instanceof IamPolicyError) {
    const details = error.details.map((d) => ({ message: d.message }));
    switch (error.code) {
      case 'validation': return fail(reply, 400, 'validation', error.message, details);
      case 'conflict': return fail(reply, 409, 'conflict', error.message);
      case 'limit_reached': return fail(reply, 409, 'limit_reached', error.message);
      case 'not_found': return fail(reply, 404, 'not_found', error.message);
      default: return fail(reply, 400, 'invalid_input', error.message);
    }
  }
  return null;
}

const internal = (reply: FastifyReply, what: string, error: unknown) => {
  logger.error(what, { error: error instanceof Error ? error.message : String(error) });
  // The policy engine cannot run here at all (no WASM): say so instead of a bare 500.
  if (!cedarAvailable()) return fail(reply, 503, 'engine_unavailable', 'The policy engine is not available on this server');
  return fail(reply, 500, 'internal', what);
};

async function rowOf(session: ApiSessionContext, policy: IIamPolicy) {
  return (await toPolicyRows(tenantOf(session), [policy]))[0] ?? toPolicyRow(policy);
}

// ── plugin ───────────────────────────────────────────────────────────────

export const iamPoliciesApiPlugin: FastifyPluginAsync = async (app) => {
  const readOnlyPost = { config: { ...authz.service('iam', 'read'), skipAuditOnSuccess: true } };
  // Policy writes record their own audit row (recordIamChange, with the new Cedar); the generic request row would repeat it.
  const auditedWrite = { config: { skipAuditOnSuccess: true } };

  // ── catalog ─────────────────────────────────────────────────────────────
  app.get('/iam/catalog', withApiRequestContext(async (_request, reply) => {
    try {
      return reply.send(buildCatalog());
    } catch (error) {
      return internal(reply, 'Failed to build the catalog', error);
    }
  }));

  // ── policies: read ──────────────────────────────────────────────────────
  app.get('/iam/policies', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    try {
      const policies = (await listPolicies(session.tenantDbName)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return reply.send({
        managed: listManagedPolicyViews(),
        custom: await toPolicyRows(tenantOf(session), policies),
      });
    } catch (error) {
      return internal(reply, 'Failed to list policies', error);
    }
  }));

  app.get('/iam/policies/:policyId', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    const { policyId } = request.params as { policyId: string };
    if (!POLICY_ID_PARAM_RE.test(policyId)) return fail(reply, 404, 'not_found', 'Policy not found');
    try {
      const policy = await getPolicy(session.tenantDbName, policyId);
      if (!policy) return fail(reply, 404, 'not_found', 'Policy not found');
      return reply.send(await rowOf(session, policy));
    } catch (error) {
      return internal(reply, 'Failed to read the policy', error);
    }
  }));

  // ── policies: write ─────────────────────────────────────────────────────
  app.post('/iam/policies', auditedWrite, withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    const parsed = parsePolicyBody(safeReadJsonBody(request), true);
    if (!parsed.ok) return fail(reply, 400, 'validation', 'The policy is not valid', parsed.details);
    try {
      const material = await materialize(session, parsed.body);
      if (!material || !material.ok) return fail(reply, 400, 'validation', 'The policy is not valid', material?.details);
      if (permitNeedsAdmin(session, { cedar: material.cedar, mode: parsed.body.mode as IamPolicyMode, enabled: parsed.body.enabled !== false })) {
        return fail(reply, 403, 'permit_requires_admin', PERMIT_NEEDS_ADMIN);
      }

      const policy = await createPolicy(session.tenantDbName, {
        name: parsed.body.name as string,
        description: parsed.body.description ?? undefined,
        cedar: material.cedar,
        spec: material.spec,
        mode: parsed.body.mode,
        enabled: parsed.body.enabled,
      }, session.userId);

      await recordIamChange(request, actorOf(session), {
        event: 'iam.policy.create',
        resourceType: 'iam-policy',
        resourceId: policy.policyId,
        metadata: policyAuditMetadata(policy),
      });
      return reply.code(201).send(await rowOf(session, policy));
    } catch (error) {
      return mapStoreError(reply, error) ?? internal(reply, 'Failed to create the policy', error);
    }
  }));

  app.put('/iam/policies/:policyId', auditedWrite, withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    const { policyId } = request.params as { policyId: string };
    if (!POLICY_ID_PARAM_RE.test(policyId)) return fail(reply, 404, 'not_found', 'Policy not found');
    const parsed = parsePolicyBody(safeReadJsonBody(request), false);
    if (!parsed.ok) return fail(reply, 400, 'validation', 'The policy is not valid', parsed.details);
    try {
      const previous = await getPolicy(session.tenantDbName, policyId);
      if (!previous) return fail(reply, 404, 'not_found', 'Policy not found');

      const material = await materialize(session, parsed.body, previous.spec);
      if (material && !material.ok) return fail(reply, 400, 'validation', 'The policy is not valid', material.details);
      if (permitNeedsAdmin(session, {
        cedar: material?.cedar ?? previous.cedar,
        mode: parsed.body.mode ?? previous.mode,
        enabled: parsed.body.enabled ?? previous.enabled,
      }, previous)) {
        return fail(reply, 403, 'permit_requires_admin', PERMIT_NEEDS_ADMIN);
      }

      const updated = await updatePolicy(session.tenantDbName, policyId, {
        name: parsed.body.name,
        description: parsed.body.description,
        ...(material ? { cedar: material.cedar, spec: material.spec } : {}),
        mode: parsed.body.mode,
        enabled: parsed.body.enabled,
      }, session.userId);

      // The old "would change" counts describe the old text / mode.
      const behaviourChanged = (material && material.cedar !== previous.cedar)
        || updated.mode !== previous.mode
        || updated.enabled !== previous.enabled;
      if (behaviourChanged) {
        await clearPolicyMonitorStats(session.tenantDbName, policyId).catch((error: unknown) => {
          logger.warn('Could not reset the monitor counts of a changed policy', { policyId, error: error instanceof Error ? error.message : String(error) });
        });
      }

      await recordIamChange(request, actorOf(session), {
        event: 'iam.policy.update',
        resourceType: 'iam-policy',
        resourceId: policyId,
        metadata: {
          ...policyAuditMetadata(updated),
          previous: { name: previous.name, mode: previous.mode, enabled: previous.enabled, cedarChanged: !!material && material.cedar !== previous.cedar },
        },
      });
      return reply.send(await rowOf(session, updated));
    } catch (error) {
      return mapStoreError(reply, error) ?? internal(reply, 'Failed to update the policy', error);
    }
  }));

  app.delete('/iam/policies/:policyId', auditedWrite, withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    const { policyId } = request.params as { policyId: string };
    if (!POLICY_ID_PARAM_RE.test(policyId)) return fail(reply, 404, 'not_found', 'Policy not found');
    try {
      const existing = await getPolicy(session.tenantDbName, policyId);
      if (!existing || !(await deletePolicy(session.tenantDbName, policyId))) return fail(reply, 404, 'not_found', 'Policy not found');
      await clearPolicyMonitorStats(session.tenantDbName, policyId).catch(() => undefined);
      await recordIamChange(request, actorOf(session), {
        event: 'iam.policy.delete',
        resourceType: 'iam-policy',
        resourceId: policyId,
        metadata: policyAuditMetadata(existing),
      });
      return reply.code(204).send();
    } catch (error) {
      return mapStoreError(reply, error) ?? internal(reply, 'Failed to delete the policy', error);
    }
  }));

  // ── compile / preview / simulate ────────────────────────────────────────
  app.post('/iam/policies/compile', readOnlyPost, withApiRequestContext(async (request: FastifyRequest, reply) => {
    const session = requireSessionContext(request);
    const limited = overBudget(reply, session, 'compile');
    if (limited) return limited;
    const body = safeReadJsonBody<Record<string, unknown>>(request);
    const hasSpec = body.spec !== undefined && body.spec !== null;
    const hasCedar = body.cedar !== undefined && body.cedar !== null;
    if (hasSpec === hasCedar) return fail(reply, 400, 'validation', 'Send either a spec or Cedar text', [{ message: 'Send either a spec or Cedar text' }]);
    try {
      if (hasSpec) {
        const out = await compileSpec(body.spec, tenantOf(session));
        return reply.send({ cedar: out.cedar, ok: out.ok, errors: out.errors, warnings: out.warnings });
      }
      if (typeof body.cedar !== 'string') return fail(reply, 400, 'validation', 'cedar must be text', [{ message: 'cedar must be text', field: 'cedar' }]);
      const validation = validateCustomPolicyText(body.cedar);
      return reply.send({
        cedar: body.cedar,
        ok: validation.valid,
        errors: cedarIssues(validation.errors, body.cedar, validation.statements),
        warnings: [
          ...cedarIssues(validation.warnings, body.cedar, validation.statements),
          // a hand-written rule on `context.ip` depends on the same thing
          ...(/\bcontext\.ip\b/.test(body.cedar) && trustsEveryHop() ? [trustedProxiesWarning()] : []),
        ],
      });
    } catch (error) {
      return internal(reply, 'Failed to compile the policy', error);
    }
  }));

  app.post('/iam/policies/preview', readOnlyPost, withApiRequestContext(async (request: FastifyRequest, reply) => {
    const session = requireSessionContext(request);
    const limited = overBudget(reply, session, 'preview');
    if (limited) return limited;
    try {
      return reply.send(await previewPolicy(tenantOf(session), safeReadJsonBody(request)));
    } catch (error) {
      if (error instanceof PreviewInputError) return fail(reply, error.status, error.code, error.message, error.details);
      return internal(reply, 'Failed to preview the policy', error);
    }
  }));

  app.post('/iam/simulate', readOnlyPost, withApiRequestContext(async (request: FastifyRequest, reply) => {
    const session = requireSessionContext(request);
    const limited = overBudget(reply, session, 'simulate');
    if (limited) return limited;
    try {
      return reply.send(await simulate(tenantOf(session), safeReadJsonBody(request)));
    } catch (error) {
      if (error instanceof SimulateInputError) return fail(reply, error.status, error.code, error.message, error.details);
      return internal(reply, 'Failed to run the access check', error);
    }
  }));

  // ── decisions ───────────────────────────────────────────────────────────
  app.get('/iam/decisions/:decisionId', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    const { decisionId } = request.params as { decisionId: string };
    if (!DECISION_ID_RE.test(decisionId)) return fail(reply, 404, 'not_found', 'Decision not found');
    try {
      const decision = await getDecision(tenantOf(session), decisionId);
      return decision ? reply.send(decision) : fail(reply, 404, 'not_found', 'Decision not found');
    } catch (error) {
      return internal(reply, 'Failed to look up the decision', error);
    }
  }));
};
