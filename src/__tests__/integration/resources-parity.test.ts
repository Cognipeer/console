/**
 * Resource Registry parity: the same listResources() output (ids, projects,
 * statuses, shapes) on SQLite and MongoDB — tenant-wide rows are stored as
 * NULL on one backend and missing on the other, which is exactly the drift the
 * registry has to hide.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const h = vi.hoisted(() => ({ current: null as unknown as DatabaseProvider }));

// listResources() binds the tenant through runWithTenantScope; here the harness
// provider is the only provider, so route it through that.
vi.mock('@/lib/database', () => ({
  getDatabase: async () => h.current,
  runWithTenantScope: async (name: string, fn: (db: DatabaseProvider) => unknown) => {
    await h.current.switchToTenant(name);
    return fn(h.current);
  },
}));

import { clearResourceCache, listResources } from '@/lib/resources/service';

describeForEachProvider('Resource registry listResources', (getDb) => {
  let dbName: string;
  let tenantId: string;
  let projectA: string;
  let projectB: string;

  beforeAll(() => {
    h.current = getDb();
  });

  beforeEach(async () => {
    clearResourceCache();
    const db = getDb();
    h.current = db;
    const slug = `res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({
      companyName: 'Res',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
    const user = await db.createUser({
      tenantId,
      email: 'owner@res.io',
      name: 'Owner',
      password: '$2b$10$x',
      role: 'owner',
      licenseId: 'FREE',
      features: [],
    });
    projectA = String((await db.createProject({ tenantId, key: 'a', name: 'Project A', createdBy: String(user._id) }))._id);
    projectB = String((await db.createProject({ tenantId, key: 'b', name: 'Project B', createdBy: String(user._id) }))._id);

    const by = String(user._id);
    await db.createAgent({
      tenantId, projectId: projectA, key: `agent-a-${slug}`, name: 'Agent A', status: 'active',
      config: { modelKey: 'm1', connection: { apiKeyEnc: 'NEVER-EXPOSE' } } as never, createdBy: by,
    });
    await db.createAgent({
      tenantId, projectId: projectB, key: `agent-b-${slug}`, name: 'Agent B', status: 'draft',
      config: { modelKey: 'm1' } as never, createdBy: by,
    });
    await db.createTool({
      tenantId, projectId: projectA, key: 'tool-project', name: 'Project tool', type: 'openapi', status: 'active',
      actions: [], upstreamAuth: { token: 'NEVER-EXPOSE' } as never, createdBy: by,
    });
    await db.createTool({
      tenantId, key: 'tool-wide', name: 'Tenant-wide tool', type: 'mcp', status: 'disabled',
      actions: [], createdBy: by,
    });
    await db.createModel({
      tenantId, projectId: projectA, name: 'Model 1', key: `m1-${slug}`, providerKey: 'prov', providerDriver: 'openai',
      category: 'llm', modelId: 'gpt-x', settings: { apiKey: 'NEVER-EXPOSE' }, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 },
      createdBy: by,
    });
    await db.createPrompt({
      tenantId, projectId: projectB, key: 'prompt-1', name: 'Prompt 1', template: 'NEVER-EXPOSE {{x}}', createdBy: by,
    });
    // Tenant-wide rows: the same "no project" is '' / NULL / missing depending on type and backend.
    await db.createRagModule({
      tenantId, projectId: '', key: 'rag-wide', name: 'Wide RAG', embeddingModelKey: 'e', vectorProviderKey: 'v',
      vectorIndexKey: 'i', chunkConfig: { strategy: 'recursive_character', chunkSize: 100, chunkOverlap: 10 },
      status: 'active', metadata: { secret: 'NEVER-EXPOSE' }, createdBy: by,
    });
    await db.createReranker({
      tenantId, key: 'rerank-wide', name: 'Wide reranker', strategy: 'heuristic', config: {}, status: 'disabled', createdBy: by,
    });
    await db.createMcpServer({
      tenantId, key: 'mcp-wide', name: 'Wide MCP', sourceType: 'openapi', tools: [], upstreamAuth: { type: 'token', token: 'NEVER-EXPOSE' },
      status: 'active', endpointSlug: `mcp-${slug}`, createdBy: by,
    } as never);
    await db.createGuardrail({
      tenantId, key: 'guard-wide', name: 'Wide guardrail', type: 'custom', target: 'input', action: 'block',
      enabled: true, customPrompt: 'NEVER-EXPOSE', createdBy: by,
    });
  });

  it('returns every row of the tenant across projects, with tenant-wide rows normalised to null', async () => {
    const res = await listResources({ tenantDbName: dbName, tenantId, limit: 200 });
    const shape = res.items
      .map((i) => ({ type: i.type, name: i.name, projectName: i.projectName, status: i.status, tone: i.statusTone }))
      .sort((a, b) => `${a.type}${a.name}`.localeCompare(`${b.type}${b.name}`));

    const expected = [
      { type: 'agent', name: 'Agent A', projectName: 'Project A', status: 'active', tone: 'ok' },
      { type: 'agent', name: 'Agent B', projectName: 'Project B', status: 'draft', tone: 'off' },
      { type: 'guardrail', name: 'Wide guardrail', projectName: null, status: 'enabled', tone: 'ok' },
      { type: 'mcp-server', name: 'Wide MCP', projectName: null, status: 'active', tone: 'ok' },
      { type: 'model', name: 'Model 1', projectName: 'Project A', status: null, tone: 'neutral' },
      { type: 'prompt', name: 'Prompt 1', projectName: 'Project B', status: null, tone: 'neutral' },
      { type: 'rag-module', name: 'Wide RAG', projectName: null, status: 'active', tone: 'ok' },
      { type: 'reranker', name: 'Wide reranker', projectName: null, status: 'disabled', tone: 'off' },
      { type: 'tool', name: 'Project tool', projectName: 'Project A', status: 'active', tone: 'ok' },
      { type: 'tool', name: 'Tenant-wide tool', projectName: null, status: 'disabled', tone: 'off' },
    ];
    expected.sort((a, b) => `${a.type}${a.name}`.localeCompare(`${b.type}${b.name}`));
    expect(shape).toEqual(expected);

    const wide = res.items.find((i) => i.name === 'Tenant-wide tool');
    expect(wide?.projectId).toBeNull();
    // Every tenant-wide spelling ('' / NULL / missing) collapses to null on both backends.
    for (const name of ['Wide RAG', 'Wide reranker', 'Wide MCP', 'Wide guardrail']) {
      expect(res.items.find((i) => i.name === name)?.projectId, name).toBeNull();
    }
    expect(wide?.crn).toBe(`crn:cpr:${tenantId}:-:tool/${wide?.id}`);
    expect(res.errors).toEqual([]);
    expect(res.projects.map((p) => p.name).sort()).toEqual(['Project A', 'Project B']);
  });

  it('filters tenant-wide rows only and a single project the same way on both backends', async () => {
    const wide = await listResources({ tenantDbName: dbName, tenantId, projectId: 'tenant' });
    expect(wide.items.map((i) => i.name).sort()).toEqual(
      ['Tenant-wide tool', 'Wide MCP', 'Wide RAG', 'Wide guardrail', 'Wide reranker'].sort(),
    );

    const inB = await listResources({ tenantDbName: dbName, tenantId, projectId: projectB });
    expect(inB.items.map((i) => i.name).sort()).toEqual(['Agent B', 'Prompt 1']);
  });

  it('exposes none of the secret fields it was seeded with', async () => {
    const res = await listResources({ tenantDbName: dbName, tenantId, limit: 200 });
    expect(JSON.stringify(res)).not.toContain('NEVER-EXPOSE');
  });

  it('resolves the owner label from the users read', async () => {
    const res = await listResources({ tenantDbName: dbName, tenantId, type: 'model' });
    expect(res.items[0].createdByLabel).toBe('owner@res.io');
  });
});
