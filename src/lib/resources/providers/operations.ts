/**
 * Operations resource types: alert-rule, config-group.
 *
 * Backend semantics relied on:
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
];
