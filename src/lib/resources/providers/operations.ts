/**
 * Operations resource types: alert-rule, config-group, quota-policy.
 *
 * Backend semantics relied on:
 *   - listQuotaPolicies(tenantId): projectId filter only when given -> whole tenant
 *   - listAlertRules(tenantId): projectId filter only when !== undefined -> whole tenant
 *     (rules always carry a projectId; there are no tenant-wide rules)
 *   - listConfigGroups():       projectId filter only when truthy -> whole tenant
 */
import { buildAttributes, statusFromEnabled, str } from '../mapping';
import { createEdgeCollector } from '../references';
import type { ResourceRecord, ResourceTypeDefinition } from '../types';
import { baseRecord } from './modelsSafety';

type Doc = Record<string, any>;

/** channels (recipient emails / webhook targets) and the condition body are not surfaced. */
export function mapAlertRule(r: Doc): ResourceRecord {
  const scope = (r.scope ?? {}) as Record<string, unknown>;
  const e = createEdgeCollector('alert-rule');
  e.add('alert.model', scope.modelKey, 'scope.modelKey');
  e.add('alert.guardrail', scope.guardrailKey, 'scope.guardrailKey');
  e.add('alert.ragModule', scope.ragModuleKey, 'scope.ragModuleKey');
  e.add('alert.mcpServer', scope.mcpServerKey, 'scope.mcpServerKey');
  e.add('alert.inferenceServer', scope.serverKey, 'scope.serverKey');
  return baseRecord('alert-rule', r, {
    edges: e.done(),
    name: str(r.name) ?? String(r._id ?? r.id),
    // Rules have no key; identified by id only.
    key: null,
    status: statusFromEnabled(r.enabled),
    attributes: buildAttributes({
      module: str(r.module),
      metric: str(r.metric),
      windowMinutes: typeof r.windowMinutes === 'number' ? r.windowMinutes : undefined,
      cooldownMinutes: typeof r.cooldownMinutes === 'number' ? r.cooldownMinutes : undefined,
      channelCount: Array.isArray(r.channels) ? r.channels.length : undefined,
      modelKey: str(scope.modelKey),
      serverKey: str(scope.serverKey),
      guardrailKey: str(scope.guardrailKey),
      ragModuleKey: str(scope.ragModuleKey),
      mcpServerKey: str(scope.mcpServerKey),
    }),
  });
}

/** Items (which can hold secret values) are never read: groups only. */
export function mapConfigGroup(g: Doc): ResourceRecord {
  return baseRecord('config-group', g, {
    name: str(g.name) ?? String(g._id ?? g.id),
    status: null,
    attributes: buildAttributes({
      tags: Array.isArray(g.tags) ? g.tags.filter((t: unknown) => typeof t === 'string').join(', ') : undefined,
    }),
  });
}

/**
 * A configured limit (rate / per-request / resource caps / budget). The numbers
 * themselves are not surfaced, only which families the policy sets. `scopeId`
 * is the id of the user / token / resource / provider the policy targets.
 */
export function mapQuotaPolicy(p: Doc): ResourceRecord {
  const limits = (p.limits && typeof p.limits === 'object' ? p.limits : {}) as Doc;
  const label = str(p.label);
  return baseRecord('quota-policy', p, {
    // Policies have no key; identified by id only.
    key: null,
    name: label ?? ([str(p.domain), str(p.scope)].filter(Boolean).join(' · ') || String(p._id ?? p.id)),
    status: statusFromEnabled(p.enabled),
    attributes: buildAttributes({
      scope: str(p.scope),
      scopeId: str(p.scopeId),
      domain: str(p.domain),
      priority: typeof p.priority === 'number' ? p.priority : undefined,
      hasRateLimit: limits.rateLimit ? true : undefined,
      hasPerRequestLimits: limits.perRequest ? true : undefined,
      hasResourceCaps: limits.quotas ? true : undefined,
      hasBudget: limits.budget ? true : undefined,
    }),
  });
}

export const operationsResourceTypes: ResourceTypeDefinition[] = [
  {
    type: 'alert-rule',
    service: 'alerts',
    category: 'operations',
    scope: 'project',
    edition: 'community',
    list: async ({ db, tenantId }) => (await db.listAlertRules(tenantId)).map((r) => mapAlertRule(r as never)),
    // Rules live in a tab of /dashboard/alerts; no page per rule.
    detailUrl: () => null,
  },
  {
    type: 'config-group',
    service: 'config',
    category: 'operations',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db }) => (await db.listConfigGroups()).map((g) => mapConfigGroup(g as never)),
    detailUrl: (r) => `/dashboard/config/${encodeURIComponent(r.id)}`,
  },
  {
    type: 'quota-policy',
    // /api/quota is gated as 'projects' in rbac.ts.
    service: 'projects',
    category: 'operations',
    // The API stamps the active project when given one; a policy without it
    // applies tenant-wide.
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db, tenantId }) => (await db.listQuotaPolicies(tenantId)).map((p) => mapQuotaPolicy(p as never)),
    // Policies are edited in the project's Quotas section; a tenant-wide one has no page.
    detailUrl: (r) => (r.projectId ? `/dashboard/projects/${encodeURIComponent(r.projectId)}` : null),
  },
];
