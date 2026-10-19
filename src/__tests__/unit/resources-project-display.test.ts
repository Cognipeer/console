import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: { listProjects: vi.fn(), listUsers: vi.fn() },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/resources/providers', () => ({
  ensureCommunityResourceTypesRegistered: vi.fn(),
}));

import { computeProjectDisplay, matchesProjectFilter } from '@/lib/resources/projectDisplay';
import { registerResourceTypes, resetResourceRegistryForTests } from '@/lib/resources/registry';
import { clearResourceCache, getResourceHealth, listResources } from '@/lib/resources/service';
import type { ResourceRecord, ResourceScope, ResourceTypeDefinition } from '@/lib/resources/types';
import { agentsExtraResourceTypes } from '@/lib/resources/providers/agentsExtra';
import { coreResourceTypes } from '@/lib/resources/providers/core';
import { knowledgeResourceTypes } from '@/lib/resources/providers/knowledge';
import { modelsSafetyResourceTypes } from '@/lib/resources/providers/modelsSafety';
import { operationsResourceTypes } from '@/lib/resources/providers/operations';
import { qualityResourceTypes } from '@/lib/resources/providers/quality';

const names = new Map([['p1', 'Retail'], ['p2', 'Corporate'], ['p3', 'HR']]);
const disp = (scope: ResourceScope, projectId: string | null, projectIds?: string[]) =>
  computeProjectDisplay({ scope, projectId, projectIds }, names);

describe('project display rule', () => {
  it('multi-project when more than one distinct project is assigned (names stay index-aligned)', () => {
    expect(disp('project', 'p1', ['p1', 'p2', 'p3'])).toEqual({
      kind: 'multi-project',
      projectIds: ['p1', 'p2', 'p3'],
      projectNames: ['Retail', 'Corporate', 'HR'],
    });
    // a deleted project degrades to its id, never to a hole
    expect(disp('project', null, ['p1', 'gone'])).toMatchObject({ projectNames: ['Retail', 'gone'] });
  });

  it('a single assignment (also when repeated in projectIds) is a plain project', () => {
    expect(disp('project', 'p1')).toEqual({ kind: 'project', projectId: 'p1', projectName: 'Retail' });
    expect(disp('project', 'p1', ['p1'])).toEqual({ kind: 'project', projectId: 'p1', projectName: 'Retail' });
    expect(disp('project', null, ['p2'])).toEqual({ kind: 'project', projectId: 'p2', projectName: 'Corporate' });
    expect(disp('project', 'zzz')).toEqual({ kind: 'project', projectId: 'zzz', projectName: null });
  });

  it('a row with no project is classified by the type scope', () => {
    expect(disp('tenant', null)).toEqual({ kind: 'tenant-level' });
    expect(disp('project-or-tenant', null)).toEqual({ kind: 'all-projects' });
    expect(disp('project', null)).toEqual({ kind: 'unassigned' });
    expect(disp('project', null, [])).toEqual({ kind: 'unassigned' });
  });

  it('a project beats the type scope (a tenant-scoped type with a stray project is still shown with it)', () => {
    expect(disp('tenant', 'p1')).toMatchObject({ kind: 'project', projectId: 'p1' });
  });

  it('project filter: "tenant" = not bound to ONE project; an id matches the project or any assignment', () => {
    const tenantFilter = (d: ReturnType<typeof disp>) => matchesProjectFilter(d, 'tenant');
    expect(tenantFilter(disp('project-or-tenant', null))).toBe(true);
    expect(tenantFilter(disp('tenant', null))).toBe(true);
    expect(tenantFilter(disp('project', null))).toBe(true);
    expect(tenantFilter(disp('project', 'p1'))).toBe(false);
    expect(tenantFilter(disp('project', 'p1', ['p1', 'p2']))).toBe(false);

    expect(matchesProjectFilter(disp('project', 'p1', ['p1', 'p2']), 'p2')).toBe(true);
    expect(matchesProjectFilter(disp('project', 'p1'), 'p2')).toBe(false);
    // a tenant-wide row is not "in" a project for the filter
    expect(matchesProjectFilter(disp('project-or-tenant', null), 'p1')).toBe(false);
  });
});

describe('scope of every community type (checked against how the runtime resolves rows)', () => {
  const all: ResourceTypeDefinition[] = [
    ...coreResourceTypes,
    ...agentsExtraResourceTypes,
    ...knowledgeResourceTypes,
    ...modelsSafetyResourceTypes,
    ...qualityResourceTypes,
    ...operationsResourceTypes,
  ];

  // project              every lookup filters on the caller's project; a row without one is never resolved
  // project-or-tenant    the runtime falls back to (or accepts) a row without a project
  // tenant               no project concept
  const EXPECTED: Record<string, ResourceScope> = {
    agent: 'project',
    model: 'project',
    prompt: 'project',
    'memory-store': 'project',
    skill: 'project',
    // assignment based (projectId / projectIds): no assignment = unusable
    provider: 'project',
    'vector-index': 'project',
    'file-bucket': 'project',
    'evaluation-target': 'project',
    'evaluation-dataset': 'project',
    'evaluation-suite': 'project',
    'redteam-campaign': 'project',
    'redteam-custom-probe': 'project',
    'analysis-definition': 'project',
    'alert-rule': 'project',
    // tenant-wide fallback in bindingResolution / matchesProjectScope
    tool: 'project-or-tenant',
    'mcp-server': 'project-or-tenant',
    guardrail: 'project-or-tenant',
    'guardrail-word-list': 'project-or-tenant',
    'pii-policy': 'project-or-tenant',
    'rag-module': 'project-or-tenant',
    reranker: 'project-or-tenant',
    crawler: 'project-or-tenant',
    browser: 'project-or-tenant',
    'browser-flow': 'project-or-tenant',
    'config-group': 'project-or-tenant',
    'config-item': 'project-or-tenant',
    // the API stamps the active project when given one; without it the policy is tenant-wide
    'quota-policy': 'project-or-tenant',
    'inference-server': 'tenant',
  };

  it('is decided for every registered community type, and only for those', () => {
    expect(all.map((d) => d.type).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s -> %s', (type, scope) => {
    expect(all.find((d) => d.type === type)?.scope).toBe(scope);
  });

  it('every community type is edition community', () => {
    for (const d of all) expect(d.edition).toBe('community');
  });
});

describe('projectDisplay through the service', () => {
  const base = { tenantDbName: 'tenant_acme', tenantId: 't1' };
  const rec = (over: Partial<ResourceRecord> & { type: string; id: string }): ResourceRecord => ({
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
  });
  const def = (type: string, scope: ResourceScope, rows: ResourceRecord[]): ResourceTypeDefinition => ({
    type, service: 'agents', category: 'agents', scope, edition: 'community', list: async () => rows,
  });

  beforeEach(() => {
    resetResourceRegistryForTests();
    clearResourceCache();
    h.db.listProjects.mockReset().mockResolvedValue([
      { _id: 'p1', name: 'Retail' },
      { _id: 'p2', name: 'Corporate' },
    ]);
    h.db.listUsers.mockReset().mockResolvedValue([]);
  });
  afterEach(() => resetResourceRegistryForTests());

  const register = () => registerResourceTypes([
    def('agent', 'project', [rec({ type: 'agent', id: 'a1', projectId: 'p1' })]),
    def('tool', 'project-or-tenant', [rec({ type: 'tool', id: 't-wide' })]),
    def('gpu', 'tenant', [rec({ type: 'gpu', id: 'g1' })]),
    def('provider', 'project', [
      rec({ type: 'provider', id: 'pr-multi', projectId: 'p1', projectIds: ['p1', 'p2'] }),
      rec({ type: 'provider', id: 'pr-none' }),
    ]),
  ]);

  it('stamps every list row with its display', async () => {
    register();
    const res = await listResources(base);
    const by = Object.fromEntries(res.items.map((i) => [i.id, i.projectDisplay]));
    expect(by).toEqual({
      a1: { kind: 'project', projectId: 'p1', projectName: 'Retail' },
      't-wide': { kind: 'all-projects' },
      g1: { kind: 'tenant-level' },
      'pr-multi': { kind: 'multi-project', projectIds: ['p1', 'p2'], projectNames: ['Retail', 'Corporate'] },
      'pr-none': { kind: 'unassigned' },
    });
  });

  it('projectId=tenant means "not bound to a single project"; a project id also matches multi-assignments', async () => {
    register();
    const tenant = await listResources({ ...base, projectId: 'tenant' });
    expect(tenant.items.map((i) => i.id).sort()).toEqual(['g1', 'pr-none', 't-wide']);
    const p2 = await listResources({ ...base, projectId: 'p2' });
    expect(p2.items.map((i) => i.id)).toEqual(['pr-multi']);
    const p1 = await listResources({ ...base, projectId: 'p1' });
    expect(p1.items.map((i) => i.id).sort()).toEqual(['a1', 'pr-multi']);
    // facet counts follow the same filter
    expect(tenant.counts).toMatchObject({ agent: 0, tool: 1, gpu: 1, provider: 1 });
  });

  it('health carries the display on issue resources and filters with the same rule', async () => {
    registerResourceTypes([
      def('agent', 'project', [
        rec({ type: 'agent', id: 'a1', projectId: 'p1', edges: [{ kind: 'agent.tool', toType: 'tool', by: 'key', target: 'ghost', field: 'f' }] }),
      ]),
      def('tool', 'project-or-tenant', []),
      def('provider', 'project', [
        rec({ type: 'provider', id: 'x1', key: 'dup', projectId: 'p1', projectIds: ['p1', 'p2'] }),
        rec({ type: 'provider', id: 'x2', key: 'dup', projectId: 'p1', projectIds: ['p1', 'p2'] }),
      ]),
    ]);
    const all = await getResourceHealth(base);
    const agentIssue = all.issues.find((i) => i.resource.id === 'a1')!;
    expect(agentIssue.resource.projectDisplay).toEqual({ kind: 'project', projectId: 'p1', projectName: 'Retail' });
    const multi = all.issues.find((i) => i.resource.id === 'x1')!;
    expect(multi.resource.projectDisplay).toMatchObject({ kind: 'multi-project' });

    expect((await getResourceHealth({ ...base, projectId: 'p2' })).issues.map((i) => i.resource.id).sort()).toEqual(['x1', 'x2']);
    expect((await getResourceHealth({ ...base, projectId: 'tenant' })).issues).toEqual([]);
  });

  it('the usage view of a referenced row carries its display; a missing target has none', async () => {
    registerResourceTypes([
      def('agent', 'project', [
        rec({
          type: 'agent', id: 'a1', projectId: 'p1',
          edges: [
            { kind: 'agent.tool', toType: 'tool', by: 'key', target: 'wide', field: 'f1' },
            { kind: 'agent.tool', toType: 'tool', by: 'key', target: 'ghost', field: 'f2' },
          ],
        }),
      ]),
      def('tool', 'project-or-tenant', [rec({ type: 'tool', id: 't1', key: 'wide' })]),
    ]);
    const { getResource } = await import('@/lib/resources/service');
    const detail = (await getResource({ ...base, type: 'agent', id: 'a1' }))!;
    expect(detail.projectDisplay).toEqual({ kind: 'project', projectId: 'p1', projectName: 'Retail' });
    const ok = detail.uses.find((u) => u.field === 'f1')!;
    expect(ok.other.projectDisplay).toEqual({ kind: 'all-projects' });
    const missing = detail.uses.find((u) => u.field === 'f2')!;
    expect(missing.other.projectDisplay).toBeNull();
  });
});
