import { describe, expect, it, vi } from 'vitest';
import { agentsExtraResourceTypes } from '@/lib/resources/providers/agentsExtra';
import { knowledgeResourceTypes, mapRagModule } from '@/lib/resources/providers/knowledge';
import type { DatabaseProvider } from '@/lib/database';
import type { ResourceProviderContext } from '@/lib/resources/types';

const S = 'TOP-SECRET-VALUE';
const D = new Date('2026-01-02T03:04:05Z');
const common = { tenantId: 't1', createdBy: 'u1', updatedBy: 'u2', createdAt: D, updatedAt: D };

const docs = {
  mcp: { ...common, _id: 'mcp1', projectId: 'p1', key: 'srv', name: 'Srv', status: 'active', sourceType: 'remote',
    tools: [{ name: 'a', description: S }], openApiSpec: S, upstreamBaseUrl: `https://x/${S}`,
    upstreamAuth: { token: S, sealed: S, password: S }, stdioConfig: { env: { K: S }, envSealed: S },
    remoteConfig: { url: `https://x?t=${S}` }, endpointSlug: S, metadata: { s: S }, lastError: { message: S } },
  skill: { ...common, _id: 'sk1', projectId: null, key: 'sk', title: 'Skill', header: 'Short', body: `body ${S}`, status: 'inactive', minModelTier: 'small' },
  prompt: { ...common, _id: 'pr1', projectId: 'p1', key: 'pr', name: 'Prompt', template: `tpl ${S}`, currentVersion: 3,
    deploymentHistory: [{ note: S }], deployments: { prod: { s: S } }, metadata: { s: S } },
  memory: { ...common, _id: 'mem1', projectId: 'p1', key: 'mem-a', name: 'Mem', status: 'error', memoryCount: 4,
    vectorProviderKey: 'vp', vectorIndexKey: 'vi', embeddingModelKey: 'em', config: { s: S } },
  browser: { ...common, _id: 'b1', projectId: '', key: 'br', name: 'Br', status: 'active', storageStateEnc: S,
    storageStateMeta: { cookieCount: 7, origins: [S], uploadedAt: D }, defaultSessionConfig: { proxy: S }, metadata: { s: S } },
  flow: { ...common, _id: 'f1', projectId: 'p1', key: 'fl', name: 'Fl', status: 'draft', browserId: 'b1', version: 2,
    steps: [{ value: S }, {}], inputs: [{ default: S }], lastRun: { status: 'failed', runId: S } },
  rag: { ...common, _id: 'r1', projectId: '', key: 'rag', name: 'Rag', status: 'active', embeddingModelKey: 'e',
    vectorProviderKey: 'vp', vectorIndexKey: 'vi', totalDocuments: 2, totalChunks: 9, defaultFilter: { s: S }, metadata: { s: S } },
  vec: { ...common, _id: 'v1', projectId: 'p1', providerKey: 'prov', key: 'idx', name: 'Idx', externalId: S, dimension: 8, metric: 'cosine', metadata: { s: S } },
  bucket: { ...common, _id: 'bk1', projectId: 'p1', key: 'bk', name: 'Bk', providerKey: 'fp', status: 'active', prefix: S, metadata: { s: S } },
  crawler: { ...common, _id: 'c1', projectId: 'p1', key: 'cr', name: 'Cr', status: 'disabled', engine: 'axios', seeds: [`https://${S}`, 'b'],
    maxPages: 10, autoCrawl: true, http: { headers: { a: S }, cookies: S, bearerToken: S, basicAuth: { password: S } },
    webhook: { secret: S, url: S }, schedule: { enabled: true, cron: S }, rag: { ragModuleKey: 'rag' } },
  reranker: { ...common, _id: 'rk1', projectId: null, key: 'rk', name: 'Rk', status: 'active', strategy: 'llm',
    config: { modelKey: 'mk', promptTemplate: S }, totalRuns: 5, avgLatencyMs: 12 },
};

const db = {
  listMcpServers: vi.fn().mockResolvedValue([docs.mcp]),
  listSkills: vi.fn().mockResolvedValue([docs.skill]),
  listPrompts: vi.fn().mockResolvedValue([docs.prompt]),
  listMemoryStores: vi.fn().mockResolvedValue([docs.memory]),
  listBrowsers: vi.fn().mockResolvedValue([docs.browser]),
  listBrowserFlows: vi.fn().mockResolvedValue([docs.flow]),
  listRagModules: vi.fn().mockResolvedValue([docs.rag]),
  listVectorIndexes: vi.fn().mockResolvedValue([docs.vec]),
  listFileBuckets: vi.fn().mockResolvedValue([docs.bucket]),
  listCrawlers: vi.fn().mockResolvedValue([docs.crawler]),
  listRerankers: vi.fn().mockResolvedValue([docs.reranker]),
};
const ctx = { db: db as unknown as DatabaseProvider, tenantId: 't1', tenantDbName: 'd' } satisfies ResourceProviderContext;
const all = [...agentsExtraResourceTypes, ...knowledgeResourceTypes];

describe('providers-A group files', () => {
  it('declares exactly the assigned types', () => {
    expect(agentsExtraResourceTypes.map((d) => d.type)).toEqual(['mcp-server', 'skill', 'prompt', 'memory-store', 'browser', 'browser-flow']);
    expect(knowledgeResourceTypes.map((d) => d.type)).toEqual(['rag-module', 'vector-index', 'file-bucket', 'crawler', 'reranker']);
  });

  it('lists the whole tenant (no project filter; tenantId only where the contract needs it)', async () => {
    for (const d of all) await d.list(ctx);
    for (const fn of ['listMcpServers', 'listSkills', 'listPrompts', 'listMemoryStores', 'listRagModules', 'listVectorIndexes', 'listRerankers'] as const) {
      expect(db[fn]).toHaveBeenCalledWith();
    }
    for (const fn of ['listBrowsers', 'listBrowserFlows', 'listFileBuckets', 'listCrawlers'] as const) {
      expect(db[fn]).toHaveBeenCalledWith('t1');
    }
  });

  it('never exposes secret fields and normalises projectId / dates / types', async () => {
    for (const d of all) {
      const rows = await d.list(ctx);
      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r.type).toBe(d.type);
      expect(JSON.stringify(r)).not.toContain(S);
      expect(r.tenantId).toBe('t1');
      expect(r.createdAt).toBe(D.toISOString());
      expect(['p1', null]).toContain(r.projectId);
    }
  });

  it('maps tenant-wide spellings (null and empty string) to null', async () => {
    const byType = Object.fromEntries(await Promise.all(all.map(async (d) => [d.type, (await d.list(ctx))[0]])));
    expect(byType['skill'].projectId).toBeNull();
    expect(byType['browser'].projectId).toBeNull();
    expect(byType['rag-module'].projectId).toBeNull();
    expect(byType['reranker'].projectId).toBeNull();
    expect(byType['prompt'].projectId).toBe('p1');
  });

  it('maps status tone', async () => {
    const byType = Object.fromEntries(await Promise.all(all.map(async (d) => [d.type, (await d.list(ctx))[0]])));
    expect(byType['mcp-server']).toMatchObject({ status: 'active', statusTone: 'ok' });
    expect(byType['skill']).toMatchObject({ status: 'inactive', statusTone: 'off' });
    expect(byType['memory-store']).toMatchObject({ status: 'error', statusTone: 'warn' });
    expect(byType['browser-flow']).toMatchObject({ status: 'draft', statusTone: 'off' });
    expect(byType['crawler']).toMatchObject({ status: 'disabled', statusTone: 'off' });
    expect(byType['prompt']).toMatchObject({ status: null, statusTone: 'neutral' });
    expect(byType['vector-index']).toMatchObject({ status: null, statusTone: 'neutral' });
  });

  it('exposes only safe counts as attributes', async () => {
    const get = async (t: string) => {
      const d = all.find((x) => x.type === t)!;
      return Object.fromEntries((await d.list(ctx))[0].attributes.map((a) => [a.key, a.value]));
    };
    expect(await get('mcp-server')).toMatchObject({ sourceType: 'remote', toolCount: 1 });
    expect(await get('browser')).toMatchObject({ hasStorageState: true, cookieCount: 7 });
    expect(await get('browser-flow')).toMatchObject({ stepCount: 2, lastRunStatus: 'failed', version: 2 });
    expect(await get('crawler')).toMatchObject({ seedCount: 2, scheduled: true, ragModuleKey: 'rag' });
    expect(await get('rag-module')).toMatchObject({ totalDocuments: 2, totalChunks: 9 });
    expect(await get('reranker')).toMatchObject({ strategy: 'llm', modelKey: 'mk' });
  });

  it('a rag module with access control lists no totals: they count documents not every reader may see', () => {
    const keys = (access: unknown) => mapRagModule({ ...docs.rag, access }).attributes.map((a) => a.key);
    expect(keys({ enabled: true })).not.toEqual(expect.arrayContaining(['totalDocuments']));
    expect(keys({ enabled: true })).not.toEqual(expect.arrayContaining(['totalChunks']));
    expect(keys({ enabled: false })).toEqual(expect.arrayContaining(['totalDocuments', 'totalChunks']));
    expect(keys(undefined)).toEqual(expect.arrayContaining(['totalDocuments', 'totalChunks']));
  });

  it('skill uses title as name and header as description', async () => {
    const r = (await all.find((d) => d.type === 'skill')!.list(ctx))[0];
    expect(r).toMatchObject({ name: 'Skill', description: 'Short' });
  });

  it('builds the dashboard routes the pages expect', async () => {
    const urls: Record<string, string | null> = {};
    for (const d of all) urls[d.type] = d.detailUrl ? d.detailUrl((await d.list(ctx))[0]) : null;
    expect(urls).toEqual({
      'mcp-server': '/dashboard/mcp/mcp1',
      skill: '/dashboard/agents/skills',
      prompt: '/dashboard/prompts/pr1',
      'memory-store': '/dashboard/memory/mem-a',
      browser: '/dashboard/browser/b1',
      'browser-flow': '/dashboard/browser/flows/f1',
      'rag-module': '/dashboard/rag/rag',
      'vector-index': '/dashboard/vector/prov/idx',
      'file-bucket': '/dashboard/files/bk',
      crawler: '/dashboard/crawler/c1',
      reranker: '/dashboard/reranker/rk',
    });
  });
});
