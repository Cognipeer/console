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
import { createEdgeCollector, type EdgeCollector } from '../references';
import type { ResourceEdgeInput, ResourceRecord, ResourceTypeDefinition } from '../types';

type Doc = Record<string, any>;

const asArray = (value: unknown): Doc[] =>
  Array.isArray(value) ? value.filter((v): v is Doc => !!v && typeof v === 'object') : [];

/**
 * Guardrail keys the way `resolveBindings` reads them: a present `guardrails`
 * array is AUTHORITATIVE and the deprecated single slots are ignored (merging
 * them would resurrect a binding the operator moved out of the array). A
 * binding with an explicitly empty `hooks` list is parked, bound to nothing.
 */
function addGuardrailEdges(edges: EdgeCollector, kind: string, source: Doc, base: string): void {
  if (Array.isArray(source.guardrails)) {
    asArray(source.guardrails).forEach((binding, i) => {
      if (Array.isArray(binding.hooks) && binding.hooks.length === 0) return;
      edges.add(kind, binding.key, `${base}guardrails[${i}].key`);
    });
    return;
  }
  edges.add(kind, source.inputGuardrailKey, `${base}inputGuardrailKey`);
  edges.add(kind, source.outputGuardrailKey, `${base}outputGuardrailKey`);
}

/** tool / mcp bindings of an agent (or of an inline sub-agent). `system` bindings are handled by the caller. */
function addBindingEdges(
  edges: EdgeCollector,
  bindings: unknown,
  kinds: { tool: string; mcp: string },
  base: string,
): void {
  asArray(bindings).forEach((binding, i) => {
    if (binding.source === 'tool') edges.add(kinds.tool, binding.sourceKey, `${base}toolBindings[${i}].sourceKey`);
    else if (binding.source === 'mcp') edges.add(kinds.mcp, binding.sourceKey, `${base}toolBindings[${i}].sourceKey`);
  });
}

/**
 * Outgoing references of an agent: keys only, read exactly where the runtime
 * reads them (see the reference map in references.ts for the resolution rules).
 *
 * KNOWN LIMIT: edges come from the DRAFT config (`a.config`), while client-API
 * runs execute the PUBLISHED version snapshot (resolveAgentConfig). Reading the
 * snapshot would cost one version read per agent on every snapshot build, so the
 * page reports the draft; `publishedVersion`/`latestVersion` stay in the
 * attributes so an unpublished edit is visible next to the references.
 */
export function extractAgentEdges(a: Doc): ResourceEdgeInput[] | undefined {
  const config = (a.config ?? {}) as Doc;
  const edges = createEdgeCollector('agent');

  edges.add('agent.model', config.modelKey, 'config.modelKey');
  // agentService only looks the prompt up when there is no inline system prompt.
  if (!config.systemPrompt) edges.add('agent.prompt', config.promptKey, 'config.promptKey');
  edges.add('agent.knowledge', config.knowledgeEngineKey, 'config.knowledgeEngineKey');
  addGuardrailEdges(edges, 'agent.guardrail', config, 'config.');
  addBindingEdges(edges, config.toolBindings, { tool: 'agent.tool', mcp: 'agent.mcp' }, 'config.');
  asArray(config.toolBindings).forEach((binding, i) => {
    if (binding.source !== 'system') return;
    const c = (binding.config ?? {}) as Doc;
    if (binding.sourceKey === 'browser_use') {
      edges.add('agent.browser', c.browserId, `config.toolBindings[${i}].config.browserId`);
    } else if (binding.sourceKey === 'web_search') {
      edges.add('agent.webSearchProvider', c.providerKey, `config.toolBindings[${i}].config.providerKey`);
    }
  });

  // Session files are off unless `attachments.enabled === true` AND a bucket is named (there is no built-in fallback storage).
  const attachments = config.attachments as Doc | undefined;
  if (attachments && attachments.enabled === true) edges.add('agent.attachmentsBucket', attachments.bucketKey, 'config.attachments.bucketKey');

  // Enterprise target: dropped without the enterprise build (graph.knownTypes).
  // Unlike memory, the sandbox is OFF unless enabled === true: buildAgentSandboxTools
  // returns no tools for a missing flag, so a legacy/imported config never uses its template.
  const sandbox = config.sandbox as Doc | undefined;
  if (sandbox && sandbox.enabled === true) edges.add('agent.sandboxTemplate', sandbox.templateKey, 'config.sandbox.templateKey');

  const memory = config.memory as Doc | undefined;
  if (memory && memory.enabled !== false) edges.add('agent.memory', memory.memoryStoreKey, 'config.memory.memoryStoreKey');

  if (Array.isArray(config.skills)) {
    config.skills.forEach((key: unknown, i: number) => edges.add('agent.skill', key, `config.skills[${i}]`));
  }

  asArray(config.subagents).forEach((sub, i) => {
    if (sub.enabled === false) return;
    const base = `config.subagents[${i}].`;
    if (sub.kind === 'ref') {
      // A ref sub-agent inherits tools/knowledge from the TARGET agent's own
      // config, which is that agent's edges, not this one's.
      edges.add('agent.subagent', sub.agentKey, `${base}agentKey`);
      // buildAgentSubagents honours the entry's own modelKey over the target's.
      edges.add('agent.subagentModel', sub.modelKey, `${base}modelKey`);
      return;
    }
    edges.add('agent.subagentModel', sub.modelKey, `${base}modelKey`);
    edges.add('agent.subagentKnowledge', sub.knowledgeEngineKey, `${base}knowledgeEngineKey`);
    addBindingEdges(edges, sub.toolBindings, { tool: 'agent.subagentTool', mcp: 'agent.subagentMcp' }, base);
  });

  return edges.done();
}

/** The reserved provider key of a Dynamic LLM model (modelService DYNAMIC_PROVIDER_KEY): there is no provider row. */
const DYNAMIC_PROVIDER_KEY = 'dynamic';

function addDynamicTargetEdges(edges: EdgeCollector, target: unknown, base: string): void {
  const t = (target ?? {}) as Doc;
  edges.add('model.dynamicModel', t.modelKey, `${base}.modelKey`);
  asArray(t.pool).forEach((candidate, i) => edges.add('model.dynamicModel', candidate.modelKey, `${base}.pool[${i}].modelKey`));
}

/** Outgoing references of a model (provider, replicas, guardrails, semantic cache, Dynamic LLM routing). */
export function extractModelEdges(m: Doc): ResourceEdgeInput[] | undefined {
  const settings = (m.settings ?? {}) as Doc;
  const dynamic = settings.dynamic as Doc | undefined;
  const isDynamic = !!dynamic || m.providerKey === DYNAMIC_PROVIDER_KEY;
  const edges = createEdgeCollector('model');

  // Chat calls go through the replica pool, which only falls back to
  // `providerKey` when no enabled replica names a provider; other categories use it directly.
  const poolsChat = m.category === 'llm';
  const hasEnabledReplica = asArray(m.replicas).some((r) => r.enabled !== false && typeof r.providerKey === 'string' && r.providerKey);
  if (!isDynamic && !(poolsChat && hasEnabledReplica)) edges.add('model.provider', m.providerKey, 'providerKey');
  asArray(m.replicas).forEach((replica, i) => {
    // The pool drops disabled replicas before it ever resolves them.
    if (replica.enabled === false) return;
    edges.add('model.replicaProvider', replica.providerKey, `replicas[${i}].providerKey`);
  });
  addGuardrailEdges(edges, 'model.guardrail', m, '');

  const cache = m.semanticCache as Doc | undefined;
  if (cache && cache.enabled === true) {
    edges.add('model.semanticCacheModel', cache.embeddingModelKey, 'semanticCache.embeddingModelKey');
    edges.add('model.semanticCacheIndex', cache.vectorIndexKey, 'semanticCache.vectorIndexKey', {
      qualifier: cache.vectorProviderKey,
    });
  }

  if (dynamic) {
    const base = 'settings.dynamic';
    edges.add('model.dynamicModel', dynamic.defaultModelKey, `${base}.defaultModelKey`);
    edges.add('model.dynamicModel', dynamic.fallbackModelKey, `${base}.fallbackModelKey`);
    edges.add('model.dynamicModel', dynamic.baselineModelKey, `${base}.baselineModelKey`);
    addDynamicTargetEdges(edges, dynamic.defaultTarget, `${base}.defaultTarget`);
    asArray(dynamic.rules).forEach((rule, i) => {
      edges.add('model.dynamicModel', rule.targetModelKey, `${base}.rules[${i}].targetModelKey`);
      addDynamicTargetEdges(edges, rule.target, `${base}.rules[${i}].target`);
    });
    const decider = dynamic.decider as Doc | undefined;
    if (decider) {
      edges.add('model.dynamicModel', decider.modelKey, `${base}.decider.modelKey`);
      asArray(decider.labels).forEach((label, i) => {
        edges.add('model.dynamicModel', label.targetModelKey, `${base}.decider.labels[${i}].targetModelKey`);
        addDynamicTargetEdges(edges, label.target, `${base}.decider.labels[${i}].target`);
      });
    }
    edges.add('model.dynamicModel', (dynamic.guards as Doc | undefined)?.economyModelKey, `${base}.guards.economyModelKey`);
  }

  return edges.done();
}

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
    edges: extractAgentEdges(a),
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
    edges: extractModelEdges(m),
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
