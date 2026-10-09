/**
 * Quality resource types: evaluation-target, evaluation-dataset,
 * evaluation-suite, redteam-campaign, redteam-custom-probe, analysis-definition.
 *
 * Same pattern as ./core.ts. Every list method below adds a project filter only
 * when `projectId !== undefined` (mongodb/*.mixin.ts and sqlite/*.mixin.ts agree),
 * so calling with no argument returns the whole tenant, tenant-wide rows included.
 */
import { buildAttributes, statusFromEnabled, str } from '../mapping';
import type { ResourceRecord, ResourceTypeDefinition } from '../types';
import { baseRecord } from './modelsSafety';

type Doc = Record<string, any>;
const nameOf = (d: Doc) => str(d.name) ?? String(d._id ?? d.id);

/** `external` (url + auth headers), systemPrompt, defaultParams, responseFormat, metadata are dropped. */
export function mapEvaluationTarget(t: Doc): ResourceRecord {
  return baseRecord('evaluation-target', t, {
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
  return baseRecord('evaluation-dataset', d, {
    name: nameOf(d),
    status: null,
    attributes: buildAttributes({
      source: str(d.source),
      itemCount: typeof d.itemCount === 'number' ? d.itemCount : Array.isArray(d.items) ? d.items.length : undefined,
    }),
  });
}

export function mapEvaluationSuite(s: Doc): ResourceRecord {
  return baseRecord('evaluation-suite', s, {
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
  return baseRecord('redteam-campaign', c, {
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
  return baseRecord('analysis-definition', a, {
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
