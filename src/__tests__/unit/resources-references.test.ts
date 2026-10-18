import { describe, expect, it } from 'vitest';
import { MAX_USED_BY, buildResourceGraph } from '@/lib/resources/graph';
import { HEALTH_ISSUE_KINDS } from '@/lib/resources/health';
import {
  EDGE_KINDS,
  MAX_EDGES_PER_RECORD,
  MAX_EDGE_TEXT_LENGTH,
  buildResolutionIndex,
  createEdgeCollector,
  resolveEdge,
} from '@/lib/resources/references';
import { communityResourceTypes } from '@/lib/resources/providers';
import type { ResourceEdgeInput, ResourceRecord } from '@/lib/resources/types';

function rec(over: Partial<ResourceRecord> & { type: string; id: string }): ResourceRecord {
  return {
    key: over.id,
    name: over.id,
    description: null,
    projectId: null,
    status: null,
    statusTone: 'neutral',
    createdBy: null,
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
    attributes: [],
    ...over,
  };
}

const edge = (kind: string, target: string, over: Partial<ResourceEdgeInput> = {}): ResourceEdgeInput => {
  const def = EDGE_KINDS[kind];
  return { kind, toType: def.toType, by: def.by, target, field: 'f', ...over };
};

function resolve(from: ResourceRecord, e: ResourceEdgeInput, others: ResourceRecord[]) {
  return resolveEdge(buildResolutionIndex([from, ...others]), from, e)!;
}

const agentIn = (projectId: string | null) => rec({ type: 'agent', id: 'a', key: 'a', projectId });
const tool = (id: string, projectId: string | null, over: Partial<ResourceRecord> = {}) =>
  rec({ type: 'tool', id, key: 'crm', projectId, status: 'active', statusTone: 'ok', ...over });

// Enterprise types a community referrer may point at: registered only by the overlay.
const ENTERPRISE_TARGET_TYPES = new Set(['sandbox-template']);

describe('edge kind registry', () => {
  const typeIds = new Set(communityResourceTypes.map((d) => d.type));

  it('only references registered resource types (or an enterprise target type)', () => {
    for (const def of Object.values(EDGE_KINDS)) {
      expect(typeIds.has(def.fromType), `${def.kind} fromType`).toBe(true);
      expect(typeIds.has(def.toType) || ENTERPRISE_TARGET_TYPES.has(def.toType), `${def.kind} toType`).toBe(true);
    }
  });

  it('defines every kind of the spec with the agreed severity', () => {
    const errors = [
      'agent.model', 'agent.additionalModel', 'agent.prompt', 'agent.guardrail', 'model.provider', 'model.guardrail', 'model.dynamicModel',
      'rag.embeddingModel', 'rag.vectorIndex', 'memory.embeddingModel', 'memory.vectorIndex', 'mcp.guardrail',
      'guardrail.model', 'guardrail.wordList',
      // degraded policy + failMode 'open' = unscanned traffic (safety control lost)
      'guardrail.piiPolicy',
      // resolveTemplateIdByKey throws "Sandbox template not found" on the first sandbox call
      'agent.sandboxTemplate', 'mcp.sandboxTemplate',
    ];
    const warnings = [
      'agent.tool', 'agent.mcp', 'agent.knowledge', 'agent.subagent', 'agent.subagentModel', 'agent.subagentKnowledge',
      'agent.subagentTool', 'agent.subagentMcp', 'agent.memory', 'agent.skill', 'agent.browser', 'agent.webSearchProvider', 'agent.attachmentsBucket',
      'model.replicaProvider', 'model.semanticCacheModel', 'model.semanticCacheIndex', 'rag.reranker', 'rag.fileBucket',
      'reranker.model', 'crawler.ragModule', 'mcp.compositeMember',
    ];
    for (const k of errors) expect(EDGE_KINDS[k]?.severity, k).toBe('error');
    for (const k of warnings) expect(EDGE_KINDS[k]?.severity, k).toBe('warning');
    for (const prefix of ['evaluation.', 'redteam.', 'analysis.', 'alert.']) {
      const group = Object.values(EDGE_KINDS).filter((d) => d.kind.startsWith(prefix));
      expect(group.length, prefix).toBeGreaterThan(0);
      for (const d of group) expect(d.severity, d.kind).toBe('warning');
    }
  });
});

describe('createEdgeCollector', () => {
  it('fills toType/by from the registry, skips empties and dedupes', () => {
    const c = createEdgeCollector('agent');
    c.add('agent.model', 'gpt', 'config.modelKey');
    c.add('agent.model', 'gpt', 'config.modelKey');
    c.add('agent.model', '  ', 'config.modelKey');
    c.add('agent.model', undefined, 'config.modelKey');
    // non-strings are malformed fields, never "42" / "[object Object]" targets
    c.add('agent.model', 42, 'config.modelKey');
    c.add('agent.model', { a: 1 }, 'config.modelKey');
    c.add('agent.model', ['x', 'y'], 'config.modelKey');
    c.add('agent.model', 'gpt', 'config.other');
    const edges = c.done()!;
    expect(edges).toEqual([
      { kind: 'agent.model', toType: 'model', by: 'key', target: 'gpt', field: 'config.modelKey' },
      { kind: 'agent.model', toType: 'model', by: 'key', target: 'gpt', field: 'config.other' },
    ]);
  });

  it('bounds an oversized document: per-record edge cap, no over-long target / qualifier, clipped field', () => {
    const c = createEdgeCollector('agent');
    for (let i = 0; i < 10_000; i++) c.add('agent.skill', `skill-${i}`, `config.skills[${i}]`);
    expect(c.done()!).toHaveLength(MAX_EDGES_PER_RECORD);

    const d = createEdgeCollector('agent');
    d.add('agent.skill', 'x'.repeat(MAX_EDGE_TEXT_LENGTH + 1), 'f');
    expect(d.done()).toBeUndefined();
    const m = createEdgeCollector('model');
    m.add('model.semanticCacheIndex', 'idx', 'f', { qualifier: 'q'.repeat(MAX_EDGE_TEXT_LENGTH + 1) });
    expect(m.done()).toBeUndefined();
    const f = createEdgeCollector('agent');
    f.add('agent.skill', 'ok', `config.${'k'.repeat(1000)}`);
    expect(f.done()![0].field.length).toBe(MAX_EDGE_TEXT_LENGTH);
  });

  it('returns undefined when nothing was added and rejects unknown / foreign kinds', () => {
    expect(createEdgeCollector('agent').done()).toBeUndefined();
    expect(() => createEdgeCollector('agent').add('nope', 'x', 'f')).toThrow(/Unknown/);
    expect(() => createEdgeCollector('model').add('agent.model', 'x', 'f')).toThrow(/belongs to/);
  });

  it('keeps a qualifier', () => {
    const c = createEdgeCollector('model');
    c.add('model.semanticCacheIndex', 'idx', 'f', { qualifier: 'qdrant' });
    expect(c.done()![0].qualifier).toBe('qdrant');
  });
});

describe('resolution per scope rule', () => {
  describe('project-then-tenant (agent.tool)', () => {
    const e = edge('agent.tool', 'crm');
    it('prefers the own-project row over the tenant-wide one', () => {
      const own = tool('own', 'p1');
      const r = resolve(agentIn('p1'), e, [own, tool('wide', null)]);
      expect(r.status).toBe('ok');
      expect(r.matches).toEqual([own]);
    });
    it('falls back to the tenant-wide row', () => {
      const wide = tool('wide', null);
      const r = resolve(agentIn('p1'), e, [wide, tool('other', 'p2')]);
      expect(r.status).toBe('ok');
      expect(r.matches).toEqual([wide]);
    });
    it('never reaches another project: cross-project', () => {
      const r = resolve(agentIn('p1'), e, [tool('other', 'p2')]);
      expect(r.status).toBe('cross-project');
      expect(r.candidates.map((c) => c.id)).toEqual(['other']);
    });
    it('two rows with the key in the own project: ambiguous (even with a tenant-wide one)', () => {
      const r = resolve(agentIn('p1'), e, [tool('a', 'p1'), tool('b', 'p1'), tool('wide', null)]);
      expect(r.status).toBe('ambiguous');
      expect(r.matches.map((m) => m.id).sort()).toEqual(['a', 'b']);
    });
    it('a tenant-wide referrer matches tenant-wide rows only', () => {
      expect(resolve(agentIn(null), e, [tool('own', 'p1')]).status).toBe('cross-project');
      expect(resolve(agentIn(null), e, [tool('wide', null)]).status).toBe('ok');
    });
    it('no row at all: missing', () => {
      expect(resolve(agentIn('p1'), e, []).status).toBe('missing');
    });
    it('a disabled tool is inactive (the runtime skips it)', () => {
      const r = resolve(agentIn('p1'), e, [tool('t', 'p1', { status: 'disabled', statusTone: 'off' })]);
      expect(r.status).toBe('inactive');
    });
  });

  describe('runtime lookups without a tenant-wide fallback', () => {
    const ragIn = (projectId: string | null) => rec({ type: 'rag-module', id: 'r', key: 'r', projectId });
    const reranker = (projectId: string | null) => rec({ type: 'reranker', id: 'rr', key: 'rr', projectId, status: 'active', statusTone: 'ok' });
    const pii = (projectId: string | null) => rec({ type: 'pii-policy', id: 'pp', key: 'pp', projectId, status: 'enabled', statusTone: 'ok' });
    const guardrailIn = (projectId: string | null) => rec({ type: 'guardrail', id: 'g', key: 'g', projectId });

    it('rag.reranker: a project module does not see a tenant-wide reranker; a tenant-wide module resolves in the caller project', () => {
      const e = edge('rag.reranker', 'rr');
      expect(resolve(ragIn('p1'), e, [reranker(null)]).status).toBe('cross-project');
      expect(resolve(ragIn('p1'), e, [reranker('p1')]).status).toBe('ok');
      expect(resolve(ragIn(null), e, [reranker('p1')]).status).toBe('ok');
    });
    it('crawler.ragModule: ingestion looks the module up in the crawler project only', () => {
      const e = edge('crawler.ragModule', 'r');
      const crawler = rec({ type: 'crawler', id: 'c', key: 'c', projectId: 'p1' });
      expect(resolve(crawler, e, [ragIn(null)]).status).toBe('cross-project');
      expect(resolve(crawler, e, [ragIn('p1')]).status).toBe('ok');
      expect(resolve(crawler, e, [rec({ type: 'rag-module', id: 'r', key: 'r', projectId: 'p1', status: 'disabled', statusTone: 'off' })]).status).toBe('inactive');
    });
    it('guardrail.piiPolicy: strict project lookup, error severity', () => {
      const e = edge('guardrail.piiPolicy', 'pp');
      expect(resolve(guardrailIn('p1'), e, [pii(null)]).status).toBe('cross-project');
      expect(resolve(guardrailIn('p1'), e, [pii('p1')]).status).toBe('ok');
      expect(resolve(guardrailIn(null), e, [pii('p1')]).status).toBe('ok');
      expect(EDGE_KINDS['guardrail.piiPolicy'].severity).toBe('error');
    });
    it('agent.subagent: a draft/inactive target agent is skipped by the run, so it is inactive', () => {
      const e = edge('agent.subagent', 'sub');
      const sub = (status: string, statusTone: ResourceRecord['statusTone']) =>
        rec({ type: 'agent', id: 's', key: 'sub', projectId: 'p1', status, statusTone });
      expect(resolve(agentIn('p1'), e, [sub('draft', 'off')]).status).toBe('inactive');
      expect(resolve(agentIn('p1'), e, [sub('inactive', 'off')]).status).toBe('inactive');
      expect(resolve(agentIn('p1'), e, [sub('active', 'ok')]).status).toBe('ok');
      expect(EDGE_KINDS['agent.subagent'].severity).toBe('warning');
    });
  });

  describe('targets the runtime accepts only when status === active', () => {
    it('agent.memory: a store in error state is inactive', () => {
      const e = edge('agent.memory', 'mem');
      const store = (status: string, statusTone: ResourceRecord['statusTone']) =>
        rec({ type: 'memory-store', id: 'm', key: 'mem', projectId: 'p1', status, statusTone });
      expect(resolve(agentIn('p1'), e, [store('error', 'warn')]).status).toBe('inactive');
      expect(resolve(agentIn('p1'), e, [store('inactive', 'off')]).status).toBe('inactive');
      expect(resolve(agentIn('p1'), e, [store('active', 'ok')]).status).toBe('ok');
    });
    it('agent.webSearchProvider: errored or non-websearch providers are broken', () => {
      const e = edge('agent.webSearchProvider', 'tavily');
      const provider = (type: string, status: string, tone: ResourceRecord['statusTone']) =>
        rec({
          type: 'provider', id: 'pv', key: 'tavily', projectId: 'p1', status, statusTone: tone,
          attributes: [{ key: 'type', value: type }],
        });
      expect(resolve(agentIn('p1'), e, [provider('websearch', 'errored', 'warn')]).status).toBe('inactive');
      expect(resolve(agentIn('p1'), e, [provider('websearch', 'active', 'ok')]).status).toBe('ok');
      expect(resolve(agentIn('p1'), e, [provider('model', 'active', 'ok')]).status).toBe('missing');
    });
  });

  describe('strict-project (agent.model)', () => {
    const e = edge('agent.model', 'gpt');
    const model = (id: string, projectId: string | null) => rec({ type: 'model', id, key: 'gpt', projectId });
    it('own project only: a tenant-wide model does NOT satisfy a project agent', () => {
      expect(resolve(agentIn('p1'), e, [model('m', 'p1')]).status).toBe('ok');
      expect(resolve(agentIn('p1'), e, [model('m', null)]).status).toBe('cross-project');
      expect(resolve(agentIn('p1'), e, [model('m', 'p2')]).status).toBe('cross-project');
    });
    it('models have no status, so they are never inactive', () => {
      expect(resolve(agentIn('p1'), e, [model('m', 'p1')]).status).toBe('ok');
    });
  });

  describe('caller-scoped kinds with a tenant-wide referrer (rag.embeddingModel)', () => {
    const e = edge('rag.embeddingModel', 'emb');
    const wideRag = rec({ type: 'rag-module', id: 'r', key: 'r', projectId: null });
    const model = (id: string, projectId: string | null) => rec({ type: 'model', id, key: 'emb', projectId });
    it('resolves in the caller project, so any row of the key is ok (even several)', () => {
      expect(resolve(wideRag, e, [model('a', 'p1')]).status).toBe('ok');
      expect(resolve(wideRag, e, [model('a', 'p1'), model('b', 'p2')]).status).toBe('ok');
      expect(resolve(wideRag, e, []).status).toBe('missing');
    });
    it('a project referrer is strict again', () => {
      const projectRag = rec({ type: 'rag-module', id: 'r2', key: 'r2', projectId: 'p1' });
      expect(resolve(projectRag, e, [model('a', 'p2')]).status).toBe('cross-project');
    });
  });

  describe('provider-assignment (model.provider)', () => {
    const e = edge('model.provider', 'openai');
    const modelIn = rec({ type: 'model', id: 'm', key: 'm', projectId: 'p1' });
    const provider = (over: Partial<ResourceRecord>) => rec({ type: 'provider', id: 'pr', key: 'openai', ...over });
    it('ok when assigned through projectId or projectIds', () => {
      expect(resolve(modelIn, e, [provider({ projectId: 'p1' })]).status).toBe('ok');
      expect(resolve(modelIn, e, [provider({ projectId: 'p2', projectIds: ['p2', 'p1'] })]).status).toBe('ok');
    });
    it('exists but is not assigned to the project: cross-project', () => {
      expect(resolve(modelIn, e, [provider({ projectId: 'p2' })]).status).toBe('cross-project');
      expect(resolve(modelIn, e, [provider({ projectId: null })]).status).toBe('cross-project');
    });
    it('a disabled provider is not skipped by the runtime', () => {
      expect(resolve(modelIn, e, [provider({ projectId: 'p1', status: 'disabled', statusTone: 'off' })]).status).toBe('ok');
    });
  });

  describe('same-project-id (mcp.compositeMember)', () => {
    const e = edge('mcp.compositeMember', 'srv-1');
    const composite = rec({ type: 'mcp-server', id: 'c', key: 'c', projectId: 'p1' });
    it('resolves by id inside the same project only', () => {
      expect(resolve(composite, e, [rec({ type: 'mcp-server', id: 'srv-1', key: 'x', projectId: 'p1', status: 'active', statusTone: 'ok' })]).status).toBe('ok');
      expect(resolve(composite, e, [rec({ type: 'mcp-server', id: 'srv-1', key: 'x', projectId: 'p2' })]).status).toBe('cross-project');
      expect(resolve(composite, e, []).status).toBe('missing');
    });
    it('an inactive member is inactive', () => {
      const r = resolve(composite, e, [rec({ type: 'mcp-server', id: 'srv-1', projectId: 'p1', status: 'disabled', statusTone: 'off' })]);
      expect(r.status).toBe('inactive');
    });
  });

  describe('alert.agent (tracing name, strict project, warning)', () => {
    const rule = (projectId: string | null) => rec({ type: 'alert-rule', id: 'al', key: 'al', projectId });
    it('resolves an agent of the rule project and flags a traced-only name as unresolved or cross-project', () => {
      const e = edge('alert.agent', 'Pulse Main');
      const agent = (projectId: string | null) => rec({ type: 'agent', id: 'a', key: 'Pulse Main', projectId });
      expect(resolve(rule('p1'), e, [agent('p1')]).status).toBe('ok');
      expect(resolve(rule('p1'), e, [agent('p2')]).status).toBe('cross-project');
      expect(resolve(rule('p1'), e, []).status).toBe('missing');
      expect(EDGE_KINDS['alert.agent'].severity).toBe('warning');
    });
  });

  describe('tenant (alert.inferenceServer)', () => {
    it('any row of the tenant', () => {
      const alert = rec({ type: 'alert-rule', id: 'al', key: 'al', projectId: 'p1' });
      const server = rec({ type: 'inference-server', id: 's', key: 'gpu' });
      expect(resolve(alert, edge('alert.inferenceServer', 'gpu'), [server]).status).toBe('ok');
    });
  });

  describe('agent.browser (id, with key fallback)', () => {
    const browser = rec({ type: 'browser', id: 'b-id', key: 'main', projectId: 'p1', status: 'active', statusTone: 'ok' });
    it('accepts an id or a key', () => {
      expect(resolve(agentIn('p1'), edge('agent.browser', 'b-id'), [browser]).status).toBe('ok');
      expect(resolve(agentIn('p1'), edge('agent.browser', 'main'), [browser]).status).toBe('ok');
      expect(resolve(agentIn('p1'), edge('agent.browser', 'nope'), [browser]).status).toBe('missing');
    });
  });

  describe('qualifier (vector index = providerKey + key)', () => {
    const e = edge('rag.vectorIndex', 'idx', { qualifier: 'qdrant' });
    const rag = rec({ type: 'rag-module', id: 'r', key: 'r', projectId: 'p1' });
    const index = (id: string, providerKey: string) =>
      rec({ type: 'vector-index', id, key: 'idx', projectId: 'p1', attributes: [{ key: 'providerKey', value: providerKey }] });
    it('only the index of that provider counts', () => {
      expect(resolve(rag, e, [index('a', 'qdrant'), index('b', 'pinecone')]).matches.map((m) => m.id)).toEqual(['a']);
      // Same key under another vector provider is a different index: it does not exist for this reference.
      expect(resolve(rag, e, [index('b', 'pinecone')]).status).toBe('missing');
      const elsewhere = rec({ type: 'vector-index', id: 'c', key: 'idx', projectId: 'p2', attributes: [{ key: 'providerKey', value: 'qdrant' }] });
      expect(resolve(rag, e, [elsewhere]).status).toBe('cross-project');
    });
  });
});

describe('reference graph', () => {
  const projects = [{ id: 'p1', name: 'Corporate' }, { id: 'p2', name: 'Retail' }];
  const build = (records: ResourceRecord[]) => buildResourceGraph({ tenantId: 't1', records, projects });
  const agent = (id: string, projectId: string | null, edges: ResourceEdgeInput[]) =>
    rec({ type: 'agent', id, key: id, name: `Agent ${id}`, projectId, edges });

  it('indexes uses and used-by, with the target as the other side', () => {
    const t = tool('t1', 'p1');
    const a = agent('a1', 'p1', [edge('agent.tool', 'crm', { field: 'config.toolBindings[0].sourceKey' })]);
    const g = build([a, t]);
    const [use] = g.usesOf('agent', 'a1');
    expect(use).toMatchObject({
      kind: 'agent.tool', direction: 'out', status: 'ok', severity: null,
      field: 'config.toolBindings[0].sourceKey',
      other: { type: 'tool', id: 't1', key: 'crm', projectId: 'p1', projectName: 'Corporate', crn: 'crn:cpr:t1:p1:tool/t1' },
    });
    const { edges: usedBy } = g.usedByOf('tool', 't1');
    expect(usedBy).toHaveLength(1);
    expect(usedBy[0]).toMatchObject({
      direction: 'in', status: 'ok', other: { type: 'agent', id: 'a1', name: 'Agent a1' },
    });
    expect(g.issues).toEqual([]);
  });

  it('a missing target is a bare type + key and creates no incoming edge', () => {
    const g = build([agent('a1', 'p1', [edge('agent.tool', 'ghost')])]);
    const [use] = g.usesOf('agent', 'a1');
    expect(use).toMatchObject({
      status: 'missing', severity: 'warning',
      other: { type: 'tool', id: null, key: 'ghost', name: null, projectId: null, crn: null },
    });
    expect(use.candidates).toBeUndefined();
  });

  it('a cross-project edge also shows up under the other-project candidate', () => {
    const retailOnly = tool('t-retail', 'p2');
    const g = build([agent('a1', 'p1', [edge('agent.tool', 'crm')]), retailOnly]);
    const [use] = g.usesOf('agent', 'a1');
    expect(use.status).toBe('cross-project');
    expect(use.candidates!.map((c) => [c.id, c.projectName])).toEqual([['t-retail', 'Retail']]);
    const { edges } = g.usedByOf('tool', 't-retail');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ status: 'cross-project', severity: 'warning', other: { id: 'a1' } });
  });

  it('an ambiguous edge is indexed under every match and lists them as candidates', () => {
    const g = build([agent('a1', 'p1', [edge('agent.tool', 'crm')]), tool('x', 'p1'), tool('y', 'p1')]);
    expect(g.usesOf('agent', 'a1')[0]).toMatchObject({ status: 'ambiguous' });
    expect(g.usesOf('agent', 'a1')[0].candidates).toHaveLength(2);
    for (const id of ['x', 'y']) expect(g.usedByOf('tool', id).edges[0].status).toBe('ambiguous');
  });

  it('takes edges from edgesOf when the records were stripped', () => {
    const a = agent('a1', 'p1', []);
    const stripped = { ...a, edges: undefined };
    const g = buildResourceGraph({
      tenantId: 't1', projects, records: [stripped, tool('t1', 'p1')],
      edgesOf: new Map([[stripped, [edge('agent.tool', 'crm')]]]),
    });
    expect(g.usesOf('agent', 'a1')[0].status).toBe('ok');
    expect(g.usedByOf('tool', 't1').edges).toHaveLength(1);
  });

  it('caps candidates at 10', () => {
    const many = Array.from({ length: 15 }, (_, i) => tool(`t${i}`, 'p1'));
    const g = build([agent('a1', 'p1', [edge('agent.tool', 'crm')]), ...many]);
    expect(g.usesOf('agent', 'a1')[0].candidates).toHaveLength(10);
  });

  it('caps used-by and says so', () => {
    const referrers = Array.from({ length: MAX_USED_BY + 1 }, (_, i) => agent(`a${i}`, 'p1', [edge('agent.tool', 'crm')]));
    const g = build([tool('t', 'p1'), ...referrers]);
    const usedBy = g.usedByOf('tool', 't');
    expect(usedBy.edges).toHaveLength(MAX_USED_BY);
    expect(usedBy.truncated).toBe(true);
    expect(g.usedByOf('agent', 'a0')).toEqual({ edges: [], truncated: false });
  });

  describe('health', () => {
    it('one issue per broken edge with the kind severity', () => {
      const g = build([
        agent('a1', 'p1', [
          edge('agent.model', 'gone', { field: 'config.modelKey' }),
          edge('agent.tool', 'crm', { field: 'config.toolBindings[0].sourceKey' }),
          edge('agent.guardrail', 'g1'),
        ]),
        tool('t-retail', 'p2'),
        rec({ type: 'guardrail', id: 'g1', key: 'g1', projectId: 'p1', status: 'disabled', statusTone: 'off' }),
      ]);
      const byKind = Object.fromEntries(g.issues.map((i) => [`${i.kind}:${i.edgeKind}`, i]));
      expect(byKind['broken-reference:agent.model']).toMatchObject({
        severity: 'error', field: 'config.modelKey', targetType: 'model', targetKey: 'gone',
        resource: { type: 'agent', id: 'a1' },
      });
      expect(byKind['cross-project-reference:agent.tool']).toMatchObject({
        severity: 'warning', related: [expect.objectContaining({ id: 't-retail' })],
      });
      expect(byKind['inactive-reference:agent.guardrail']).toMatchObject({ severity: 'error' });
      // errors first
      expect(g.issues.map((i) => i.severity)).toEqual(['error', 'error', 'warning']);
      expect(g.issueSummaryOf('agent', 'a1')).toEqual({ count: 3, severity: 'error' });
      expect(g.issueSummaryOf('tool', 't-retail')).toEqual({ count: 0, severity: null });
    });

    it('ids are stable across rebuilds and distinct per finding', () => {
      const records = () => [agent('a1', 'p1', [edge('agent.model', 'gone'), edge('agent.prompt', 'gone')])];
      const a = build(records()).issues.map((i) => i.id);
      const b = build(records()).issues.map((i) => i.id);
      expect(a).toEqual(b);
      expect(new Set(a).size).toBe(2);
    });

    it('duplicate-key: same type + scope + key, per row, with the others as related', () => {
      const g = build([
        tool('a', 'p1'), tool('b', 'p1'),
        tool('c', null), // tenant-wide twin of a project row is the intended fallback
        tool('d', 'p2'),
      ]);
      const dups = g.issues.filter((i) => i.kind === 'duplicate-key');
      expect(dups.map((i) => i.resource.id).sort()).toEqual(['a', 'b']);
      expect(dups[0]).toMatchObject({ severity: 'warning', targetKey: 'crm' });
      expect(dups.find((i) => i.resource.id === 'a')!.related!.map((r) => r.id)).toEqual(['b']);
    });

    it('duplicate-key: a huge group stays bounded (related capped, linear work)', () => {
      const rows = Array.from({ length: 2000 }, (_, i) => tool(`d${i}`, 'p1'));
      const started = Date.now();
      const g = build(rows);
      const dups = g.issues.filter((i) => i.kind === 'duplicate-key');
      expect(dups).toHaveLength(2000);
      for (const d of dups) {
        expect(d.related!.length).toBeLessThanOrEqual(10);
        expect(d.related!.some((r) => r.id === d.resource.id)).toBe(false);
      }
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('duplicate-key tells vector indexes of different providers apart', () => {
      const index = (id: string, providerKey: string) =>
        rec({ type: 'vector-index', id, key: 'main', projectId: 'p1', attributes: [{ key: 'providerKey', value: providerKey }] });
      expect(build([index('a', 'qdrant'), index('b', 'pinecone')]).issues).toEqual([]);
      expect(build([index('a', 'qdrant'), index('b', 'qdrant')]).issues).toHaveLength(2);
    });

    it('mcp-dual-registration: an mcp tool and an mcp server with the same key in the same scope', () => {
      const mcpTool = tool('t', 'p1', { key: 'jira', attributes: [{ key: 'type', value: 'mcp' }] });
      const server = rec({ type: 'mcp-server', id: 's', key: 'jira', projectId: 'p1' });
      const otherScope = rec({ type: 'mcp-server', id: 's2', key: 'jira', projectId: 'p2' });
      const openapiTool = tool('o', 'p1', { key: 'jira2', attributes: [{ key: 'type', value: 'openapi' }] });
      const issues = build([mcpTool, server, otherScope, openapiTool, rec({ type: 'mcp-server', id: 's3', key: 'jira2', projectId: 'p1' })]).issues;
      expect(issues.map((i) => [i.kind, i.resource.type]).sort()).toEqual([
        ['mcp-dual-registration', 'mcp-server'],
        ['mcp-dual-registration', 'tool'],
      ]);
      expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    });

    it('reproduces the four seeded local problems', () => {
      const records = [
        // 1. agent in Corporate bound to a tool key that only exists in Retail
        agent('agent-corp', 'p1', [edge('agent.tool', 'retail-crm', { field: 'config.toolBindings[0].sourceKey' })]),
        tool('retail-crm', 'p2', { key: 'retail-crm' }),
        // 2. two tools with the same key in one project
        tool('dup-1', 'p1', { key: 'dup-key' }),
        tool('dup-2', 'p1', { key: 'dup-key' }),
        // 3. agent bound to a key that exists nowhere
        agent('agent-ghost', 'p1', [edge('agent.tool', 'nowhere', { field: 'config.toolBindings[0].sourceKey' })]),
        // 4. MCP registered both as a tool and as an MCP server
        tool('mcp-tool', 'p1', { key: 'github', attributes: [{ key: 'type', value: 'mcp' }] }),
        rec({ type: 'mcp-server', id: 'mcp-srv', key: 'github', projectId: 'p1' }),
      ];
      const g = build(records);
      const found = g.issues.map((i) => `${i.kind}|${i.resource.id}`).sort();
      expect(found).toEqual([
        'broken-reference|agent-ghost',
        'cross-project-reference|agent-corp',
        'duplicate-key|dup-1',
        'duplicate-key|dup-2',
        'mcp-dual-registration|mcp-srv',
        'mcp-dual-registration|mcp-tool',
      ]);
      expect(new Set(g.issues.map((i) => i.kind))).toEqual(new Set([
        'broken-reference', 'cross-project-reference', 'duplicate-key', 'mcp-dual-registration',
      ]));
      for (const kind of g.issues.map((i) => i.kind)) expect(HEALTH_ISSUE_KINDS).toContain(kind);
    });

    it('unknown edge kinds are ignored instead of throwing', () => {
      const g = build([agent('a1', 'p1', [{ kind: 'nope', toType: 'x', by: 'key', target: 't', field: 'f' }])]);
      expect(g.issues).toEqual([]);
      expect(g.usesOf('agent', 'a1')).toEqual([]);
    });
  });
});

// Edge kinds and type ids the enterprise overlay contributes; their labels live in the community messages.
const ENTERPRISE_EDGE_KINDS = [
  'mcpHub.server', 'realtime.chatModel', 'realtime.sttModel', 'realtime.ttsModel', 'realtime.agent',
  'appgw.model', 'appgw.guardrail', 'sandbox.volumeBucket', 'portal.agent',
];
const ENTERPRISE_TYPES = [
  'sandbox-template', 'sandbox-volume', 'mcp-hub', 'gpu-host', 'gpu-pool', 'realtime-model', 'ai-app-gateway', 'prompt-optimizer', 'portal',
];

describe('i18n coverage of the registry', () => {
  it('every edge kind has a label in en and tr (exact or family)', async () => {
    const { en } = await import('@/lib/i18n/messages/en');
    const { tr } = await import('@/lib/i18n/messages/tr');
    for (const [name, messages] of [['en', en], ['tr', tr]] as const) {
      const labels = (messages as any).resources.edgeKinds as Record<string, string>;
      for (const kind of Object.keys(EDGE_KINDS)) {
        expect(labels[kind] ?? labels[kind.split('.')[0]], `${name}:${kind}`).toBeTruthy();
      }
      // no label for a kind that is not registered
      for (const key of Object.keys(labels)) {
        if (key.includes('.') && !ENTERPRISE_EDGE_KINDS.includes(key)) {
          expect(EDGE_KINDS[key], `${name}:${key} is not a registered kind`).toBeDefined();
        }
      }
      for (const kind of ENTERPRISE_EDGE_KINDS) expect(labels[kind], `${name}:${kind}`).toBeTruthy();
      const typeLabels = (messages as any).resources.types as Record<string, string>;
      for (const type of ENTERPRISE_TYPES) expect(typeLabels[type], `${name}:types.${type}`).toBeTruthy();
      expect((messages as any).resources.categories.infrastructure).toBeTruthy();
    }
  });
});
