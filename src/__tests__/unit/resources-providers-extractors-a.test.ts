import { describe, expect, it } from 'vitest';
import { mapMcpServer, mapMemoryStore } from '@/lib/resources/providers/agentsExtra';
import { mapCrawler, mapRagModule, mapReranker } from '@/lib/resources/providers/knowledge';

const e = (r: { edges?: unknown }) => r.edges as Array<Record<string, unknown>> | undefined;

describe('extractors-A edges', () => {
  it('mcp-server: guardrail + composite members by id (composite only)', () => {
    const r = mapMcpServer({
      _id: 'm1', key: 'c', name: 'C', sourceType: 'composite', status: 'active',
      guardrail: { guardrailKey: 'gr', mode: 'enforce' },
      metadata: { composite: { members: [{ serverId: 's1' }, { serverId: 's1' }, { serverId: 's2' }, {}] } },
    });
    expect(e(r)).toEqual([
      { kind: 'mcp.guardrail', toType: 'guardrail', by: 'key', target: 'gr', field: 'guardrail.guardrailKey' },
      expect.objectContaining({ kind: 'mcp.compositeMember', by: 'id', target: 's1', field: 'metadata.composite.members[0].serverId' }),
      expect.objectContaining({ kind: 'mcp.compositeMember', by: 'id', target: 's2' }),
    ]);
    const plain = mapMcpServer({ _id: 'm2', sourceType: 'remote', metadata: { composite: { members: [{ serverId: 'x' }] } } });
    expect(plain.edges).toBeUndefined();
  });

  it('mcp-server: a guardrail in mode off/disabled evaluates nothing, so it is not a reference', () => {
    for (const mode of ['off', 'disabled']) {
      expect(mapMcpServer({ _id: 'x', key: 'x', sourceType: 'remote', guardrail: { guardrailKey: 'stale', mode } }).edges).toBeUndefined();
    }
    for (const mode of ['monitor', 'enforce', undefined]) {
      expect(e(mapMcpServer({ _id: 'x', key: 'x', sourceType: 'remote', guardrail: { guardrailKey: 'g', mode } }))).toHaveLength(1);
    }
  });

  it('memory-store: embedding model + vector index qualified by provider', () => {
    const r = mapMemoryStore({ _id: 'a', embeddingModelKey: 'emb', vectorProviderKey: 'vp', vectorIndexKey: 'vi' });
    expect(e(r)).toEqual([
      expect.objectContaining({ kind: 'memory.embeddingModel', target: 'emb' }),
      expect.objectContaining({ kind: 'memory.vectorIndex', target: 'vi', qualifier: 'vp' }),
    ]);
    expect(mapMemoryStore({ _id: 'b' }).edges).toBeUndefined();
  });

  it('rag-module: model, index, reranker, bucket; skips empties', () => {
    const r = mapRagModule({ _id: 'r', embeddingModelKey: 'emb', vectorProviderKey: 'vp', vectorIndexKey: 'vi', rerankerKey: 'rr', fileBucketKey: ' ' });
    expect(e(r)?.map((x) => x.kind)).toEqual(['rag.embeddingModel', 'rag.vectorIndex', 'rag.reranker']);
    expect(e(r)?.[1]).toMatchObject({ qualifier: 'vp' });
  });

  it('reranker and crawler', () => {
    expect(e(mapReranker({ _id: 'x', config: { modelKey: 'm' } }))).toEqual([
      expect.objectContaining({ kind: 'reranker.model', target: 'm', field: 'config.modelKey' }),
    ]);
    expect(mapReranker({ _id: 'y', config: {} }).edges).toBeUndefined();
    expect(e(mapCrawler({ _id: 'c', rag: { ragModuleKey: 'rm' } }))).toEqual([
      expect.objectContaining({ kind: 'crawler.ragModule', target: 'rm', field: 'rag.ragModuleKey' }),
    ]);
    expect(mapCrawler({ _id: 'd' }).edges).toBeUndefined();
  });
});
