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

import { clearResourceCache, getResource, getResourceHealth, listResources } from '@/lib/resources/service';

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
      config: {
        modelKey: 'm1',
        connection: { apiKeyEnc: 'NEVER-EXPOSE' },
        // own-project row + tenant-wide fallback
        toolBindings: [
          { source: 'tool', sourceKey: 'tool-project', toolNames: ['a'] },
          { source: 'tool', sourceKey: 'tool-wide', toolNames: ['a'] },
        ],
      } as never, createdBy: by,
    });
    await db.createAgent({
      tenantId, projectId: projectB, key: `agent-b-${slug}`, name: 'Agent B', status: 'draft',
      // 'tool-project' only exists in project A: the runtime would never reach it from B
      config: { modelKey: 'm1', toolBindings: [{ source: 'tool', sourceKey: 'tool-project', toolNames: ['a'] }] } as never,
      createdBy: by,
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

  it('resolves agent -> tool bindings the same way on both backends (project row, tenant-wide fallback, cross-project)', async () => {
    const list = await listResources({ tenantDbName: dbName, tenantId, type: 'agent' });
    const idOf = (name: string) => list.items.find((i) => i.name === name)!.id;
    const toolId = (await listResources({ tenantDbName: dbName, tenantId, type: 'tool' })).items;
    const projectToolId = toolId.find((t) => t.key === 'tool-project')!.id;
    const wideToolId = toolId.find((t) => t.key === 'tool-wide')!.id;

    const a = (await getResource({ tenantDbName: dbName, tenantId, type: 'agent', id: idOf('Agent A') }))!;
    const toolUses = (r: typeof a) => r.uses.filter((u) => u.kind === 'agent.tool');
    expect(toolUses(a).map((u) => [u.other.key, u.status, u.other.id])).toEqual([
      ['tool-project', 'ok', projectToolId],
      // the seeded tenant-wide tool is disabled: found through the fallback, but the runtime skips it
      ['tool-wide', 'inactive', wideToolId],
    ]);
    expect(toolUses(a)[1].other.projectId).toBeNull();

    const b = (await getResource({ tenantDbName: dbName, tenantId, type: 'agent', id: idOf('Agent B') }))!;
    expect(toolUses(b)).toHaveLength(1);
    expect(toolUses(b)[0]).toMatchObject({ status: 'cross-project', severity: 'warning', other: { id: null, key: 'tool-project' } });
    expect(toolUses(b)[0].candidates!.map((c) => c.id)).toEqual([projectToolId]);
    expect(b.issues.some((i) => i.kind === 'cross-project-reference' && i.edgeKind === 'agent.tool')).toBe(true);

    const tool = (await getResource({ tenantDbName: dbName, tenantId, type: 'tool', id: projectToolId }))!;
    expect(tool.usedBy.map((e) => [e.other.name, e.status]).sort()).toEqual([
      ['Agent A', 'ok'],
      ['Agent B', 'cross-project'],
    ]);
    const wide = (await getResource({ tenantDbName: dbName, tenantId, type: 'tool', id: wideToolId }))!;
    expect(wide.usedBy.map((e) => [e.other.name, e.status])).toEqual([['Agent A', 'inactive']]);

    const health = await getResourceHealth({ tenantDbName: dbName, tenantId, kind: 'cross-project-reference' });
    expect(health.issues.map((i) => i.resource.id)).toEqual([idOf('Agent B')]);
    expect(JSON.stringify([a, b, tool, health])).not.toContain('NEVER-EXPOSE');
    expect(JSON.stringify([a, b, tool, health])).not.toContain('"edges"');
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
