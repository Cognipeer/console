/**
 * Web search instances in the rest of the product: a provider with instances cannot be deleted, quota targets list
 * instances, and the references registry resolves an agent binding to an instance first, a provider second.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDatabase: async () => hoisted.db,
  runWithTenantScope: async (_name: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
}));

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { ProviderInUseError } from '@/lib/providers/errors';
import { deleteProviderConfig } from '@/lib/services/providers/providerService';
import { hasActiveWebSearch } from '@/lib/services/webSearch/webSearchService';
import { quotaTargetSource } from '@/lib/quota/targets';
import { buildResolutionIndex, resolveEdge } from '@/lib/resources/references';
import { mapWebSearchInstance, mapProvider } from '@/lib/resources/providers/modelsSafety';
import { extractAgentEdges } from '@/lib/resources/providers/core';
import type { ResourceRecord } from '@/lib/resources/types';

const TENANT_DB = 'websearch_instance_integration_tenant';
const T = 't1';

let tmpDir = '';
let db: SQLiteProvider;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-websearch-instance-integration-'));
  db = new SQLiteProvider(tmpDir, 'websearch_instance_integration_main');
  await db.connect();
  await db.switchToTenant(TENANT_DB);
  hoisted.db = db;
});

afterAll(async () => {
  await db.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const i of await db.listWebSearchInstances(T)) await db.deleteWebSearchInstance(String(i._id));
  for (const p of await db.listProviders(T)) await db.deleteProvider(String(p._id));
});

const makeProvider = (key: string, extra: Record<string, unknown> = {}) => db.createProvider({
  tenantId: T, type: 'websearch', driver: 'tavily', label: key, key, status: 'active',
  credentialsEnc: 'x', settings: {}, projectIds: ['p1'], createdBy: 'u', ...extra,
} as never);

const makeInstance = (key: string, providerKey: string, extra: Record<string, unknown> = {}) => db.createWebSearchInstance({
  tenantId: T, projectId: null, key, name: key, providerKey, status: 'active', settings: {}, createdBy: 'u', ...extra,
} as never);

describe('deleting a websearch provider', () => {
  it('is refused while instances use it, naming them', async () => {
    const p = await makeProvider('conn');
    await makeInstance('zeta', 'conn');
    await makeInstance('alpha', 'conn');
    const error = await deleteProviderConfig(TENANT_DB, String(p._id)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderInUseError);
    expect((error as ProviderInUseError).instanceKeys).toEqual(['alpha', 'zeta']);
    expect((error as Error).message).toContain('"alpha", "zeta"');
    expect(await db.findProviderByKey(T, 'conn')).toBeTruthy();
  });

  it('works once the instances are gone, and for a provider nobody uses', async () => {
    const p = await makeProvider('conn');
    const i = await makeInstance('docs', 'conn');
    await db.deleteWebSearchInstance(String(i._id));
    expect(await deleteProviderConfig(TENANT_DB, String(p._id))).toBe(true);
    const free = await makeProvider('free');
    await makeInstance('other', 'conn');
    expect(await deleteProviderConfig(TENANT_DB, String(free._id))).toBe(true);
  });
});

describe('availability', () => {
  it('counts an active instance whose provider is visible, or an active provider', async () => {
    expect(await hasActiveWebSearch(TENANT_DB, T, 'p1')).toBe(false);
    await makeProvider('conn', { status: 'disabled' });
    await makeInstance('docs', 'conn', { status: 'disabled' });
    expect(await hasActiveWebSearch(TENANT_DB, T, 'p1')).toBe(false);
    await makeProvider('conn2');
    expect(await hasActiveWebSearch(TENANT_DB, T, 'p1')).toBe(true);
  });
});

describe('quota targets', () => {
  it('offers web search instances, not provider rows', () => {
    expect(quotaTargetSource('websearch', 'resource')).toMatchObject({
      id: 'registry:websearch', types: ['websearch-instance'], valueField: 'key',
    });
  });
});

describe('references', () => {
  const agent = (projectId: string | null, key: string): ResourceRecord => {
    const doc = {
      _id: 'a1', key: 'agent-1', name: 'Agent', projectId,
      config: { toolBindings: [{ source: 'system', sourceKey: 'web_search', config: { providerKey: key } }] },
    };
    const edges = extractAgentEdges(doc as never);
    return { type: 'agent', id: 'a1', key: 'agent-1', name: 'Agent', projectId, edges, attributes: [] } as unknown as ResourceRecord;
  };
  const instanceRec = (key: string, projectId: string | null, providerKey: string, status = 'active') =>
    mapWebSearchInstance({ _id: `i-${key}`, key, name: key, projectId, providerKey, status });
  const providerRec = (key: string, projectIds: string[], status = 'active') =>
    mapProvider({ _id: `p-${key}`, key, label: key, type: 'websearch', driver: 'tavily', projectIds, status });

  it('an agent binding resolves to an instance, tenant-wide ones included', () => {
    const from = agent('p1', 'docs');
    const index = buildResolutionIndex([instanceRec('docs', null, 'conn'), providerRec('docs', ['p1'])]);
    const resolved = resolveEdge(index, from, from.edges![0]);
    expect(resolved?.status).toBe('ok');
    expect(resolved?.matches[0].type).toBe('websearch-instance');
  });

  it('an instance of another project does not serve the agent, and the legacy provider key still resolves', () => {
    const from = agent('p1', 'conn');
    const index = buildResolutionIndex([instanceRec('conn', 'p2', 'conn'), providerRec('conn', ['p1'])]);
    const resolved = resolveEdge(index, from, from.edges![0]);
    expect(resolved?.status).toBe('ok');
    expect(resolved?.matches[0].type).toBe('provider');
  });

  it('a binding that names nothing is missing; a disabled instance is inactive', () => {
    const from = agent('p1', 'ghost');
    expect(resolveEdge(buildResolutionIndex([]), from, from.edges![0])?.status).toBe('missing');
    const disabled = agent('p1', 'docs');
    const index = buildResolutionIndex([instanceRec('docs', null, 'conn', 'disabled')]);
    expect(resolveEdge(index, disabled, disabled.edges![0])?.status).toBe('inactive');
  });

  it('an instance points at its provider, which is then used by it', () => {
    const inst = instanceRec('docs', null, 'conn');
    expect(inst.edges).toEqual([expect.objectContaining({ kind: 'websearchInstance.provider', toType: 'provider', target: 'conn' })]);
    const index = buildResolutionIndex([providerRec('conn', ['p1'])]);
    expect(resolveEdge(index, inst, inst.edges![0])?.status).toBe('ok');
    const unassigned = buildResolutionIndex([providerRec('conn', [])]);
    expect(resolveEdge(unassigned, instanceRec('docs', 'p1', 'conn'), inst.edges![0])?.status).toBe('cross-project');
    expect(resolveEdge(buildResolutionIndex([]), inst, inst.edges![0])?.status).toBe('missing');
  });
});
