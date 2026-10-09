/**
 * Core resource types: agent, tool, model.
 *
 * These three are the reference pattern for every provider group:
 *   1. call the DatabaseProvider contract list method with NO project filter so
 *      it returns the whole tenant (verified per backend, see notes below);
 *   2. map through an explicit WHITELIST into a ResourceRecord — never spread the
 *      document (agent `config`, tool `upstreamAuth`/`openApiSpec`, model
 *      `settings`/`replicas` all carry or can carry secrets);
 *   3. normalise projectId (null/''/missing -> null) and dates (-> ISO).
 *
 * Backend semantics relied on (mongodb/*.mixin.ts and sqlite/*.mixin.ts agree):
 *   - listAgents():  filter added only when projectId !== undefined
 *   - listTools():   filter added only when projectId is truthy; tenant-wide
 *                    tools (no projectId) are included
 *   - listModels():  filter added only when projectId is truthy
 */
import {
  buildAttributes,
  normalizeProjectId,
  str,
  toIso,
  toneForStatus,
} from '../mapping';
import type { ResourceRecord, ResourceTypeDefinition } from '../types';

export function mapAgent(a: Record<string, any>): ResourceRecord {
  const config = (a.config ?? {}) as Record<string, any>;
  const status = str(a.status);
  return {
    type: 'agent',
    id: String(a._id),
    key: str(a.key),
    name: str(a.name) ?? String(a._id),
    description: str(a.description),
    projectId: normalizeProjectId(a.projectId),
    status,
    statusTone: toneForStatus(status),
    createdBy: str(a.createdBy),
    updatedBy: str(a.updatedBy),
    createdAt: toIso(a.createdAt),
    updatedAt: toIso(a.updatedAt),
    tenantId: str(a.tenantId),
    attributes: buildAttributes({
      kind: str(config.kind) ?? 'native',
      modelKey: config.modelKey,
      publishedVersion: typeof a.publishedVersion === 'number' ? a.publishedVersion : undefined,
      latestVersion: typeof a.latestVersion === 'number' ? a.latestVersion : undefined,
      toolBindingCount: Array.isArray(config.toolBindings) ? config.toolBindings.length : undefined,
    }),
  };
}

export function mapTool(t: Record<string, any>): ResourceRecord {
  const status = str(t.status);
  return {
    type: 'tool',
    id: String(t._id),
    key: str(t.key),
    name: str(t.name) ?? String(t._id),
    description: str(t.description),
    projectId: normalizeProjectId(t.projectId),
    status,
    statusTone: toneForStatus(status),
    createdBy: str(t.createdBy),
    updatedBy: str(t.updatedBy),
    createdAt: toIso(t.createdAt),
    updatedAt: toIso(t.updatedAt),
    tenantId: str(t.tenantId),
    // upstreamAuth, openApiSpec, mcpEndpoint (may carry a token in the URL),
    // upstreamBaseUrl and metadata are deliberately NOT surfaced.
    attributes: buildAttributes({
      type: str(t.type),
      actionCount: Array.isArray(t.actions) ? t.actions.length : undefined,
      mcpTransport: t.type === 'mcp' ? str(t.mcpTransport) : undefined,
    }),
  };
}

export function mapModel(m: Record<string, any>): ResourceRecord {
  const settings = (m.settings ?? {}) as Record<string, unknown>;
  return {
    type: 'model',
    id: String(m._id),
    key: str(m.key),
    name: str(m.name) ?? String(m._id),
    description: str(m.description),
    projectId: normalizeProjectId(m.projectId),
    // Models have no lifecycle status.
    status: null,
    statusTone: 'neutral',
    createdBy: str(m.createdBy),
    updatedBy: str(m.updatedBy),
    createdAt: toIso(m.createdAt),
    updatedAt: toIso(m.updatedAt),
    tenantId: str(m.tenantId),
    // `settings`, `metadata` and `replicas` can embed endpoints/credentials: only
    // their presence/size is reported.
    attributes: buildAttributes({
      category: str(m.category),
      providerKey: str(m.providerKey),
      providerDriver: str(m.providerDriver),
      modelId: str(m.modelId),
      isMultimodal: typeof m.isMultimodal === 'boolean' ? m.isMultimodal : undefined,
      supportsToolCalls: typeof m.supportsToolCalls === 'boolean' ? m.supportsToolCalls : undefined,
      dynamic: settings.dynamic ? true : undefined,
      replicaCount: Array.isArray(m.replicas) && m.replicas.length > 0 ? m.replicas.length : undefined,
    }),
  };
}

export const coreResourceTypes: ResourceTypeDefinition[] = [
  {
    type: 'agent',
    service: 'agents',
    category: 'agents',
    scope: 'project',
    edition: 'community',
    list: async ({ db }) => (await db.listAgents()).map((a) => mapAgent(a as never)),
    detailUrl: (r) => `/dashboard/agents/${encodeURIComponent(r.id)}`,
  },
  {
    type: 'tool',
    service: 'tools',
    category: 'agents',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db }) => (await db.listTools()).map((t) => mapTool(t as never)),
    detailUrl: (r) => `/dashboard/agents/tools/${encodeURIComponent(r.id)}`,
  },
  {
    type: 'model',
    service: 'models',
    category: 'models',
    scope: 'project',
    edition: 'community',
    list: async ({ db }) => (await db.listModels()).map((m) => mapModel(m as never)),
    detailUrl: (r) => `/dashboard/models/${encodeURIComponent(r.id)}`,
  },
];
