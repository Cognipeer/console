import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRag: vi.fn(),
  getRagDocument: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('@/lib/services/rag/ragService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  queryRag: mocks.queryRag,
  getRagDocument: mocks.getRagDocument,
  getRagDocumentFullText: vi.fn(async () => ({ fileName: 'f.md', text: 'body', truncated: false, totalChars: 4, totalLines: 1 })),
}));
vi.mock('@/lib/services/agents/bindingResolution', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveAgentKnowledgeModule: mocks.resolve,
}));

import {
  allKnowledgeKeys,
  knowledgeKeySlug,
  mergeKnowledgeHits,
  normalizeKnowledgeBindings,
} from '@/lib/services/agents/agentKnowledgeBindings';
import { buildAgentKnowledgeTools } from '@/lib/services/agents/agentService';

const guard = { protect: (_s: unknown, fn: unknown) => fn } as never;
const run = (tool: unknown, args: unknown) => {
  const t = tool as { invoke?: (a: unknown) => Promise<unknown>; func?: (a: unknown) => Promise<unknown> };
  return (t.invoke ?? t.func)!(args);
};

describe('normalizeKnowledgeBindings', () => {
  it('turns the legacy key into one binding', () => {
    expect(normalizeKnowledgeBindings({ knowledgeEngineKey: 'a' })).toEqual([{ key: 'a' }]);
  });
  it('lets bindings win, drops disabled and duplicates', () => {
    const out = normalizeKnowledgeBindings({
      knowledgeEngineKey: 'legacy',
      knowledgeBindings: [{ key: 'a' }, { key: 'a' }, { key: 'b', enabled: false }, { key: 'c', topK: 3 }],
    });
    expect(out.map((b) => b.key)).toEqual(['a', 'c']);
    expect(allKnowledgeKeys({ knowledgeBindings: [{ key: 'a' }, { key: 'b', enabled: false }] })).toEqual(['a', 'b']);
  });
  it('slugs keys for tool names', () => {
    expect(knowledgeKeySlug('HR Docs/v2')).toBe('hr_docs_v2');
  });
});

describe('mergeKnowledgeHits', () => {
  it('sorts by score and caps', () => {
    const hits = [0.2, 0.9, 0.5].map((score, i) => ({ kb: 'k', score, content: String(i) }));
    expect(mergeKnowledgeHits(hits, 2).map((h) => h.score)).toEqual([0.9, 0.5]);
  });
});

describe('buildAgentKnowledgeTools', () => {
  beforeEach(() => {
    mocks.queryRag.mockReset();
    mocks.getRagDocument.mockReset();
    mocks.resolve.mockReset();
    mocks.resolve.mockImplementation(async (_db: string, key: string) => (key === 'hidden' ? null : { key, projectId: 'p1', status: key === 'off' ? 'disabled' : 'active' }));
  });

  it('keeps the historical tools for one plain legacy key', async () => {
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', { knowledgeEngineKey: 'a' }, guard);
    expect(built.toolDefinitions.map((d) => d.name)).toEqual([
      'knowledge_search', 'knowledge_read_document', 'knowledge_read_document_lines',
    ]);
    mocks.queryRag.mockResolvedValue({ matches: [] });
    await run(built.tools[0], { query: 'q' });
    expect(mocks.queryRag.mock.calls[0][3]).toMatchObject({ topK: 5 });
  });

  it('marks a model-supplied filter as untrusted, and leaves a call without one trusted', async () => {
    mocks.resolve.mockImplementation(async (_db: string, key: string) => ({
      key, projectId: 'p1', status: 'active', filterableFields: ['source'],
    }));
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', { knowledgeEngineKey: 'a' }, guard);
    mocks.queryRag.mockResolvedValue({ matches: [] });
    await run(built.tools[0], { query: 'q', filter: { source: 'wiki' } });
    expect(mocks.queryRag.mock.calls[0][3]).toMatchObject({ filter: { source: 'wiki' }, filterSource: 'untrusted' });
    await run(built.tools[0], { query: 'q' });
    expect(mocks.queryRag.mock.calls[1][3]).not.toHaveProperty('filterSource');
  });

  it('gives no knowledge tools for a single knowledge engine that is switched off', async () => {
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', { knowledgeEngineKey: 'off' }, guard);
    expect(built.tools).toEqual([]);
    expect(built.toolDefinitions).toEqual([]);
  });

  it('leaves a switched-off knowledge engine out of the combined tools', async () => {
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', {
      knowledgeBindings: [{ key: 'a' }, { key: 'off' }],
    }, guard);
    expect(built.toolDefinitions[0].description).toContain('- a');
    expect(built.toolDefinitions[0].description).not.toContain('- off');
  });

  it('separate mode suffixes names and adds the directive', async () => {
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', {
      knowledgeToolMode: 'separate',
      knowledgeBindings: [{ key: 'hr', description: 'HR policies' }, { key: 'eng' }, { key: 'hidden' }],
    }, guard);
    expect(built.toolDefinitions.map((d) => d.name)).toEqual([
      'knowledge_search_hr', 'knowledge_read_document_hr', 'knowledge_read_document_lines_hr',
      'knowledge_search_eng', 'knowledge_read_document_eng', 'knowledge_read_document_lines_eng',
    ]);
    expect(built.toolDefinitions[0].description).toContain('Use for: HR policies');
    expect(built.toolDefinitions[0].description).toContain('knowledge_read_document_hr');
  });

  it('combined mode merges, applies per-binding options and tags hits', async () => {
    mocks.queryRag.mockImplementation(async (_d: string, _t: string, _s: string, req: { ragModuleKey: string }) => ({
      matches: req.ragModuleKey === 'a'
        ? [{ content: 'low', score: 0.3, documentId: 'd1', fileName: 'a.md' }]
        : [{ content: 'high', score: 0.8, documentId: 'd2', fileName: 'b.md' }],
    }));
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', {
      knowledgeBindings: [{ key: 'a', description: 'Alpha', topK: 2 }, { key: 'b', minScore: 0.5 }],
    }, guard);
    expect(built.tools).toHaveLength(3);
    expect(built.toolDefinitions[0].description).toContain('- a: Alpha');
    const out = String(await run(built.tools[0], { query: 'q' }));
    expect(out.indexOf('kb: b')).toBeLessThan(out.indexOf('kb: a'));
    expect(out).toContain('[kb: b, documentId: d2, file: b.md, score: 0.80]');
    const calls = mocks.queryRag.mock.calls.map((c) => c[3]);
    expect(calls.find((c) => c.ragModuleKey === 'a')).toMatchObject({ topK: 2 });
    expect(calls.find((c) => c.ragModuleKey === 'b')).toMatchObject({ minScore: 0.5 });
    expect(calls.find((c) => c.ragModuleKey === 'b').topK).toBeUndefined();
  });

  it('combined reads only documents of a bound KB', async () => {
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', {
      knowledgeBindings: [{ key: 'a' }, { key: 'b' }],
    }, guard);
    const read = built.tools[1];
    mocks.getRagDocument.mockResolvedValue({ ragModuleKey: 'other', projectId: 'p1' });
    expect(await run(read, { documentId: 'x' })).toContain('not found');
    mocks.getRagDocument.mockResolvedValue({ ragModuleKey: 'b', projectId: 'p1' });
    expect(await run(read, { documentId: 'x', kb: 'a' })).toContain('not found');
    expect(await run(read, { documentId: 'x', kb: 'zzz' })).toContain('Unknown knowledge base');
    expect(String(await run(read, { documentId: 'x' }))).toContain('# f.md');
  });
});
