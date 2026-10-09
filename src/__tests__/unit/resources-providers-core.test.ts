import { describe, expect, it, vi } from 'vitest';
import {
  buildAttributes,
  normalizeProjectId,
  statusFromEnabled,
  toIso,
  toneForStatus,
} from '@/lib/resources/mapping';
import { coreResourceTypes, mapAgent, mapModel, mapTool } from '@/lib/resources/providers/core';
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
        execution: { callbackSecret: SECRET, callbackSecretSealed: SECRET },
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
