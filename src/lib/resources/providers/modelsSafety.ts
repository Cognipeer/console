/**
 * Models & safety resource types: provider, inference-server, guardrail,
 * guardrail-word-list, pii-policy.
 *
 * Same pattern as ./core.ts: contract list call with NO project filter, explicit
 * WHITELIST mapping, helpers from ../mapping.
 *
 * Backend semantics relied on (mongodb/*.mixin.ts and sqlite/*.mixin.ts agree):
 *   - listProviders(tenantId):   filter only when projectId is truthy -> whole tenant
 *   - listInferenceServers(tid): tenant-level only, no projectId field at all
 *   - listGuardrails():          filter only when projectId !== undefined
 *   - listGuardrailWordLists():  same
 *   - listPiiPolicies():         same
 */
import {
  buildAttributes,
  normalizeProjectId,
  statusFromEnabled,
  str,
  toIso,
  toneForStatus,
} from '../mapping';
import type { ResourceRecord, ResourceTypeDefinition } from '../types';

type Doc = Record<string, any>;

/**
 * Shared skeleton for every group file that owns Mongo/SQLite documents with the
 * usual audit columns. Callers add `type`, `name`, status and a whitelisted
 * attribute list; nothing is copied from the document implicitly.
 */
export function baseRecord(
  type: string,
  d: Doc,
  extra: Pick<ResourceRecord, 'name' | 'status' | 'attributes'> & Partial<ResourceRecord>,
): ResourceRecord {
  return {
    type,
    id: String(d._id ?? d.id),
    key: str(d.key),
    description: str(d.description),
    projectId: normalizeProjectId(d.projectId),
    statusTone: toneForStatus(extra.status),
    createdBy: str(d.createdBy),
    updatedBy: str(d.updatedBy),
    createdAt: toIso(d.createdAt),
    updatedAt: toIso(d.updatedAt),
    tenantId: str(d.tenantId),
    ...extra,
  };
}

/**
 * Provider (credential) rows are the most secret-heavy resource. Only
 * key/label/description/type/driver/status and the project assignment survive:
 * `credentialsEnc`, `settings`, `metadata` and `capabilitiesOverride` are never
 * read.
 */
export function mapProvider(p: Doc): ResourceRecord {
  const projectIds = Array.isArray(p.projectIds)
    ? p.projectIds.map((x: unknown) => normalizeProjectId(x)).filter((x: string | null): x is string => !!x)
    : [];
  // A provider can be assigned to several projects: `projectId` is the primary
  // one (legacy single field wins) and `projectIds` lets the project filter and
  // facets match every assignment.
  const projectId = normalizeProjectId(p.projectId) ?? projectIds[0] ?? null;
  const status = str(p.status);
  return baseRecord('provider', p, {
    name: str(p.label) ?? str(p.key) ?? String(p._id ?? p.id),
    status,
    projectId,
    ...(projectIds.length > 1 || (projectId && projectIds.length > 0)
      ? { projectIds: [...new Set([...(projectId ? [projectId] : []), ...projectIds])] }
      : {}),
    attributes: buildAttributes({
      type: str(p.type),
      driver: str(p.driver),
      assignedProjectCount: projectIds.length > 1 ? projectIds.length : undefined,
    }),
  });
}

/** apiKey / apiKeySealed / baseUrl / lastError / metadata are never surfaced. */
export function mapInferenceServer(s: Doc): ResourceRecord {
  const status = str(s.status);
  return baseRecord('inference-server', s, {
    name: str(s.name) ?? String(s._id ?? s.id),
    status,
    // No projectId column: inherently tenant-wide.
    projectId: null,
    attributes: buildAttributes({
      type: str(s.type),
      pollIntervalSeconds: typeof s.pollIntervalSeconds === 'number' ? s.pollIntervalSeconds : undefined,
    }),
  });
}

/** customPrompt, policy, hooks and metadata are config bodies: not surfaced. */
export function mapGuardrail(g: Doc): ResourceRecord {
  return baseRecord('guardrail', g, {
    name: str(g.name) ?? String(g._id ?? g.id),
    status: statusFromEnabled(g.enabled),
    attributes: buildAttributes({
      type: str(g.type),
      target: str(g.target),
      action: str(g.action),
      mode: str(g.mode),
      failMode: str(g.failMode),
      modelKey: str(g.modelKey),
    }),
  });
}

/** The words themselves are never surfaced, only their count. */
export function mapGuardrailWordList(w: Doc): ResourceRecord {
  return baseRecord('guardrail-word-list', w, {
    name: str(w.name) ?? String(w._id ?? w.id),
    status: null,
    attributes: buildAttributes({
      language: str(w.language),
      wordCount: Array.isArray(w.words) ? w.words.length : undefined,
    }),
  });
}

/** categories / customPatterns / detection / metadata are not surfaced. */
export function mapPiiPolicy(p: Doc): ResourceRecord {
  return baseRecord('pii-policy', p, {
    name: str(p.name) ?? String(p._id ?? p.id),
    status: statusFromEnabled(p.enabled),
    attributes: buildAttributes({
      engine: str(p.engine),
      defaultAction: str(p.defaultAction),
      languages: Array.isArray(p.languages) ? p.languages.filter((l: unknown) => typeof l === 'string').join(', ') : undefined,
      customPatternCount: Array.isArray(p.customPatterns) ? p.customPatterns.length : undefined,
    }),
  });
}

export const modelsSafetyResourceTypes: ResourceTypeDefinition[] = [
  {
    type: 'provider',
    service: 'providers',
    category: 'models',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db, tenantId }) => (await db.listProviders(tenantId)).map((p) => mapProvider(p as never)),
    detailUrl: (r) => `/dashboard/providers/${encodeURIComponent(r.id)}`,
  },
  {
    type: 'inference-server',
    service: 'inference-monitoring',
    category: 'models',
    scope: 'tenant',
    edition: 'community',
    list: async ({ db, tenantId }) => (await db.listInferenceServers(tenantId)).map((s) => mapInferenceServer(s as never)),
    // The page is keyed by server key, not id.
    detailUrl: (r) => (r.key ? `/dashboard/inference-monitoring/${encodeURIComponent(r.key)}` : null),
  },
  {
    type: 'guardrail',
    service: 'guardrails',
    category: 'safety',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db }) => (await db.listGuardrails()).map((g) => mapGuardrail(g as never)),
    detailUrl: (r) => `/dashboard/guardrails/${encodeURIComponent(r.id)}`,
  },
  {
    type: 'guardrail-word-list',
    service: 'guardrails',
    category: 'safety',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db }) => (await db.listGuardrailWordLists()).map((w) => mapGuardrailWordList(w as never)),
    // Managed inside the guardrails page; no page of its own.
    detailUrl: () => null,
  },
  {
    type: 'pii-policy',
    service: 'pii',
    category: 'safety',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db }) => (await db.listPiiPolicies()).map((p) => mapPiiPolicy(p as never)),
    detailUrl: (r) => `/dashboard/pii/${encodeURIComponent(r.id)}`,
  },
];
