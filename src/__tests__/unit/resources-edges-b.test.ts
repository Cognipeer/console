import { describe, expect, it } from 'vitest';
import { extractGuardrailEdges, mapGuardrail } from '@/lib/resources/providers/modelsSafety';
import {
  mapAnalysisDefinition,
  mapEvaluationDataset,
  mapEvaluationSuite,
  mapEvaluationTarget,
  mapRedTeamCampaign,
} from '@/lib/resources/providers/quality';
import { mapAlertRule } from '@/lib/resources/providers/operations';

const base = { tenantId: 't', createdBy: 'u' };
const pick = (edges: { kind: string; target: string; field: string }[] | undefined) =>
  (edges ?? []).map((e) => `${e.kind}:${e.target}@${e.field}`);

describe('guardrail edges', () => {
  it('reads hook-plane policies: pii, model-backed, word lists; skips tool_access and disabled', () => {
    const edges = extractGuardrailEdges({
      hooks: {
        policies: [
          { family: 'pii', enabled: true, piiPolicyKey: 'pii-tr' },
          { family: 'moderation', enabled: true, detector: 'model', modelKey: 'mod-1', lexiconCustomLists: { hate: ['wl-a'] } },
          { family: 'moderation', enabled: true, detector: 'lexicon', modelKey: 'ignored' },
          { family: 'prompt_shield', enabled: true, modelKey: 'shield' },
          { family: 'prompt_shield', enabled: true, detector: 'pattern', modelKey: 'ignored2' },
          { family: 'custom', enabled: true, modelKey: 'judge' },
          { family: 'word_filter', enabled: true, customListKeys: ['wl-b', ''] },
          { family: 'tool_access', enabled: true, allow: ['name*'] },
          { family: 'custom', enabled: false, modelKey: 'off' },
        ],
      },
    });
    expect(pick(edges)).toEqual([
      'guardrail.piiPolicy:pii-tr@hooks.policies[0].piiPolicyKey',
      'guardrail.model:mod-1@hooks.policies[1].modelKey',
      'guardrail.wordList:wl-a@hooks.policies[1].lexiconCustomLists.hate[0]',
      'guardrail.model:shield@hooks.policies[3].modelKey',
      'guardrail.model:judge@hooks.policies[5].modelKey',
      'guardrail.wordList:wl-b@hooks.policies[6].customListKeys[0]',
    ]);
  });

  it('falls back to the legacy preset blob when there is no hook plane', () => {
    const edges = extractGuardrailEdges({
      type: 'preset',
      policy: {
        moderation: { enabled: true, modelKey: 'm' },
        promptShield: { enabled: false, modelKey: 'x' },
        wordFilter: { enabled: true, customListKeys: ['wl'] },
      },
    });
    expect(pick(edges)).toEqual([
      'guardrail.model:m@policy.moderation.modelKey',
      'guardrail.wordList:wl@policy.wordFilter.customListKeys[0]',
    ]);
    expect(pick(extractGuardrailEdges({ type: 'custom', modelKey: 'c' }))).toEqual(['guardrail.model:c@modelKey']);
  });

  it('attaches edges to the mapped record and returns undefined when empty', () => {
    expect(mapGuardrail({ ...base, _id: 'g', name: 'g', hooks: { policies: [] } }).edges).toBeUndefined();
    expect(mapGuardrail({ ...base, _id: 'g', name: 'g', type: 'custom', modelKey: 'c' }).edges).toHaveLength(1);
  });
});

describe('quality edges', () => {
  it('evaluation target / suite / dataset', () => {
    const t = mapEvaluationTarget({ ...base, _id: 't', name: 't', agentKey: 'a', modelKey: 'm', ragModuleKey: 'r', promptKey: 'p', external: { headers: { k: 'SECRET' } } });
    expect(pick(t.edges)).toEqual([
      'evaluation.agent:a@agentKey', 'evaluation.model:m@modelKey', 'evaluation.ragModule:r@ragModuleKey', 'evaluation.prompt:p@promptKey',
    ]);
    const s = mapEvaluationSuite({ ...base, _id: 's', name: 's', targetKey: 'tk', datasetKey: 'dk', judgeModelKey: 'j', embeddingModelKey: 'e' });
    expect(s.edges?.map((e) => e.toType)).toEqual(['evaluation-target', 'evaluation-dataset', 'model', 'model']);
    expect(mapEvaluationDataset({ ...base, _id: 'd', name: 'd', source: 'manual' }).edges).toBeUndefined();
    expect(pick(mapEvaluationDataset({ ...base, _id: 'd', name: 'd', metadata: { generation: { ragModuleKey: 'r' } } }).edges))
      .toEqual(['evaluation.datasetRagModule:r@metadata.generation.ragModuleKey']);
  });

  it('evaluation target / red-team campaign only reference the key their kind actually runs', () => {
    const t = (kind: string) => pick(mapEvaluationTarget({ ...base, _id: 't', name: 't', kind, agentKey: 'a', modelKey: 'm', ragModuleKey: 'r' }).edges);
    expect(t('model')).toEqual(['evaluation.model:m@modelKey']);
    expect(t('agent')).toEqual(['evaluation.agent:a@agentKey']);
    expect(t('rag')).toEqual(['evaluation.ragModule:r@ragModuleKey']);
    expect(t('external')).toEqual([]);
    const c = (targetKind: string) => pick(mapRedTeamCampaign({ ...base, _id: 'c', name: 'c', targetKind, agentKey: 'a', modelKey: 'm' }).edges);
    expect(c('model')).toEqual(['redteam.model:m@modelKey']);
    expect(c('agent')).toEqual(['redteam.agent:a@agentKey']);
  });

  it('red-team campaign keeps only custom probe keys', () => {
    const c = mapRedTeamCampaign({ ...base, _id: 'c', name: 'c', agentKey: 'a', judgeModelKey: 'j', probeKeys: ['builtin.x', 'custom:mine'] });
    expect(pick(c.edges)).toEqual(['redteam.agent:a@agentKey', 'redteam.judgeModel:j@judgeModelKey', 'redteam.probe:custom:mine@probeKeys[1]']);
    expect(c.edges?.find((e) => e.kind === 'redteam.probe')?.toType).toBe('redteam-custom-probe');
  });

  it('analysis definition', () => {
    expect(pick(mapAnalysisDefinition({ ...base, _id: 'a', name: 'a', extractionModelKey: 'x', judgeModelKey: 'y' }).edges))
      .toEqual(['analysis.extractionModel:x@extractionModelKey', 'analysis.judgeModel:y@judgeModelKey']);
  });
});

describe('alert rule edges', () => {
  it('maps every scope key; the inference server is tenant-scoped', () => {
    const r = mapAlertRule({
      ...base, _id: 'r', projectId: 'p', name: 'r',
      scope: { modelKey: 'm', guardrailKey: 'g', ragModuleKey: 'k', mcpServerKey: 's', serverKey: 'srv' },
      channels: [{ target: 'secret@x.com' }],
    });
    expect(pick(r.edges)).toEqual([
      'alert.model:m@scope.modelKey', 'alert.guardrail:g@scope.guardrailKey', 'alert.ragModule:k@scope.ragModuleKey',
      'alert.mcpServer:s@scope.mcpServerKey', 'alert.inferenceServer:srv@scope.serverKey',
    ]);
    expect(JSON.stringify(r.edges)).not.toContain('secret@x.com');
    expect(mapAlertRule({ ...base, _id: 'r', name: 'r' }).edges).toBeUndefined();
  });

  it('an agents rule on selected entities links each agent by tracing name', () => {
    const r = mapAlertRule({
      ...base, _id: 'r', projectId: 'p', name: 'r', module: 'agents', metric: 'agent_error_rate',
      entity: { entityType: 'agent', mode: 'selected', keys: ['Pulse Main', 'Triage'] },
      channels: [{ type: 'slack', sealed: 'SEALED-BLOB', urlHint: 'hooks.slack.com' }],
    });
    expect(pick(r.edges)).toEqual(['alert.agent:Pulse Main@entity.keys', 'alert.agent:Triage@entity.keys']);
    expect(JSON.stringify(r)).not.toContain('SEALED-BLOB');
    expect(r.attributes).toEqual(expect.arrayContaining([
      { key: 'entityMode', value: 'selected' },
      { key: 'entityType', value: 'agent' },
      { key: 'entityCount', value: 2 },
      { key: 'channelTypes', value: 'slack' },
    ]));
  });

  it('an all-entities agents rule, or a selection on another module, adds no agent edge', () => {
    expect(mapAlertRule({
      ...base, _id: 'r', name: 'r', module: 'agents', entity: { entityType: 'agent', mode: 'all' },
    }).edges).toBeUndefined();
    expect(mapAlertRule({
      ...base, _id: 'r', name: 'r', module: 'models', entity: { entityType: 'agent', mode: 'selected', keys: ['x'] },
    }).edges).toBeUndefined();
  });
});
