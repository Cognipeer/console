import { getDatabase, runWithTenantScope, type IQuotaPolicy } from '@/lib/database';
import { getCache } from '@/lib/core/cache';
import { createLogger } from '@/lib/core/logger';
import { LicenseManager } from '@/lib/license/license-manager';
import { quotaPolicyCacheKey } from '@/lib/quota/quotaGuard';
import {
  QUOTA_GROUP_MODES,
  QUOTA_IP_MODES,
  QUOTA_SCOPES,
  type QuotaDomain,
  type QuotaGroupMode,
  type QuotaIpMode,
  type QuotaLimits,
  type QuotaPolicy,
  type QuotaPolicyInput,
  type QuotaScope,
} from '@/lib/quota/types';
import { offeredQuotaDomains, offeredQuotaJobKinds } from '@/enterprise/quota-domains';
import { validateQuotaIpRanges } from '@/lib/quota/ipScope';

const logger = createLogger('quota-service');

/**
 * Drop the cached license + policy set so an edit applies to the next request
 * instead of after QUOTA_POLICY_CACHE_TTL_SECONDS.
 *
 * Best-effort. The cache is keyed per project, so an edit that names a project
 * drops that key. An edit that names none — a tenant-wide group or agent-run
 * policy applies to EVERY project — drops the key of each project of the tenant.
 * (Another node's in-memory copy still expires on the TTL, as it always has.)
 */
async function invalidatePolicyCache(
  tenantDbName: string,
  tenantId: string,
  ...projectIds: Array<string | undefined | null>
): Promise<void> {
  try {
    const cache = await getCache();
    const named = [...new Set(projectIds.filter((id): id is string => Boolean(id)))];
    let targets = named;
    if (named.length === 0) {
      targets = await runWithTenantScope(
        tenantDbName,
        async (db) => (await db.listProjects(tenantId)).map((project) => String(project._id)),
      );
    }
    await Promise.all(
      targets.map((projectId) => cache.del(quotaPolicyCacheKey(tenantDbName, tenantId, projectId))),
    );
  } catch (error) {
    logger.warn('Failed to invalidate quota policy cache; entry expires on TTL', {
      tenantId,
      projectIds: projectIds.filter(Boolean),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizePolicy(policy: IQuotaPolicy): QuotaPolicy {
  const { groupMode, ipMode, ipRanges, ...rest } = policy;
  return {
    ...rest,
    _id: policy._id ? policy._id.toString() : undefined,
    // Only a group policy has a mode; a null/stale value on any other row (or a
    // MongoDB null) must not leak into the API.
    ...(policy.scope === 'group'
      ? { groupMode: groupMode === 'shared' ? 'shared' as const : 'perMember' as const }
      : {}),
    // Likewise only an IP policy has ranges and a mode.
    ...(policy.scope === 'ip'
      ? {
        ipMode: ipMode === 'shared' ? 'shared' as const : 'perAddress' as const,
        ipRanges: Array.isArray(ipRanges) ? ipRanges : [],
      }
      : {}),
  };
}

export async function getLicenseDefaults(tenantId: string) {
  const db = await getDatabase();
  const tenant = await db.findTenantById(tenantId);
  return LicenseManager.getEffectiveLicenseForTenant(tenant);
}

export interface ListQuotaPoliciesOptions {
  domain?: QuotaDomain;
  scope?: QuotaScope;
  enabled?: boolean;
  projectId?: string;
}

export async function listQuotaPolicies(
  tenantDbName: string,
  tenantId: string,
  options?: ListQuotaPoliciesOptions,
): Promise<QuotaPolicy[]> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const allPolicies = await db.listQuotaPolicies(tenantId, options?.projectId);

    let policies = allPolicies;

    // Apply filters
    if (options?.domain) {
      policies = policies.filter(p => p.domain === options.domain || p.domain === 'global');
    }
    if (options?.scope) {
      policies = policies.filter(p => p.scope === options.scope);
    }
    if (options?.enabled !== undefined) {
      policies = policies.filter(p => (p as { enabled?: boolean }).enabled === options.enabled);
    }

    return policies.map(normalizePolicy);
  });
}

// ── validation ───────────────────────────────────────────────────────────

/** A request the policy API refuses; `status` is the HTTP answer, `code` the machine-readable reason. */
export class QuotaPolicyValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = 'QuotaPolicyValidationError';
  }
}

/** Fields a create/update may carry. Anything else in a body is ignored, never written. */
export function pickQuotaPolicyFields(body: Record<string, unknown>): Partial<QuotaPolicyInput> {
  const picked: Record<string, unknown> = {};
  for (const key of [
    'scope',
    'scopeId',
    'groupMode',
    'ipRanges',
    'ipMode',
    'domain',
    'priority',
    'enabled',
    'label',
    'description',
    'limits',
    'projectId',
  ] as const) {
    if (body[key] !== undefined) picked[key] = body[key];
  }
  // Store ranges in their normalized spelling; a list that does not validate is
  // left as sent so `assertValidQuotaPolicy` can say what is wrong with it.
  if (picked.ipRanges !== undefined) {
    const ranges = validateQuotaIpRanges(picked.ipRanges);
    if (ranges.ok) picked.ipRanges = ranges.ranges;
  }
  return picked as Partial<QuotaPolicyInput>;
}

/** Whether a limits object sets anything besides `rateLimit` (a number other than -1 = "unlimited"). */
function setsMoreThanRateLimit(limits: QuotaLimits | undefined): boolean {
  if (!limits || typeof limits !== 'object') return false;
  const sets = (node: unknown): boolean => {
    if (typeof node === 'number') return node !== -1;
    if (Array.isArray(node)) return node.some(sets);
    if (node && typeof node === 'object') return Object.values(node).some(sets);
    return false;
  };
  return (['perRequest', 'quotas', 'budget'] as const).some((key) => sets(limits[key]));
}

async function findExistingPolicy(
  tenantDbName: string,
  tenantId: string,
  id: string,
): Promise<IQuotaPolicy | null> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const all = await db.listQuotaPolicies(tenantId);
    return all.find((policy) => String(policy._id) === id) ?? null;
  });
}

/**
 * Checks a create (`existing` null) or an update (`existing` is the stored row)
 * against the rules the guard relies on, so a bad policy is refused at the API
 * instead of sitting inert:
 *  - scope, domain and group mode are known values;
 *  - a group policy names a group of THIS tenant, and only a group policy has a mode;
 *  - an agent-narrowed policy (resource scope in the agent domain) names the agent;
 *  - a project, when one is named, is a project of this tenant.
 *
 * Only the new group / agent-run kinds are held to more than "known value", so
 * policies written before them are neither rejected nor reinterpreted.
 */
export async function assertValidQuotaPolicy(
  tenantDbName: string,
  tenantId: string,
  patch: Partial<QuotaPolicyInput>,
  existing: IQuotaPolicy | null,
): Promise<void> {
  const scope = (patch.scope ?? existing?.scope) as QuotaScope | undefined;
  const domain = (patch.domain ?? existing?.domain) as QuotaDomain | undefined;
  const scopeId = patch.scopeId !== undefined ? patch.scopeId : existing?.scopeId;

  if (patch.scope !== undefined && !QUOTA_SCOPES.includes(patch.scope)) {
    throw new QuotaPolicyValidationError(`Unknown scope "${String(patch.scope)}"`, 'invalid_scope');
  }
  if (patch.domain !== undefined && !offeredQuotaDomains().includes(patch.domain)) {
    throw new QuotaPolicyValidationError(`Unknown domain "${String(patch.domain)}"`, 'invalid_domain');
  }

  // IP limits: ranges and a mode, rate limits only.
  if (patch.ipMode !== undefined) {
    if (!QUOTA_IP_MODES.includes(patch.ipMode as QuotaIpMode)) {
      throw new QuotaPolicyValidationError(`ipMode must be one of ${QUOTA_IP_MODES.join(', ')}`, 'invalid_ip_mode');
    }
    if (scope !== 'ip') {
      throw new QuotaPolicyValidationError('ipMode applies to IP-scoped policies only', 'ip_mode_requires_ip_scope');
    }
  }
  if (patch.ipRanges !== undefined && patch.ipRanges !== null && scope !== 'ip') {
    throw new QuotaPolicyValidationError('ipRanges applies to IP-scoped policies only', 'ip_ranges_require_ip_scope');
  }
  if (scope === 'ip') {
    const ranges = validateQuotaIpRanges(patch.ipRanges !== undefined ? patch.ipRanges : existing?.ipRanges);
    if (!ranges.ok) {
      throw new QuotaPolicyValidationError(ranges.message, 'invalid_ip_ranges');
    }
    const limits = patch.limits !== undefined ? patch.limits : existing?.limits;
    if (setsMoreThanRateLimit(limits)) {
      throw new QuotaPolicyValidationError(
        'An IP-scoped policy may only set rate limits (no per-request limits, caps or budget)',
        'ip_limits_rate_only',
      );
    }
  }
  if (patch.groupMode !== undefined) {
    if (!QUOTA_GROUP_MODES.includes(patch.groupMode as QuotaGroupMode)) {
      throw new QuotaPolicyValidationError(
        `groupMode must be one of ${QUOTA_GROUP_MODES.join(', ')}`,
        'invalid_group_mode',
      );
    }
    if (scope !== 'group') {
      throw new QuotaPolicyValidationError('groupMode applies to group-scoped policies only', 'group_mode_requires_group_scope');
    }
  }

  // A project this policy is moved to (or created in) must be one of this tenant's.
  const movedToProjectId = patch.projectId;
  if (typeof movedToProjectId === 'string' && movedToProjectId !== '' && movedToProjectId !== existing?.projectId) {
    await runWithTenantScope(tenantDbName, async (db) => {
      const project = await db.findProjectById(movedToProjectId);
      if (!project || (project.tenantId && String(project.tenantId) !== String(tenantId))) {
        throw new QuotaPolicyValidationError('Project not found', 'project_not_found', 404);
      }
    });
  }

  if (scope === 'group') {
    if (typeof scopeId !== 'string' || scopeId.trim() === '') {
      throw new QuotaPolicyValidationError('A group-scoped policy needs the group in scopeId', 'group_required');
    }
    await runWithTenantScope(tenantDbName, async (db) => {
      const group = await db.findGroupById(scopeId);
      if (!group || (group.tenantId && String(group.tenantId) !== String(tenantId))) {
        throw new QuotaPolicyValidationError('Group not found', 'group_not_found', 404);
      }
    });
  }

  if (domain === 'agent' && scope === 'resource' && (typeof scopeId !== 'string' || scopeId.trim() === '')) {
    throw new QuotaPolicyValidationError('An agent-narrowed policy needs the agent key in scopeId', 'agent_required');
  }

  // A `jobs` limit narrowed to one kind names a kind this install counts.
  if (domain === 'jobs' && scope === 'resource' && typeof scopeId === 'string' && scopeId !== ''
    && !(offeredQuotaJobKinds() as string[]).includes(scopeId)) {
    throw new QuotaPolicyValidationError(`Unknown job kind "${scopeId}"`, 'invalid_job_kind');
  }
}

// ── target resolution (for the Limits table) ─────────────────────────────

export interface QuotaPolicyTarget {
  type: 'tenant' | 'group' | 'user' | 'token' | 'agent' | 'resource' | 'provider' | 'ip';
  id?: string;
  /** Human name of the target; absent for `tenant`, and the raw id when the target no longer exists. */
  label?: string;
  sublabel?: string;
  /** The target was deleted (or never existed): the policy matches nobody. */
  missing?: boolean;
}

export interface QuotaPolicyView extends QuotaPolicy {
  target: QuotaPolicyTarget;
  projectName?: string;
  projectKey?: string;
}

const RESOLVE_CONCURRENCY = 8;

async function loadReferencedTokens(
  db: Awaited<ReturnType<typeof getDatabase>>,
  tenantId: string,
  ids: readonly string[],
): Promise<Array<{ _id?: unknown; label?: string }>> {
  const out: Array<{ _id?: unknown; label?: string }> = [];
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const page = await db.iamListTokens({ tenantId, ids: ids.slice(i, i + 200), limit: 200 });
      out.push(...page.items);
    }
  } catch {
    /* names are decoration: the table still shows the ids */
  }
  return out;
}

async function mapBounded<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += RESOLVE_CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + RESOLVE_CONCURRENCY).map(fn))));
  }
  return out;
}

/**
 * Names the user / group / token / agent each policy points at, and the project
 * it lives in. Resolves only the ids the given policies reference (never lists
 * the tenant's users: there can be tens of thousands), so the cost follows the
 * number of policies.
 */
export async function describeQuotaPolicies(
  tenantDbName: string,
  tenantId: string,
  policies: readonly QuotaPolicy[],
): Promise<QuotaPolicyView[]> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const userIds = [...new Set(policies.filter((p) => p.scope === 'user' && p.scopeId).map((p) => String(p.scopeId)))];
    const groupIds = [...new Set(policies.filter((p) => p.scope === 'group' && p.scopeId).map((p) => String(p.scopeId)))];
    const tokenIds = [...new Set(policies.filter((p) => p.scope === 'token' && p.scopeId).map((p) => String(p.scopeId)))];
    const needsProjects = policies.some((p) => p.projectId);

    // A policy's scopeId is text the creator typed. Where one physical database serves
    // every tenant a lookup by id finds any tenant's row, so a row of another tenant is
    // treated as not found: its name and e-mail must never reach this answer.
    const own = <T extends { tenantId?: unknown }>(row: T | null): T | null =>
      row && (!row.tenantId || String(row.tenantId) === String(tenantId)) ? row : null;

    const [users, groups, tokens, projects] = await Promise.all([
      mapBounded(userIds, async (id) => [id, own(await db.findUserById(id).catch(() => null))] as const),
      mapBounded(groupIds, async (id) => [id, own(await db.findGroupById(id).catch(() => null))] as const),
      // Only the referenced tokens (a tenant can hold thousands), filtered by tenant in the query itself.
      tokenIds.length > 0 ? loadReferencedTokens(db, tenantId, tokenIds) : Promise.resolve([]),
      needsProjects ? db.listProjects(tenantId).catch(() => []) : Promise.resolve([]),
    ]);

    const userById = new Map(users);
    const groupById = new Map(groups);
    const tokenById = new Map(tokens.map((token) => [String(token._id), token]));
    const projectById = new Map(projects.map((project) => [String(project._id), project]));

    // Agents are addressed by key (+ the policy's project), so they are looked up per policy.
    const agentPolicies = policies.filter((p) => p.domain === 'agent' && p.scope === 'resource' && p.scopeId);
    const agents = await mapBounded(agentPolicies, async (p) => {
      const agent = await db.findAgentByKey(String(p.scopeId), p.projectId || undefined).catch(() => null);
      return [String(p._id), agent] as const;
    });
    const agentByPolicy = new Map(agents);

    return policies.map((policy): QuotaPolicyView => {
      const id = policy.scopeId ? String(policy.scopeId) : undefined;
      let target: QuotaPolicyTarget;
      switch (policy.scope) {
        case 'user': {
          const user = id ? userById.get(id) : undefined;
          target = user
            ? { type: 'user', id, label: user.name || user.email || id, sublabel: user.email }
            : { type: 'user', id, label: id, missing: true };
          break;
        }
        case 'group': {
          const group = id ? groupById.get(id) : undefined;
          target = group
            ? { type: 'group', id, label: group.name, ...(group.description ? { sublabel: group.description } : {}) }
            : { type: 'group', id, label: id, missing: true };
          break;
        }
        case 'token': {
          const token = id ? tokenById.get(id) : undefined;
          target = token
            ? { type: 'token', id, label: token.label || id }
            : { type: 'token', id, label: id, missing: true };
          break;
        }
        case 'resource': {
          if (policy.domain === 'agent') {
            const agent = agentByPolicy.get(String(policy._id));
            target = agent
              ? { type: 'agent', id, label: agent.name || agent.key, sublabel: agent.key }
              : { type: 'agent', id, label: id, missing: true };
          } else {
            target = { type: 'resource', id, label: id };
          }
          break;
        }
        case 'provider':
          target = { type: 'provider', id, label: id };
          break;
        case 'ip': {
          const ranges = Array.isArray(policy.ipRanges) ? policy.ipRanges : [];
          target = {
            type: 'ip',
            label: ranges.length > 1 ? `${ranges[0]} +${ranges.length - 1}` : ranges[0] ?? '',
            sublabel: ranges.join(', '),
          };
          break;
        }
        default:
          target = { type: 'tenant' };
      }

      const project = policy.projectId ? projectById.get(String(policy.projectId)) : undefined;
      return {
        ...policy,
        target,
        ...(project ? { projectName: project.name, projectKey: project.key } : {}),
      };
    });
  });
}

// ── writes ───────────────────────────────────────────────────────────────

export async function createQuotaPolicy(
  tenantDbName: string,
  tenantId: string,
  payload: QuotaPolicyInput,
): Promise<QuotaPolicy> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const now = new Date();
    const policy = await db.createQuotaPolicy({
      ...payload,
      tenantId,
      createdAt: now,
      updatedAt: now,
    });

    await invalidatePolicyCache(tenantDbName, tenantId, payload.projectId);

    return normalizePolicy(policy);
  });
}

export async function updateQuotaPolicy(
  tenantDbName: string,
  tenantId: string,
  id: string,
  payload: Partial<QuotaPolicyInput>,
  projectId?: string,
): Promise<QuotaPolicy | null> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const updated = await db.updateQuotaPolicy(id, tenantId, {
      ...payload,
      updatedAt: new Date(),
    }, projectId);

    // The policy's own project too: an edit may move it, and a tenant-wide
    // policy (no project anywhere) must reach every project's cache.
    await invalidatePolicyCache(tenantDbName, tenantId, projectId, payload.projectId, updated?.projectId);

    return updated ? normalizePolicy(updated) : null;
  });
}

export async function deleteQuotaPolicy(
  tenantDbName: string,
  tenantId: string,
  id: string,
  projectId?: string,
): Promise<boolean> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const deleted = await db.deleteQuotaPolicy(id, tenantId, projectId);

    await invalidatePolicyCache(tenantDbName, tenantId, projectId);

    return deleted;
  });
}

/** The stored policy a request refers to, for the validation of a partial update. */
export async function getQuotaPolicyRow(
  tenantDbName: string,
  tenantId: string,
  id: string,
): Promise<IQuotaPolicy | null> {
  return findExistingPolicy(tenantDbName, tenantId, id);
}
