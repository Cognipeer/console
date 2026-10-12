/**
 * Quality resource types: evaluation-target, evaluation-dataset,
 * evaluation-suite, redteam-campaign, redteam-custom-probe, analysis-definition.
 *
 * Same pattern as ./core.ts. Every list method below adds a project filter only
 * when `projectId !== undefined` (mongodb/*.mixin.ts and sqlite/*.mixin.ts agree),
 * so calling with no argument returns the whole tenant, tenant-wide rows included.
 */
import { buildAttributes, statusFromEnabled, str } from '../mapping';
import { createEdgeCollector } from '../references';
import type { ResourceRecord, ResourceTypeDefinition } from '../types';
import { baseRecord } from './modelsSafety';

type Doc = Record<string, any>;
const nameOf = (d: Doc) => str(d.name) ?? String(d._id ?? d.id);

/** `external` (url + auth headers), systemPrompt, defaultParams, responseFormat, metadata are dropped. */
export function mapEvaluationTarget(t: Doc): ResourceRecord {
  const e = createEdgeCollector('evaluation-target');
  // The run path reads ONE key chosen by `kind`; the create path stores whatever
  // was posted, so a leftover key of another kind is never resolved at run time.
  const kindIs = (k: string) => !t.kind || t.kind === k;
  if (kindIs('agent')) e.add('evaluation.agent', t.agentKey, 'agentKey');
  if (kindIs('model')) e.add('evaluation.model', t.modelKey, 'modelKey');
  if (kindIs('rag')) e.add('evaluation.ragModule', t.ragModuleKey, 'ragModuleKey');
  // promptKey (when set) wins over the literal systemPrompt.
  e.add('evaluation.prompt', t.promptKey, 'promptKey');
  return baseRecord('evaluation-target', t, {
    edges: e.done(),
    name: nameOf(t),
    status: null,
    attributes: buildAttributes({
      kind: str(t.kind),
      agentKey: str(t.agentKey),
      modelKey: str(t.modelKey),
      ragModuleKey: str(t.ragModuleKey),
    }),
  });
}

/** Items hold captured payloads: only the count is read. */
export function mapEvaluationDataset(d: Doc): ResourceRecord {
  const e = createEdgeCollector('evaluation-dataset');
  // The generation source is not persisted on the dataset today; read it only
  // if a writer ever records it under metadata.generation.
  e.add('evaluation.datasetRagModule', d.metadata?.generation?.ragModuleKey, 'metadata.generation.ragModuleKey');
  return baseRecord('evaluation-dataset', d, {
    edges: e.done(),
    name: nameOf(d),
    status: null,
    attributes: buildAttributes({
      source: str(d.source),
      itemCount: typeof d.itemCount === 'number' ? d.itemCount : Array.isArray(d.items) ? d.items.length : undefined,
    }),
  });
}

export function mapEvaluationSuite(s: Doc): ResourceRecord {
  const e = createEdgeCollector('evaluation-suite');
  e.add('evaluation.target', s.targetKey, 'targetKey');
  e.add('evaluation.dataset', s.datasetKey, 'datasetKey');
  e.add('evaluation.judgeModel', s.judgeModelKey, 'judgeModelKey');
  e.add('evaluation.embeddingModel', s.embeddingModelKey, 'embeddingModelKey');
  return baseRecord('evaluation-suite', s, {
    edges: e.done(),
    name: nameOf(s),
    status: null,
    attributes: buildAttributes({
      targetKey: str(s.targetKey),
      datasetKey: str(s.datasetKey),
      scorerCount: Array.isArray(s.scorers) ? s.scorers.length : undefined,
      judgeModelKey: str(s.judgeModelKey),
      embeddingModelKey: str(s.embeddingModelKey),
    }),
  });
}

export function mapRedTeamCampaign(c: Doc): ResourceRecord {
  const schedule = (c.schedule ?? null) as { cron?: unknown; enabled?: unknown } | null;
  const e = createEdgeCollector('redteam-campaign');
  // Same as evaluation targets: the adapter uses the key matching targetKind only.
  if (!c.targetKind || c.targetKind === 'agent') e.add('redteam.agent', c.agentKey, 'agentKey');
  if (!c.targetKind || c.targetKind === 'model') e.add('redteam.model', c.modelKey, 'modelKey');
  e.add('redteam.judgeModel', c.judgeModelKey, 'judgeModelKey');
  // Built-in probes are catalog entries, not rows: only `custom:` keys can resolve.
  if (Array.isArray(c.probeKeys)) {
    c.probeKeys.forEach((k: unknown, i: number) => {
      if (typeof k === 'string' && k.startsWith('custom:')) e.add('redteam.probe', k, `probeKeys[${i}]`);
    });
  }
  return baseRecord('redteam-campaign', c, {
    edges: e.done(),
    name: nameOf(c),
    status: null,
    attributes: buildAttributes({
      targetKind: str(c.targetKind),
      agentKey: str(c.agentKey),
      modelKey: str(c.modelKey),
      judgeModelKey: str(c.judgeModelKey),
      probeCount: Array.isArray(c.probeKeys) ? c.probeKeys.length : undefined,
      scheduled: schedule ? schedule.enabled === true : undefined,
    }),
  });
}

/** Attack attempts and detectors are not surfaced. */
export function mapRedTeamCustomProbe(p: Doc): ResourceRecord {
  return baseRecord('redteam-custom-probe', p, {
    name: nameOf(p),
    status: statusFromEnabled(typeof p.enabled === 'boolean' ? p.enabled : true),
    attributes: buildAttributes({
      family: str(p.family),
      category: str(p.category),
      severity: str(p.severity),
      attemptCount: Array.isArray(p.attempts) ? p.attempts.length : undefined,
    }),
  });
}

/** extractionInstructions and field definitions are not surfaced, only counts. */
export function mapAnalysisDefinition(a: Doc): ResourceRecord {
  const schedule = (a.schedule ?? null) as { enabled?: unknown } | null;
  const e = createEdgeCollector('analysis-definition');
  e.add('analysis.extractionModel', a.extractionModelKey, 'extractionModelKey');
  e.add('analysis.judgeModel', a.judgeModelKey, 'judgeModelKey');
  return baseRecord('analysis-definition', a, {
    edges: e.done(),
    name: nameOf(a),
    status: null,
    attributes: buildAttributes({
      fieldCount: Array.isArray(a.fieldSet) ? a.fieldSet.length : undefined,
      extractionModelKey: str(a.extractionModelKey),
      judgeModelKey: str(a.judgeModelKey),
      scheduled: schedule ? schedule.enabled === true : undefined,
    }),
  });
}

export const qualityResourceTypes: ResourceTypeDefinition[] = [
  {
    type: 'evaluation-target',
    service: 'evaluations',
    category: 'quality',
    scope: 'project',
    edition: 'community',
    list: async ({ db }) => (await db.listEvaluationTargets()).map((t) => mapEvaluationTarget(t as never)),
    detailUrl: (r) => `/dashboard/evaluations/targets/${encodeURIComponent(r.id)}`,
  },
  {
    type: 'evaluation-dataset',
    service: 'evaluations',
    category: 'quality',
    scope: 'project',
    edition: 'community',
    list: async ({ db }) => (await db.listEvaluationDatasets()).map((d) => mapEvaluationDataset(d as never)),
    detailUrl: (r) => `/dashboard/evaluations/datasets/${encodeURIComponent(r.id)}`,
  },
  {
    type: 'evaluation-suite',
    service: 'evaluations',
    category: 'quality',
    scope: 'project',
    edition: 'community',
    list: async ({ db }) => (await db.listEvaluationSuites()).map((s) => mapEvaluationSuite(s as never)),
    detailUrl: (r) => `/dashboard/evaluations/suites/${encodeURIComponent(r.id)}`,
  },
  {
    type: 'redteam-campaign',
    service: 'redteam',
    category: 'quality',
    scope: 'project',
    edition: 'community',
    list: async ({ db }) => (await db.listRedTeamCampaigns()).map((c) => mapRedTeamCampaign(c as never)),
    detailUrl: (r) => `/dashboard/redteam/campaigns/${encodeURIComponent(r.id)}`,
  },
  {
    type: 'redteam-custom-probe',
    service: 'redteam',
    category: 'quality',
    scope: 'project',
    edition: 'community',
    list: async ({ db }) => (await db.listRedTeamCustomProbes()).map((p) => mapRedTeamCustomProbe(p as never)),
    // Probes are managed on a list page; there is no page per probe.
    detailUrl: () => null,
  },
  {
    type: 'analysis-definition',
    service: 'analysis',
    category: 'quality',
    scope: 'project',
    edition: 'community',
    list: async ({ db }) => (await db.listAnalysisDefinitions()).map((a) => mapAnalysisDefinition(a as never)),
    detailUrl: (r) => `/dashboard/analysis/definitions/${encodeURIComponent(r.id)}`,
  },
];
