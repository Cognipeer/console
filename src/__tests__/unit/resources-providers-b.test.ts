import { describe, expect, it, vi } from 'vitest';
import {
  mapGuardrail,
  mapGuardrailWordList,
  mapInferenceServer,
  mapPiiPolicy,
  mapProvider,
  modelsSafetyResourceTypes,
} from '@/lib/resources/providers/modelsSafety';
import {
  mapAnalysisDefinition,
  mapEvaluationDataset,
  mapEvaluationSuite,
  mapEvaluationTarget,
  mapRedTeamCampaign,
  mapRedTeamCustomProbe,
  qualityResourceTypes,
} from '@/lib/resources/providers/quality';
import { mapAlertRule, mapConfigGroup, operationsResourceTypes } from '@/lib/resources/providers/operations';
import type { DatabaseProvider } from '@/lib/database';
import type { ResourceProviderContext } from '@/lib/resources/types';

const SECRET = 'TOP-SECRET-VALUE';
const base = { tenantId: 'ten', createdBy: 'u1', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z') };

describe('models & safety mappers never expose secrets', () => {
  it('provider', () => {
    const r = mapProvider({
      ...base, _id: 'pr1', projectId: undefined, projectIds: ['p1', 'p2'], key: 'oai', label: 'OpenAI', type: 'model', driver: 'openai', status: 'active',
      credentialsEnc: SECRET, settings: { apiKey: SECRET, baseUrl: SECRET }, metadata: { org: SECRET }, capabilitiesOverride: [SECRET],
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r).toMatchObject({ type: 'provider', name: 'OpenAI', key: 'oai', projectId: 'p1', status: 'active', statusTone: 'ok' });
    expect(r.attributes).toEqual(expect.arrayContaining([{ key: 'driver', value: 'openai' }, { key: 'assignedProjectCount', value: 2 }]));
    expect(r.projectIds).toEqual(['p1', 'p2']);
    expect(mapProvider({ _id: 'x', key: 'k', label: 'L', status: 'errored' })).toMatchObject({ projectId: null, statusTone: 'warn' });
  });

  it('inference-server is tenant-wide', () => {
    const r = mapInferenceServer({
      ...base, _id: 's1', key: 'vllm-a', name: 'A', type: 'vllm', status: 'disabled', baseUrl: `http://${SECRET}`,
      apiKey: SECRET, apiKeySealed: SECRET, lastError: SECRET, metadata: { x: SECRET }, pollIntervalSeconds: 30,
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r).toMatchObject({ projectId: null, status: 'disabled', statusTone: 'off' });
  });

  it('guardrail', () => {
    const r = mapGuardrail({
      ...base, _id: 'g1', projectId: 'null', key: 'g', name: 'G', type: 'custom', target: 'input', action: 'block', enabled: true, mode: 'enforce',
      customPrompt: SECRET, policy: { words: [SECRET] }, hooks: { a: SECRET }, metadata: { m: SECRET },
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r).toMatchObject({ projectId: null, status: 'enabled', statusTone: 'ok' });
    expect(mapGuardrail({ _id: 'g2', name: 'x', enabled: false }).statusTone).toBe('off');
  });

  it('word list exposes the count, never the words', () => {
    const r = mapGuardrailWordList({ ...base, _id: 'w1', projectId: '', key: 'w', name: 'W', language: 'en', words: [SECRET, 'b'] });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.projectId).toBeNull();
    expect(r.attributes).toEqual(expect.arrayContaining([{ key: 'wordCount', value: 2 }]));
  });

  it('pii policy', () => {
    const r = mapPiiPolicy({
      ...base, _id: 'pp1', projectId: 'p1', key: 'k', name: 'P', enabled: false, engine: 'nlp', defaultAction: 'mask', languages: ['en', 'tr'],
      categories: { email: true }, customPatterns: [{ regex: SECRET }], detection: { x: SECRET }, metadata: { y: SECRET },
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r).toMatchObject({ status: 'disabled', statusTone: 'off', projectId: 'p1' });
    expect(r.attributes).toEqual(expect.arrayContaining([{ key: 'languages', value: 'en, tr' }, { key: 'customPatternCount', value: 1 }]));
  });
});

describe('quality mappers never expose secrets', () => {
  it('evaluation target drops external url/headers and prompts', () => {
    const r = mapEvaluationTarget({
      ...base, _id: 'et1', key: 'k', name: 'T', kind: 'external', external: { url: SECRET, headers: { Authorization: SECRET } },
      systemPrompt: SECRET, defaultParams: { a: SECRET }, responseFormat: { b: SECRET }, metadata: { c: SECRET },
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r).toMatchObject({ status: null, statusTone: 'neutral', projectId: null });
    expect(r.attributes).toEqual([{ key: 'kind', value: 'external' }]);
  });

  it('dataset exposes itemCount only', () => {
    const r = mapEvaluationDataset({ ...base, _id: 'd1', key: 'k', name: 'D', source: 'manual', itemCount: 4, items: [{ input: SECRET }] });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.attributes).toEqual(expect.arrayContaining([{ key: 'itemCount', value: 4 }]));
    expect(mapEvaluationDataset({ _id: 'd2', name: 'x', items: [{ a: SECRET }, {}] }).attributes).toEqual([{ key: 'itemCount', value: 2 }]);
  });

  it('suite, campaign, probe, analysis definition', () => {
    const suite = mapEvaluationSuite({ ...base, _id: 's', key: 'k', name: 'S', targetKey: 't', datasetKey: 'd', scorers: [{ prompt: SECRET }], runConfig: { a: SECRET }, metadata: { b: SECRET } });
    const camp = mapRedTeamCampaign({ ...base, _id: 'c', key: 'k', name: 'C', targetKind: 'agent', probeKeys: ['a', 'b'], schedule: { cron: '* * * * *', enabled: true }, policy: { x: SECRET }, metadata: { y: SECRET } });
    const probe = mapRedTeamCustomProbe({ ...base, _id: 'pb', key: 'k', name: 'P', description: 'd', family: 'f', category: 'c', severity: 'high', attempts: [{ prompt: SECRET }], detectors: { x: SECRET }, enabled: false });
    const ana = mapAnalysisDefinition({ ...base, _id: 'a', key: 'k', name: 'A', fieldSet: [{}, {}], extractionInstructions: SECRET, modes: { x: SECRET }, schedule: { cron: 'x', enabled: false }, metadata: { z: SECRET } });
    for (const r of [suite, camp, probe, ana]) expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(suite.attributes).toEqual(expect.arrayContaining([{ key: 'scorerCount', value: 1 }]));
    expect(camp.attributes).toEqual(expect.arrayContaining([{ key: 'probeCount', value: 2 }, { key: 'scheduled', value: true }]));
    expect(probe).toMatchObject({ status: 'disabled', statusTone: 'off' });
    expect(mapRedTeamCustomProbe({ _id: 'p2', name: 'x' }).status).toBe('enabled');
    expect(ana.attributes).toEqual(expect.arrayContaining([{ key: 'fieldCount', value: 2 }, { key: 'scheduled', value: false }]));
  });
});

describe('operations mappers never expose secrets', () => {
  it('alert rule drops channels and condition', () => {
    const r = mapAlertRule({
      ...base, _id: 'ar1', projectId: 'p1', name: 'High latency', module: 'models', enabled: true, metric: 'latency',
      condition: { x: SECRET }, windowMinutes: 5, cooldownMinutes: 15, scope: { modelKey: 'gpt' },
      channels: [{ type: 'webhook', url: SECRET, secret: SECRET, recipients: [SECRET] }],
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r).toMatchObject({ key: null, projectId: 'p1', status: 'enabled', statusTone: 'ok' });
    expect(r.attributes).toEqual(expect.arrayContaining([{ key: 'channelCount', value: 1 }, { key: 'modelKey', value: 'gpt' }]));
  });

  it('config group', () => {
    const r = mapConfigGroup({ ...base, _id: 'cg1', projectId: undefined, key: 'k', name: 'G', tags: ['a', 'b'], metadata: { s: SECRET } });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r).toMatchObject({ projectId: null, status: null });
  });
});

describe('type definitions', () => {
  const rows = (extra: object = {}) => [{ _id: 'x1', key: 'k', name: 'N', projectId: 'p1', ...extra }];
  const db = {
    listProviders: vi.fn().mockResolvedValue(rows({ label: 'L', status: 'active' })),
    listInferenceServers: vi.fn().mockResolvedValue(rows({ status: 'active' })),
    listGuardrails: vi.fn().mockResolvedValue(rows()),
    listGuardrailWordLists: vi.fn().mockResolvedValue(rows()),
    listPiiPolicies: vi.fn().mockResolvedValue(rows()),
    listEvaluationTargets: vi.fn().mockResolvedValue(rows()),
    listEvaluationDatasets: vi.fn().mockResolvedValue(rows()),
    listEvaluationSuites: vi.fn().mockResolvedValue(rows()),
    listRedTeamCampaigns: vi.fn().mockResolvedValue(rows()),
    listRedTeamCustomProbes: vi.fn().mockResolvedValue(rows()),
    listAnalysisDefinitions: vi.fn().mockResolvedValue(rows()),
    listAlertRules: vi.fn().mockResolvedValue(rows()),
    listConfigGroups: vi.fn().mockResolvedValue(rows()),
  };
  const ctx = { db: db as unknown as DatabaseProvider, tenantId: 'ten', tenantDbName: 'd' } satisfies ResourceProviderContext;

  it('registers every expected type id', () => {
    expect(modelsSafetyResourceTypes.map((d) => d.type)).toEqual(['provider', 'inference-server', 'guardrail', 'guardrail-word-list', 'pii-policy']);
    expect(qualityResourceTypes.map((d) => d.type)).toEqual(['evaluation-target', 'evaluation-dataset', 'evaluation-suite', 'redteam-campaign', 'redteam-custom-probe', 'analysis-definition']);
    expect(operationsResourceTypes.map((d) => d.type)).toEqual(['alert-rule', 'config-group']);
  });

  it('lists with no project filter and yields records of the declared type', async () => {
    for (const d of [...modelsSafetyResourceTypes, ...qualityResourceTypes, ...operationsResourceTypes]) {
      const out = await d.list(ctx);
      expect(out).toHaveLength(1);
      expect(out[0].type).toBe(d.type);
      const url = d.detailUrl?.(out[0]) ?? null;
      if (url !== null) expect(url).toMatch(/^\/dashboard\/[a-z-]+(\/[a-z-]+)*\/[^/]+$/);
    }
    // contract calls carry no project argument (tenantId only where the contract needs it)
    expect(db.listGuardrails).toHaveBeenCalledWith();
    expect(db.listEvaluationSuites).toHaveBeenCalledWith();
    expect(db.listProviders).toHaveBeenCalledWith('ten');
    expect(db.listAlertRules).toHaveBeenCalledWith('ten');
    expect(db.listInferenceServers).toHaveBeenCalledWith('ten');
  });

  it('inference server links by key; word list, probe and alert rule have no page', async () => {
    const by = Object.fromEntries([...modelsSafetyResourceTypes, ...qualityResourceTypes, ...operationsResourceTypes].map((d) => [d.type, d]));
    const rec = (await by['inference-server'].list(ctx))[0];
    expect(by['inference-server'].detailUrl?.(rec)).toBe('/dashboard/inference-monitoring/k');
    for (const t of ['guardrail-word-list', 'redteam-custom-probe', 'alert-rule']) {
      expect(by[t].detailUrl?.((await by[t].list(ctx))[0])).toBeNull();
    }
  });
});
