/**
 * Resource references ("uses" / "used by").
 *
 * Providers attach OUTGOING edges (`ResourceRecord.edges`) while they map the raw
 * documents; this file owns
 *   1. the edge kind registry — one entry per reference the product really has,
 *      with the scope rule and failure severity taken from the runtime (see the
 *      WHY comments), so extractor code only says "this field references that key";
 *   2. `createEdgeCollector` — the helper every extractor uses (skips empty
 *      values, dedupes, fills toType/by from the registry);
 *   3. the pure resolution of an edge against the tenant snapshot.
 *
 * Nothing here touches the database and nothing is persisted: edges carry only
 * type/key/id/field, never a secret.
 */
import { buildCrn } from './crn';
import { computeProjectDisplay } from './projectDisplay';
import type {
  HealthSeverity,
  ResourceEdgeInput,
  ResourceEdgeStatus,
  ResourceEdgeView,
  ResourceRecord,
  ResourceRefView,
  ResourceScope,
} from './types';

/**
 * How the runtime narrows the candidates that share a key:
 *  - 'strict-project'      the referrer's own project only (tenant-wide referrer: tenant-wide only)
 *  - 'project-then-tenant' own project first, else the tenant-wide row, never another project (bindingResolution.ts)
 *  - 'provider-assignment' the provider must be assigned to the referrer's project (projectId or projectIds)
 *  - 'same-project-id'     by id, and in the same project (MCP composite members)
 *  - 'tenant'              any row of the tenant
 */
export type EdgeScopeRule =
  | 'strict-project'
  | 'project-then-tenant'
  | 'provider-assignment'
  | 'same-project-id'
  | 'tenant';

export interface EdgeKindDefinition {
  kind: string;
  fromType: string;
  toType: string;
  scope: EdgeScopeRule;
  /** 'error' = the referrer fails or silently loses a safety control; 'warning' = it runs with reduced capability. */
  severity: HealthSeverity;
  /** The runtime skips / fails on a target whose status tone is 'off' (disabled, inactive, draft). */
  inactiveBreaks: boolean;
  /** How `target` addresses the row. */
  by: 'key' | 'id';
  /** by 'id' only: when no row has that id, the value may also be a key (the runtime accepts both). */
  alsoByKey?: boolean;
  /**
   * Composite targets: the qualifier (e.g. the vector provider key) must equal
   * this attribute of the candidate. Defaults to `providerKey`.
   */
  qualifierAttribute?: string;
  /**
   * The referrer can be tenant-wide, and then the runtime resolves the key in
   * the CALLER's project, which a static scan cannot know. Such a referrer is
   * ok as soon as the key exists anywhere (never 'cross-project'/'ambiguous').
   */
  callerScoped?: boolean;
  /**
   * The runtime refuses any target whose status is not exactly 'active' (e.g.
   * a memory store in 'error', a provider 'errored'), which is wider than the
   * 'off' tone covered by `inactiveBreaks`. Rows without a status are not judged.
   */
  requiresActive?: boolean;
  /** The runtime also requires this attribute of the target to equal `value` (when the target reports it). */
  targetAttribute?: { key: string; value: string };
}

export interface KindOptions {
  inactiveBreaks?: boolean;
  by?: 'key' | 'id';
  alsoByKey?: boolean;
  qualifierAttribute?: string;
  callerScoped?: boolean;
  requiresActive?: boolean;
  targetAttribute?: { key: string; value: string };
}

/**
 * Builds one edge kind definition. Exported so enterprise contributions (the
 * overlay) declare their kinds with the same defaults as the community ones.
 */
export function defineEdgeKind(
  name: string,
  fromType: string,
  toType: string,
  scope: EdgeScopeRule,
  severity: HealthSeverity,
  options: KindOptions = {},
): EdgeKindDefinition {
  return {
    kind: name,
    fromType,
    toType,
    scope,
    severity,
    inactiveBreaks: options.inactiveBreaks ?? false,
    by: options.by ?? 'key',
    ...(options.alsoByKey ? { alsoByKey: true } : {}),
    ...(options.qualifierAttribute ? { qualifierAttribute: options.qualifierAttribute } : {}),
    ...(options.callerScoped ? { callerScoped: true } : {}),
    ...(options.requiresActive ? { requiresActive: true } : {}),
    ...(options.targetAttribute ? { targetAttribute: options.targetAttribute } : {}),
  };
}

const defs: EdgeKindDefinition[] = [];

function kind(
  name: string,
  fromType: string,
  toType: string,
  scope: EdgeScopeRule,
  severity: HealthSeverity,
  options: KindOptions = {},
): void {
  defs.push(defineEdgeKind(name, fromType, toType, scope, severity, options));
}

// ── agent ────────────────────────────────────────────────────────────────────
// Keys are unique per PROJECT only, so a key-only lookup could answer with
// another project's row; every agent binding resolves own project first and may
// fall back only to the tenant-wide row (bindingResolution.ts). Models, prompts,
// memory stores and skills have no tenant-wide fallback at all.
kind('agent.model', 'agent', 'model', 'strict-project', 'error');
// A model the agent offers next to its main one (config.additionalModels): a run asked to use it fails without it.
kind('agent.additionalModel', 'agent', 'model', 'strict-project', 'error');
kind('agent.prompt', 'agent', 'prompt', 'strict-project', 'error');
// A guardrail that cannot be compiled either denies the run (fail-closed) or is
// silently skipped (fail-open): a lost safety control either way, and a disabled
// guardrail enforces nothing.
kind('agent.guardrail', 'agent', 'guardrail', 'project-then-tenant', 'error', { inactiveBreaks: true });
// agentService skips an inactive/missing tool, MCP server or knowledge module.
kind('agent.tool', 'agent', 'tool', 'project-then-tenant', 'warning', { inactiveBreaks: true });
kind('agent.mcp', 'agent', 'mcp-server', 'project-then-tenant', 'warning', { inactiveBreaks: true });
kind('agent.knowledge', 'agent', 'rag-module', 'project-then-tenant', 'warning', { inactiveBreaks: true });
// A run skips a sub-agent whose agent is not active (resolveSubagentTarget), the way every other way
// of running an agent refuses it: the parent carries on without that child and says so in its warnings.
kind('agent.subagent', 'agent', 'agent', 'strict-project', 'warning', { inactiveBreaks: true, requiresActive: true });
// buildSubagentModel falls back to the parent's model: reduced, not broken.
kind('agent.subagentModel', 'agent', 'model', 'strict-project', 'warning');
kind('agent.subagentKnowledge', 'agent', 'rag-module', 'project-then-tenant', 'warning', { inactiveBreaks: true });
kind('agent.subagentTool', 'agent', 'tool', 'project-then-tenant', 'warning', { inactiveBreaks: true });
kind('agent.subagentMcp', 'agent', 'mcp-server', 'project-then-tenant', 'warning', { inactiveBreaks: true });
// memoryService throws for any store whose status !== 'active' (incl. 'error').
kind('agent.memory', 'agent', 'memory-store', 'strict-project', 'warning', { inactiveBreaks: true, requiresActive: true });
kind('agent.skill', 'agent', 'skill', 'strict-project', 'warning', { inactiveBreaks: true });
// browser_use.config.browserId is an id OR a key (resolveBrowser tries both);
// canAccessBrowser accepts the agent's project or a tenant-wide profile.
kind('agent.browser', 'agent', 'browser', 'project-then-tenant', 'warning', {
  by: 'id', alsoByKey: true, inactiveBreaks: true,
});
// The optional provider pin; webSearchService throws when it is not an active websearch instance.
kind('agent.webSearchProvider', 'agent', 'provider', 'provider-assignment', 'warning', {
  inactiveBreaks: true, requiresActive: true, targetAttribute: { key: 'type', value: 'websearch' },
});

// web_fetch.config.crawlerKey: fetchPageWithCrawler throws for a missing or non-active crawler.
kind('agent.crawler', 'agent', 'crawler', 'project-then-tenant', 'warning', { inactiveBreaks: true, requiresActive: true });

// The bucket an agent keeps its session files in (`attachments.bucketKey`): a session file is an ordinary
// Document Store file in that bucket, looked up in the agent's own project (inspectFileBucket). A missing or
// disabled bucket refuses uploads (409 storage_unavailable) while the agent itself still runs: reduced, not broken.
kind('agent.attachmentsBucket', 'agent', 'file-bucket', 'strict-project', 'warning', { inactiveBreaks: true });

// The sandbox template is an enterprise type: without the enterprise build the
// target type is not registered and the edge is dropped, never reported missing.
// resolveTemplateIdByKey throws 'Sandbox template "<key>" not found' on the first
// sandbox tool call, and the agent save validation rejects an unknown key too.
// Lookup is by key across the whole tenant, hence the 'tenant' scope.
kind('agent.sandboxTemplate', 'agent', 'sandbox-template', 'tenant', 'error');

// ── model ────────────────────────────────────────────────────────────────────
// providerService throws when the provider is missing or not assigned to the project.
kind('model.provider', 'model', 'provider', 'provider-assignment', 'error');
// A failing replica is handled by the pool's circuit breaker.
kind('model.replicaProvider', 'model', 'provider', 'provider-assignment', 'warning');
// Unlike agents/MCP, a model request FAILS when its guardrail key does not resolve.
kind('model.guardrail', 'model', 'guardrail', 'project-then-tenant', 'error', { inactiveBreaks: true });
kind('model.dynamicModel', 'model', 'model', 'strict-project', 'error');
// lookupCache swallows every failure and falls through to "no cache".
kind('model.semanticCacheModel', 'model', 'model', 'strict-project', 'warning');
kind('model.semanticCacheIndex', 'model', 'vector-index', 'strict-project', 'warning');

// ── knowledge ────────────────────────────────────────────────────────────────
// A tenant-wide RAG module/reranker resolves model + vector index in the caller's project.
kind('rag.embeddingModel', 'rag-module', 'model', 'strict-project', 'error', { callerScoped: true });
kind('rag.vectorIndex', 'rag-module', 'vector-index', 'strict-project', 'error', { callerScoped: true });
// A failing reranker falls back to the vector order. findRerankerByKey(key, projectId)
// is a strict project lookup (no tenant-wide fallback), in the CALLER's project.
kind('rag.reranker', 'rag-module', 'reranker', 'strict-project', 'warning', { inactiveBreaks: true, callerScoped: true });
kind('rag.fileBucket', 'rag-module', 'file-bucket', 'strict-project', 'warning', { callerScoped: true });
kind('memory.embeddingModel', 'memory-store', 'model', 'strict-project', 'error');
kind('memory.vectorIndex', 'memory-store', 'vector-index', 'strict-project', 'error');
kind('reranker.model', 'reranker', 'model', 'strict-project', 'warning', { callerScoped: true });
// A crawl continues; only the per-page ingestion is marked failed. Ingestion looks
// the module up with the crawler's projectId (strict; the tenant-wide fallback is agent-only).
kind('crawler.ragModule', 'crawler', 'rag-module', 'strict-project', 'warning', { inactiveBreaks: true, callerScoped: true });

// ── mcp / safety ─────────────────────────────────────────────────────────────
// An unknown guardrail key is a vacuous allow: the server is quietly unguarded.
kind('mcp.guardrail', 'mcp-server', 'guardrail', 'project-then-tenant', 'error', { inactiveBreaks: true });
// The only reference the product maintains by id (member delete prunes it).
// A stdio MCP server that runs in a sandbox needs its template; enterprise type, see agent.sandboxTemplate.
// sandboxMcpRunner resolves it with the same throwing resolveTemplateIdByKey.
kind('mcp.sandboxTemplate', 'mcp-server', 'sandbox-template', 'tenant', 'error');
kind('mcp.compositeMember', 'mcp-server', 'mcp-server', 'same-project-id', 'warning', {
  by: 'id', inactiveBreaks: true,
});
// A tenant-wide guardrail evaluates with the caller's project.
kind('guardrail.model', 'guardrail', 'model', 'strict-project', 'error', { callerScoped: true });
// scanWithPolicy -> findPiiPolicyByKey(key, projectId) is strict (the tenant-wide
// fallback only exists in the save-time legacy projection). A missing policy
// degrades the guardrail, so failMode 'open' lets traffic through unscanned and a
// disabled policy scans nothing: a lost safety control, hence error.
kind('guardrail.piiPolicy', 'guardrail', 'pii-policy', 'strict-project', 'error', { inactiveBreaks: true, callerScoped: true });
// A missing word list is an empty list (cached): the filter silently matches nothing.
kind('guardrail.wordList', 'guardrail', 'guardrail-word-list', 'project-then-tenant', 'error');

// ── quality ──────────────────────────────────────────────────────────────────
// Evaluation / red-team / analysis runs resolve in the owning project and fail at run time.
kind('evaluation.agent', 'evaluation-target', 'agent', 'strict-project', 'warning');
kind('evaluation.model', 'evaluation-target', 'model', 'strict-project', 'warning');
kind('evaluation.ragModule', 'evaluation-target', 'rag-module', 'strict-project', 'warning', { inactiveBreaks: true });
kind('evaluation.prompt', 'evaluation-target', 'prompt', 'strict-project', 'warning');
kind('evaluation.target', 'evaluation-suite', 'evaluation-target', 'strict-project', 'warning');
kind('evaluation.dataset', 'evaluation-suite', 'evaluation-dataset', 'strict-project', 'warning');
kind('evaluation.judgeModel', 'evaluation-suite', 'model', 'strict-project', 'warning');
kind('evaluation.embeddingModel', 'evaluation-suite', 'model', 'strict-project', 'warning');
kind('evaluation.datasetRagModule', 'evaluation-dataset', 'rag-module', 'strict-project', 'warning');
kind('redteam.agent', 'redteam-campaign', 'agent', 'strict-project', 'warning');
kind('redteam.model', 'redteam-campaign', 'model', 'strict-project', 'warning');
kind('redteam.judgeModel', 'redteam-campaign', 'model', 'strict-project', 'warning');
kind('redteam.probe', 'redteam-campaign', 'redteam-custom-probe', 'strict-project', 'warning');
kind('analysis.extractionModel', 'analysis-definition', 'model', 'strict-project', 'warning');
kind('analysis.judgeModel', 'analysis-definition', 'model', 'strict-project', 'warning');

// ── operations ───────────────────────────────────────────────────────────────
// alertEvaluator reads 0 samples for an unknown key, so the rule never fires and
// shows no error. Inference servers have no project at all.
// A rule on agents names them by the tracing agent name; a traced agent that is not a
// console agent has no row, so an unresolved name is a warning, not an error.
kind('alert.agent', 'alert-rule', 'agent', 'strict-project', 'warning');
kind('alert.model', 'alert-rule', 'model', 'strict-project', 'warning');
kind('alert.guardrail', 'alert-rule', 'guardrail', 'strict-project', 'warning');
kind('alert.ragModule', 'alert-rule', 'rag-module', 'strict-project', 'warning');
kind('alert.mcpServer', 'alert-rule', 'mcp-server', 'strict-project', 'warning');
kind('alert.inferenceServer', 'alert-rule', 'inference-server', 'tenant', 'warning');

/** Every registered edge kind. */
export const EDGE_KINDS: Readonly<Record<string, EdgeKindDefinition>> = Object.freeze(
  Object.fromEntries(defs.map((d) => [d.kind, d])),
);

if (Object.keys(EDGE_KINDS).length !== defs.length) {
  throw new Error('Duplicate resource edge kind in references.ts');
}

// Edge kinds contributed by an edition that is not part of this file (the
// enterprise overlay). EDGE_KINDS stays the frozen community set; every lookup
// goes through getEdgeKindDefinition so both are seen.
const extraKinds = new Map<string, EdgeKindDefinition>();

/**
 * Adds edge kinds from outside this file. Idempotent per kind name: a kind that
 * is already known (community or an earlier contribution) is left untouched.
 * Returns the names that were actually added.
 */
export function registerEdgeKindDefinitions(extra: readonly EdgeKindDefinition[]): string[] {
  const added: string[] = [];
  for (const def of extra) {
    if (EDGE_KINDS[def.kind] || extraKinds.has(def.kind)) continue;
    extraKinds.set(def.kind, def);
    added.push(def.kind);
  }
  return added;
}

export function getEdgeKindDefinition(kindName: string): EdgeKindDefinition | undefined {
  return EDGE_KINDS[kindName] ?? extraKinds.get(kindName);
}

export function listEdgeKindDefinitions(): EdgeKindDefinition[] {
  return [...defs, ...extraKinds.values()];
}

/** Test seam: forgets every registered extra (enterprise) kind. */
export function resetExtraEdgeKindsForTests(): void {
  extraKinds.clear();
}

// ── extraction helper ────────────────────────────────────────────────────────

/**
 * Edge text comes from tenant-editable documents. No valid key/id is anywhere
 * near this long, so longer values are dropped rather than echoed into responses
 * and issue ids; the per-record count bounds an oversized document the same way.
 */
export const MAX_EDGE_TEXT_LENGTH = 256;
export const MAX_EDGES_PER_RECORD = 500;

export interface EdgeCollector {
  /**
   * Records one reference. `target` that is empty / not a string is ignored, so
   * extractors can pass raw document fields without guarding each one.
   * `options.qualifier` is for composite targets (vector index -> its providerKey).
   * Throws on an unregistered kind or one that belongs to another fromType: that
   * is a programming error the extractor's unit test must catch.
   */
  add(kindName: string, target: unknown, field: string, options?: { qualifier?: unknown }): void;
  /** The deduped edges, or undefined when there are none (keeps records light). */
  done(): ResourceEdgeInput[] | undefined;
}

/**
 * The ONLY way extractors build edges. `toType` and `by` come from the kind
 * registration so an extractor cannot disagree with the resolver.
 */
export function createEdgeCollector(fromType: string): EdgeCollector {
  const edges: ResourceEdgeInput[] = [];
  const seen = new Set<string>();
  return {
    add(kindName, target, field, options) {
      const def = getEdgeKindDefinition(kindName);
      if (!def) throw new Error(`Unknown resource edge kind "${kindName}"`);
      if (def.fromType !== fromType) {
        throw new Error(`Edge kind "${kindName}" belongs to "${def.fromType}", not "${fromType}"`);
      }
      // Strings only: a malformed field (object/array/number) must not turn into a bogus "[object Object]" target.
      if (typeof target !== 'string') return;
      const value = target.trim();
      if (!value || value.length > MAX_EDGE_TEXT_LENGTH) return;
      const qualifier = typeof options?.qualifier === 'string' ? options.qualifier.trim() : '';
      if (qualifier.length > MAX_EDGE_TEXT_LENGTH) return;
      if (edges.length >= MAX_EDGES_PER_RECORD) return;
      // Field paths can embed document object keys: clip them too.
      const fieldPath = field.length > MAX_EDGE_TEXT_LENGTH ? field.slice(0, MAX_EDGE_TEXT_LENGTH) : field;
      const dedupeKey = `${kindName}\u0000${value}\u0000${qualifier}\u0000${fieldPath}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      edges.push({
        kind: kindName,
        toType: def.toType,
        by: def.by,
        target: value,
        field: fieldPath,
        ...(qualifier ? { qualifier } : {}),
      });
    },
    done: () => (edges.length > 0 ? edges : undefined),
  };
}

// ── resolution ───────────────────────────────────────────────────────────────

export interface ResolutionIndex {
  byTypeKey: Map<string, Map<string, ResourceRecord[]>>;
  byTypeId: Map<string, Map<string, ResourceRecord>>;
}

/** Built once per snapshot and cached with it. */
export function buildResolutionIndex(records: readonly ResourceRecord[]): ResolutionIndex {
  const byTypeKey = new Map<string, Map<string, ResourceRecord[]>>();
  const byTypeId = new Map<string, Map<string, ResourceRecord>>();
  for (const r of records) {
    let ids = byTypeId.get(r.type);
    if (!ids) byTypeId.set(r.type, (ids = new Map()));
    ids.set(r.id, r);
    if (!r.key) continue;
    let keys = byTypeKey.get(r.type);
    if (!keys) byTypeKey.set(r.type, (keys = new Map()));
    const bucket = keys.get(r.key);
    if (bucket) bucket.push(r);
    else keys.set(r.key, [r]);
  }
  return { byTypeKey, byTypeId };
}

export interface ResolvedEdge {
  from: ResourceRecord;
  edge: ResourceEdgeInput;
  def: EdgeKindDefinition;
  status: ResourceEdgeStatus;
  /** Rows the runtime would use (1 for ok/inactive; several when ambiguous). */
  matches: ResourceRecord[];
  /** Every row with that key/id before the scope rule (other-project copies for cross-project). */
  candidates: ResourceRecord[];
}

function attributeOf(r: ResourceRecord, name: string): string | number | boolean | null {
  return r.attributes.find((a) => a.key === name)?.value ?? null;
}

function applyScope(
  def: EdgeKindDefinition,
  from: ResourceRecord,
  candidates: ResourceRecord[],
): ResourceRecord[] {
  const project = from.projectId;
  switch (def.scope) {
    case 'tenant':
      return candidates;
    case 'same-project-id':
      return candidates.filter((c) => c.projectId === project);
    case 'provider-assignment':
      // findProviderByKey filters on projectId/projectIds only when a project is given.
      if (project === null) return candidates;
      return candidates.filter((c) => c.projectId === project || (c.projectIds?.includes(project) ?? false));
    case 'project-then-tenant': {
      const own = candidates.filter((c) => c.projectId === project);
      if (own.length > 0 || project === null) return own;
      return candidates.filter((c) => c.projectId === null);
    }
    case 'strict-project':
    default:
      if (def.callerScoped && project === null) return candidates;
      return candidates.filter((c) => c.projectId === project);
  }
}

/** Pure: classifies one edge against the snapshot index. Null for an unregistered kind. */
export function resolveEdge(
  index: ResolutionIndex,
  from: ResourceRecord,
  edge: ResourceEdgeInput,
): ResolvedEdge | null {
  const def = getEdgeKindDefinition(edge.kind);
  if (!def) return null;

  let candidates: ResourceRecord[];
  if (edge.by === 'id') {
    const byId = index.byTypeId.get(edge.toType)?.get(edge.target);
    candidates = byId ? [byId] : [];
    if (candidates.length === 0 && def.alsoByKey) {
      candidates = index.byTypeKey.get(edge.toType)?.get(edge.target) ?? [];
    }
  } else {
    candidates = index.byTypeKey.get(edge.toType)?.get(edge.target) ?? [];
  }
  if (edge.qualifier) {
    const attr = def.qualifierAttribute ?? 'providerKey';
    candidates = candidates.filter((c) => attributeOf(c, attr) === edge.qualifier);
  }
  if (def.targetAttribute) {
    // The runtime rejects a row of the wrong kind (e.g. a non-websearch provider); an unreported attribute is not judged.
    const { key, value } = def.targetAttribute;
    candidates = candidates.filter((c) => {
      const actual = attributeOf(c, key);
      return actual === null || actual === value;
    });
  }

  const matches = applyScope(def, from, candidates);
  let status: ResourceEdgeStatus;
  if (matches.length === 0) {
    status = candidates.length > 0 ? 'cross-project' : 'missing';
  } else if (matches.length === 1 || (def.callerScoped && from.projectId === null)) {
    const inactive = (m: ResourceRecord) =>
      (def.inactiveBreaks && m.statusTone === 'off')
      || (def.requiresActive === true && m.status !== null && m.status.toLowerCase() !== 'active');
    status = matches.every(inactive) ? 'inactive' : 'ok';
  } else {
    status = 'ambiguous';
  }
  return { from, edge, def, status, matches, candidates };
}

// ── views ────────────────────────────────────────────────────────────────────

export const MAX_EDGE_CANDIDATES = 10;

export interface RefViewContext {
  tenantId: string;
  projectNames: Map<string, string>;
  /** Scope of a registered type, for the project display; unknown types count as the most lenient scope. */
  scopeOfType?: (type: string) => ResourceScope | undefined;
}

export function toRefView(r: ResourceRecord, ctx: RefViewContext): ResourceRefView {
  return {
    type: r.type,
    id: r.id,
    key: r.key,
    name: r.name,
    projectId: r.projectId,
    projectName: r.projectId ? ctx.projectNames.get(r.projectId) ?? null : null,
    projectDisplay: computeProjectDisplay(
      {
        scope: ctx.scopeOfType?.(r.type) ?? 'project-or-tenant',
        projectId: r.projectId,
        projectIds: r.projectIds,
      },
      ctx.projectNames,
    ),
    crn: buildCrn({ tenantId: ctx.tenantId, projectId: r.projectId, type: r.type, id: r.id }),
  };
}

/** A target that does not (uniquely) exist: type + key (or id) only. */
export function toBareRefView(edge: ResourceEdgeInput): ResourceRefView {
  return {
    type: edge.toType,
    id: edge.by === 'id' ? edge.target : null,
    key: edge.by === 'key' ? edge.target : null,
    name: null,
    projectId: null,
    projectName: null,
    projectDisplay: null,
    crn: null,
  };
}

export function severityFor(resolved: ResolvedEdge): HealthSeverity | null {
  return resolved.status === 'ok' ? null : resolved.def.severity;
}

/** The referrer's view of an edge. */
export function toOutgoingView(resolved: ResolvedEdge, ctx: RefViewContext): ResourceEdgeView {
  const { status, matches, candidates } = resolved;
  const resolvedTarget = (status === 'ok' || status === 'inactive') && matches.length > 0;
  const alternatives = status === 'ambiguous' ? matches : status === 'cross-project' ? candidates : [];
  return {
    kind: resolved.edge.kind,
    field: resolved.edge.field,
    direction: 'out',
    status,
    severity: severityFor(resolved),
    other: resolvedTarget ? toRefView(matches[0], ctx) : toBareRefView(resolved.edge),
    ...(alternatives.length > 0
      ? { candidates: alternatives.slice(0, MAX_EDGE_CANDIDATES).map((c) => toRefView(c, ctx)) }
      : {}),
  };
}

/** The target's view of an edge that points at it. */
export function toIncomingView(resolved: ResolvedEdge, ctx: RefViewContext, status: ResourceEdgeStatus): ResourceEdgeView {
  return {
    kind: resolved.edge.kind,
    field: resolved.edge.field,
    direction: 'in',
    status,
    severity: status === 'ok' ? null : resolved.def.severity,
    other: toRefView(resolved.from, ctx),
  };
}
