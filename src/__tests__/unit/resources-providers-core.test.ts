import { describe, expect, it, vi } from 'vitest';
import {
  buildAttributes,
  normalizeProjectId,
  statusFromEnabled,
  toIso,
  toneForStatus,
} from '@/lib/resources/mapping';
import {
  coreResourceTypes,
  extractAgentEdges,
  extractModelEdges,
  mapAgent,
  mapModel,
  mapTool,
} from '@/lib/resources/providers/core';
import type { DatabaseProvider } from '@/lib/database';
import type { ResourceProviderContext } from '@/lib/resources/types';

const SECRET = 'TOP-SECRET-VALUE';

describe('mapping helpers', () => {
  it('normalises every tenant-wide spelling to null', () => {
    for (const v of [null, undefined, '', 'null', 'undefined']) expect(normalizeProjectId(v)).toBeNull();
    expect(normalizeProjectId('p1')).toBe('p1');
    expect(normalizeProjectId({ toString: () => 'oid1' })).toBe('oid1');
  });

  it('toIso handles Date, ISO string, junk and absent', () => {
    expect(toIso(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
    expect(toIso('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(toIso('not a date')).toBeNull();
    expect(toIso(undefined)).toBeNull();
  });

  it('maps status to a tone', () => {
    for (const s of ['active', 'enabled', 'published', 'ready', 'ACTIVE']) expect(toneForStatus(s)).toBe('ok');
    for (const s of ['inactive', 'disabled', 'draft', 'paused']) expect(toneForStatus(s)).toBe('off');
    for (const s of ['error', 'errored', 'failed']) expect(toneForStatus(s)).toBe('warn');
    for (const s of ['running', 'whatever', '', null, undefined]) expect(toneForStatus(s)).toBe('neutral');
    expect(statusFromEnabled(true)).toBe('enabled');
    expect(statusFromEnabled(false)).toBe('disabled');
    expect(statusFromEnabled(undefined)).toBeNull();
  });

  it('buildAttributes keeps primitives only, drops empties and clips long strings', () => {
    const attrs = buildAttributes({
      a: 'x', b: 3, c: false, d: '', e: undefined, f: null, g: { nested: SECRET }, h: [SECRET], i: 'y'.repeat(500), n: Number.NaN,
    });
    expect(attrs.map((a) => a.key)).toEqual(['a', 'b', 'c', 'i']);
    expect(String(attrs[3].value).length).toBeLessThan(200);
    expect(JSON.stringify(attrs)).not.toContain(SECRET);
  });
});

describe('core providers never expose secret fields', () => {
  it('agent', () => {
    const doc = {
      _id: 'a1', tenantId: 't1', projectId: 'p1', key: 'k', name: 'Agent', description: 'd', status: 'active',
      publishedVersion: 2, latestVersion: 3,
      config: {
        kind: 'external', modelKey: 'm', systemPrompt: `prompt ${SECRET}`,
        connection: { apiKeyEnc: SECRET, url: `https://x/${SECRET}` },
        sandbox: { secrets: { A: SECRET }, secretsSealed: SECRET },
        callback: { url: 'https://hooks.example.com', secret: SECRET, secretSealed: SECRET },
        toolBindings: [{}, {}],
      },
      metadata: { schedules: SECRET },
      createdBy: 'u1', updatedBy: 'u2', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: '2026-01-02T00:00:00Z',
    };
    const r = mapAgent(doc);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r).toMatchObject({
      type: 'agent', id: 'a1', key: 'k', projectId: 'p1', status: 'active', statusTone: 'ok', tenantId: 't1',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(r.attributes).toEqual(expect.arrayContaining([
      { key: 'kind', value: 'external' }, { key: 'toolBindingCount', value: 2 }, { key: 'publishedVersion', value: 2 },
    ]));
  });

  it('agent: SQLite-style literal "null" project and draft status', () => {
    const r = mapAgent({ _id: 'a2', projectId: 'null', name: 'x', key: 'k', status: 'draft', config: {} });
    expect(r.projectId).toBeNull();
    expect(r.statusTone).toBe('off');
    expect(r.attributes).toEqual(expect.arrayContaining([{ key: 'kind', value: 'native' }]));
  });

  it('tool, including a tenant-wide row', () => {
    const doc = {
      _id: 't1', tenantId: 'ten', key: 'crm', name: 'CRM', type: 'mcp', status: 'disabled',
      actions: [{ key: 'a', inputSchema: { secret: SECRET } }],
      upstreamAuth: { token: SECRET, headerValue: SECRET, password: SECRET, sealed: SECRET },
      openApiSpec: `{"x":"${SECRET}"}`, mcpEndpoint: `https://m/?token=${SECRET}`, mcpTransport: 'sse',
      upstreamBaseUrl: `https://u/${SECRET}`, metadata: { headers: SECRET }, createdBy: 'u1',
    };
    const r = mapTool(doc);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r).toMatchObject({ projectId: null, status: 'disabled', statusTone: 'off' });
    expect(r.attributes).toEqual([
      { key: 'type', value: 'mcp' }, { key: 'actionCount', value: 1 }, { key: 'mcpTransport', value: 'sse' },
    ]);
    expect(mapTool({ ...doc, projectId: '' }).projectId).toBeNull();
  });

  it('model: no status, settings/replicas/metadata never surfaced', () => {
    const doc = {
      _id: 'm1', tenantId: 'ten', projectId: 'p1', key: 'gpt', name: 'GPT', category: 'llm', providerKey: 'prov',
      providerDriver: 'openai', modelId: 'gpt-x', isMultimodal: true,
      settings: { apiKey: SECRET, dynamic: { rules: SECRET } }, metadata: { x: SECRET },
      replicas: [{ providerKey: 'a', settings: { apiKey: SECRET } }, { providerKey: 'b' }],
      pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 }, createdBy: 'u1',
    };
    const r = mapModel(doc);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r).toMatchObject({ status: null, statusTone: 'neutral', projectId: 'p1' });
    expect(r.attributes).toEqual(expect.arrayContaining([
      { key: 'category', value: 'llm' }, { key: 'providerKey', value: 'prov' }, { key: 'dynamic', value: true }, { key: 'replicaCount', value: 2 },
    ]));
  });
});

describe('core type definitions', () => {
  const db = {
    listAgents: vi.fn().mockResolvedValue([{ _id: 'a1', name: 'A', key: 'k', status: 'active', config: {}, projectId: 'p1' }]),
    listTools: vi.fn().mockResolvedValue([{ _id: 't1', name: 'T', key: 'k', type: 'openapi', status: 'active', actions: [] }]),
    listModels: vi.fn().mockResolvedValue([{ _id: 'm1', name: 'M', key: 'k', category: 'llm' }]),
  };
  const ctx = { db: db as unknown as DatabaseProvider, tenantId: 't', tenantDbName: 'd' } satisfies ResourceProviderContext;

  it('list the whole tenant (no project filter) and expose verified dashboard routes', async () => {
    expect(coreResourceTypes.map((d) => d.type)).toEqual(['agent', 'tool', 'model']);
    for (const d of coreResourceTypes) {
      const rows = await d.list(ctx);
      expect(rows).toHaveLength(1);
      expect(d.detailUrl?.(rows[0])).toMatch(/^\/dashboard\/(agents|agents\/tools|models)\/.+/);
    }
    expect(db.listAgents).toHaveBeenCalledWith();
    expect(db.listTools).toHaveBeenCalledWith();
    expect(db.listModels).toHaveBeenCalledWith();
  });
});

describe('agent edge extraction', () => {
  const pick = (edges: ReturnType<typeof extractAgentEdges>) =>
    (edges ?? []).map((e) => `${e.kind}=${e.target}@${e.field}`);

  it('reads keys exactly where the runtime reads them', () => {
    const edges = extractAgentEdges({
      config: {
        modelKey: 'gpt',
        promptKey: 'sys',
        knowledgeEngineKey: 'kb',
        guardrails: [{ key: 'g1' }, { key: 'g2', hooks: ['input.pre'] }, { key: 'parked', hooks: [] }],
        // authoritative `guardrails`: the legacy slots are ignored
        inputGuardrailKey: 'legacy-in',
        outputGuardrailKey: 'legacy-out',
        toolBindings: [
          { source: 'tool', sourceKey: 'crm', toolNames: ['a'] },
          { source: 'mcp', sourceKey: 'jira', toolNames: ['b'] },
          { source: 'system', sourceKey: 'browser_use', toolNames: [], config: { browserId: 'br-1' } },
          { source: 'system', sourceKey: 'web_search', toolNames: [], config: { providerKey: 'tavily' } },
          { source: 'system', sourceKey: 'web_search', toolNames: [], config: {} },
        ],
        additionalModels: [{ modelKey: 'fast' }, { modelKey: '' }, { modelKey: 'smart', label: 'S' }],
        memory: { enabled: true, memoryStoreKey: 'mem' },
        skills: ['s1', '', 's2'],
        subagents: [
          { kind: 'ref', name: 'r', agentKey: 'other', modelKey: 'ignored-for-ref', toolBindings: [{ source: 'tool', sourceKey: 'ignored' }] },
          {
            kind: 'inline', name: 'i', modelKey: 'small', knowledgeEngineKey: 'kb2',
            toolBindings: [{ source: 'tool', sourceKey: 'st' }, { source: 'mcp', sourceKey: 'sm' }],
          },
          { kind: 'inline', name: 'off', enabled: false, modelKey: 'unused' },
        ],
      },
    });
    expect(pick(edges)).toEqual([
      'agent.model=gpt@config.modelKey',
      'agent.additionalModel=fast@config.additionalModels[0].modelKey',
      'agent.additionalModel=smart@config.additionalModels[2].modelKey',
      'agent.prompt=sys@config.promptKey',
      'agent.knowledge=kb@config.knowledgeEngineKey',
      'agent.guardrail=g1@config.guardrails[0].key',
      'agent.guardrail=g2@config.guardrails[1].key',
      'agent.tool=crm@config.toolBindings[0].sourceKey',
      'agent.mcp=jira@config.toolBindings[1].sourceKey',
      'agent.browser=br-1@config.toolBindings[2].config.browserId',
      'agent.webSearchProvider=tavily@config.toolBindings[3].config.providerKey',
      'agent.memory=mem@config.memory.memoryStoreKey',
      'agent.skill=s1@config.skills[0]',
      'agent.skill=s2@config.skills[2]',
      'agent.subagent=other@config.subagents[0].agentKey',
      // a ref entry's own modelKey overrides the target's (buildAgentSubagents)
      'agent.subagentModel=ignored-for-ref@config.subagents[0].modelKey',
      'agent.subagentModel=small@config.subagents[1].modelKey',
      'agent.subagentKnowledge=kb2@config.subagents[1].knowledgeEngineKey',
      'agent.subagentTool=st@config.subagents[1].toolBindings[0].sourceKey',
      'agent.subagentMcp=sm@config.subagents[1].toolBindings[1].sourceKey',
    ]);
    expect(edges!.find((e) => e.kind === 'agent.browser')).toMatchObject({ toType: 'browser', by: 'id' });
  });

  it('reads the bucket of the session files only while files are switched on (there is no built-in fallback storage)', () => {
    expect(pick(extractAgentEdges({ config: { attachments: { enabled: true, bucketKey: 'agent-docs' } } })))
      .toEqual(['agent.attachmentsBucket=agent-docs@config.attachments.bucketKey']);
    // off (or absent) takes nothing, and a bucket named under "off" is never used
    expect(extractAgentEdges({ config: { attachments: { enabled: false, bucketKey: 'agent-docs' } } })).toBeUndefined();
    expect(extractAgentEdges({ config: { attachments: { bucketKey: 'agent-docs' } } })).toBeUndefined();
    expect(extractAgentEdges({ config: { attachments: { enabled: true } } })).toBeUndefined(); // switched on without a bucket: nothing to point at
    expect(extractAgentEdges({ config: { attachments: { enabled: true, bucketKey: 'agent-docs' } } })![0])
      .toMatchObject({ toType: 'file-bucket', by: 'key' });
  });

  it('falls back to the legacy guardrail slots only when `guardrails` is absent', () => {
    expect(pick(extractAgentEdges({ config: { inputGuardrailKey: 'in', outputGuardrailKey: 'out' } }))).toEqual([
      'agent.guardrail=in@config.inputGuardrailKey',
      'agent.guardrail=out@config.outputGuardrailKey',
    ]);
    expect(extractAgentEdges({ config: { guardrails: [], inputGuardrailKey: 'in' } })).toBeUndefined();
  });

  it('ignores the prompt key when an inline system prompt wins, and disabled memory', () => {
    expect(extractAgentEdges({ config: { systemPrompt: 'hi', promptKey: 'p', memory: { enabled: false, memoryStoreKey: 'm' } } })).toBeUndefined();
  });

  it('tolerates empty and junk configs and dedupes', () => {
    expect(extractAgentEdges({})).toBeUndefined();
    expect(extractAgentEdges({ config: { toolBindings: 'x', subagents: [null, 3], skills: 'a', guardrails: [null] } })).toBeUndefined();
    const dup = extractAgentEdges({ config: { modelKey: 'm', toolBindings: [{ source: 'tool', sourceKey: 'a' }, { source: 'tool', sourceKey: 'a' }] } });
    expect(dup).toHaveLength(3);
  });

  it('carries edges on the mapped record but never in attributes, and no secret', () => {
    const r = mapAgent({
      _id: 'a1', projectId: 'p1', key: 'k', name: 'A', config: { modelKey: 'gpt', connection: { apiKeyEnc: SECRET } },
    });
    expect(r.edges).toEqual([{ kind: 'agent.model', toType: 'model', by: 'key', target: 'gpt', field: 'config.modelKey' }]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(mapAgent({ _id: 'a2', name: 'x', config: {} }).edges).toBeUndefined();
  });
});

describe('model edge extraction', () => {
  const pick = (edges: ReturnType<typeof extractModelEdges>) =>
    (edges ?? []).map((e) => `${e.kind}=${e.target}${e.qualifier ? `#${e.qualifier}` : ''}@${e.field}`);

  it('provider, enabled replicas, guardrails and the semantic cache', () => {
    const edges = extractModelEdges({
      providerKey: 'openai',
      replicas: [{ providerKey: 'azure' }, { providerKey: 'off', enabled: false }, { providerKey: '' }, { providerKey: 'bedrock', enabled: true }],
      guardrails: [{ key: 'g' }],
      semanticCache: { enabled: true, embeddingModelKey: 'emb', vectorProviderKey: 'qdrant', vectorIndexKey: 'cache' },
    });
    expect(pick(edges)).toEqual([
      'model.provider=openai@providerKey',
      'model.replicaProvider=azure@replicas[0].providerKey',
      'model.replicaProvider=bedrock@replicas[3].providerKey',
      'model.guardrail=g@guardrails[0].key',
      'model.semanticCacheModel=emb@semanticCache.embeddingModelKey',
      'model.semanticCacheIndex=cache#qdrant@semanticCache.vectorIndexKey',
    ]);
  });

  it('a chat model with an enabled replica does not use its top-level provider; other categories do', () => {
    const replicas = [{ providerKey: 'azure' }];
    expect(pick(extractModelEdges({ category: 'llm', providerKey: 'stale', replicas })))
      .toEqual(['model.replicaProvider=azure@replicas[0].providerKey']);
    // all replicas disabled: the pool falls back to providerKey
    expect(pick(extractModelEdges({ category: 'llm', providerKey: 'p', replicas: [{ providerKey: 'azure', enabled: false }] })))
      .toEqual(['model.provider=p@providerKey']);
    // embedding/tts/... call providerKey directly
    expect(pick(extractModelEdges({ category: 'embedding', providerKey: 'p', replicas })))
      .toEqual(['model.provider=p@providerKey', 'model.replicaProvider=azure@replicas[0].providerKey']);
  });

  it('legacy guardrail slots and a disabled semantic cache', () => {
    const edges = extractModelEdges({
      providerKey: 'p', inputGuardrailKey: 'in', semanticCache: { enabled: false, embeddingModelKey: 'emb' },
    });
    expect(pick(edges)).toEqual(['model.provider=p@providerKey', 'model.guardrail=in@inputGuardrailKey']);
  });

  it('a Dynamic LLM model has no provider row; every routing target is a model edge', () => {
    const edges = extractModelEdges({
      providerKey: 'dynamic',
      settings: {
        dynamic: {
          strategy: 'model-based',
          defaultModelKey: 'd',
          fallbackModelKey: 'fb',
          baselineModelKey: 'base',
          defaultTarget: { pool: [{ modelKey: 'pa' }, { modelKey: 'pb' }] },
          rules: [{ label: 'r', targetModelKey: 'rt' }, { label: 'r2', target: { modelKey: 'rt2' } }],
          decider: { modelKey: 'clf', labels: [{ label: 'l', targetModelKey: 'lt' }, { label: 'l2', target: { pool: [{ modelKey: 'lp' }] } }] },
          guards: { economyModelKey: 'eco' },
        },
      },
    });
    expect(pick(edges)).toEqual([
      'model.dynamicModel=d@settings.dynamic.defaultModelKey',
      'model.dynamicModel=fb@settings.dynamic.fallbackModelKey',
      'model.dynamicModel=base@settings.dynamic.baselineModelKey',
      'model.dynamicModel=pa@settings.dynamic.defaultTarget.pool[0].modelKey',
      'model.dynamicModel=pb@settings.dynamic.defaultTarget.pool[1].modelKey',
      'model.dynamicModel=rt@settings.dynamic.rules[0].targetModelKey',
      'model.dynamicModel=rt2@settings.dynamic.rules[1].target.modelKey',
      'model.dynamicModel=clf@settings.dynamic.decider.modelKey',
      'model.dynamicModel=lt@settings.dynamic.decider.labels[0].targetModelKey',
      'model.dynamicModel=lp@settings.dynamic.decider.labels[1].target.pool[0].modelKey',
      'model.dynamicModel=eco@settings.dynamic.guards.economyModelKey',
    ]);
    expect(edges!.some((e) => e.kind === 'model.provider')).toBe(false);
  });

  it('never copies settings / credentials into the edges', () => {
    const r = mapModel({ _id: 'm', key: 'k', name: 'M', providerKey: 'prov', settings: { apiKey: SECRET }, replicas: [{ providerKey: 'x', settings: { apiKey: SECRET } }] });
    expect(JSON.stringify(r.edges)).not.toContain(SECRET);
  });

  it('tools carry no edges', () => {
    expect(mapTool({ _id: 't', key: 'k', name: 'T', type: 'mcp' }).edges).toBeUndefined();
  });
});
