import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: { listProjects: vi.fn(), listUsers: vi.fn() } as unknown,
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));

import {
  getEnterpriseResourceContributions,
  registerEnterpriseResources,
  resetEnterpriseResourcesForTests,
} from '@/enterprise/resource-providers';
import { buildResourceGraph } from '@/lib/resources/graph';
import {
  EDGE_KINDS,
  createEdgeCollector,
  defineEdgeKind,
  getEdgeKindDefinition,
  listEdgeKindDefinitions,
  registerEdgeKindDefinitions,
  resetExtraEdgeKindsForTests,
} from '@/lib/resources/references';
import {
  communityResourceTypes,
  ensureCommunityResourceTypesRegistered,
  resetCommunityRegistrationForTests,
} from '@/lib/resources/providers';
import { extractAgentEdges } from '@/lib/resources/providers/core';
import { extractMcpEdges } from '@/lib/resources/providers/agentsExtra';
import {
  getResourceTypeDefinition,
  listResourceTypeDefinitions,
  resetResourceRegistryForTests,
} from '@/lib/resources/registry';
import { clearResourceCache, getResource, listResources } from '@/lib/resources/service';
import type { ResourceRecord, ResourceTypeDefinition } from '@/lib/resources/types';

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

const eeType = (type: string, rows: ResourceRecord[] = []): ResourceTypeDefinition => ({
  type,
  service: 'sandbox',
  category: 'infrastructure',
  scope: 'project-or-tenant',
  edition: 'enterprise',
  list: async () => rows,
});

const eeKind = () => defineEdgeKind('test.enterpriseKind', 'test-source', 'sandbox-template', 'tenant', 'warning', {
  by: 'id', alsoByKey: true,
});

function resetAll() {
  resetEnterpriseResourcesForTests();
  resetExtraEdgeKindsForTests();
  resetResourceRegistryForTests();
  resetCommunityRegistrationForTests();
  clearResourceCache();
}

describe('enterprise resource seam', () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  it('is empty until the overlay registers something', () => {
    expect(getEnterpriseResourceContributions()).toEqual({ types: [], edgeKinds: [] });
  });

  it('registers types and edge kinds, idempotently per type id / kind', () => {
    const first = eeType('sandbox-template');
    const kind = eeKind();
    registerEnterpriseResources({ types: [first], edgeKinds: [kind] });
    registerEnterpriseResources({ types: [first], edgeKinds: [kind] });
    // later duplicates are ignored, the FIRST registration wins
    const imposter = { ...eeType('sandbox-template'), category: 'agents' as const };
    registerEnterpriseResources({ types: [imposter, eeType('sandbox-volume')], edgeKinds: [{ ...kind, severity: 'error' }] });

    const got = getEnterpriseResourceContributions();
    expect(got.types.map((t) => t.type)).toEqual(['sandbox-template', 'sandbox-volume']);
    expect(got.types[0]).toBe(first);
    expect(got.edgeKinds).toEqual([kind]);
  });

  it('accepts a partial contribution', () => {
    registerEnterpriseResources({});
    registerEnterpriseResources({ types: [eeType('gpu-host')] });
    registerEnterpriseResources({ edgeKinds: [eeKind()] });
    expect(getEnterpriseResourceContributions().types).toHaveLength(1);
    expect(getEnterpriseResourceContributions().edgeKinds).toHaveLength(1);
  });

  it('ensureCommunityResourceTypesRegistered folds the contributions in, every time it runs', () => {
    ensureCommunityResourceTypesRegistered();
    expect(listResourceTypeDefinitions()).toHaveLength(communityResourceTypes.length);
    expect(getEdgeKindDefinition('test.enterpriseKind')).toBeUndefined();

    // a contribution that arrives AFTER the first ensure is still picked up
    registerEnterpriseResources({ types: [eeType('sandbox-template')], edgeKinds: [eeKind()] });
    ensureCommunityResourceTypesRegistered();
    ensureCommunityResourceTypesRegistered();
    expect(getResourceTypeDefinition('sandbox-template')?.edition).toBe('enterprise');
    expect(listResourceTypeDefinitions()).toHaveLength(communityResourceTypes.length + 1);
    expect(getEdgeKindDefinition('test.enterpriseKind')?.toType).toBe('sandbox-template');

    registerEnterpriseResources({ types: [eeType('gpu-host')] });
    ensureCommunityResourceTypesRegistered();
    expect(getResourceTypeDefinition('gpu-host')).toBeDefined();
  });

  it('an enterprise type that clashes with a community type id does not break registration', () => {
    registerEnterpriseResources({ types: [eeType('agent'), eeType('sandbox-template')] });
    expect(() => ensureCommunityResourceTypesRegistered()).not.toThrow();
    expect(getResourceTypeDefinition('agent')?.edition).toBe('community');
    expect(getResourceTypeDefinition('sandbox-template')).toBeDefined();
  });

  it('edge kinds: the frozen community set is untouched; an extra cannot shadow a community kind', () => {
    const before = Object.keys(EDGE_KINDS).length;
    const added = registerEdgeKindDefinitions([
      eeKind(),
      defineEdgeKind('agent.model', 'agent', 'model', 'tenant', 'warning'),
    ]);
    expect(added).toEqual(['test.enterpriseKind']);
    expect(Object.keys(EDGE_KINDS)).toHaveLength(before);
    expect(getEdgeKindDefinition('agent.model')?.severity).toBe('error');
    expect(listEdgeKindDefinitions().map((d) => d.kind)).toContain('test.enterpriseKind');
    // idempotent
    expect(registerEdgeKindDefinitions([eeKind()])).toEqual([]);
  });

  it('an extractor can use a registered enterprise kind and still rejects an unknown one', () => {
    registerEdgeKindDefinitions([eeKind()]);
    const c = createEdgeCollector('test-source');
    c.add('test.enterpriseKind', 'tpl-1', 'templateId');
    expect(c.done()).toEqual([
      { kind: 'test.enterpriseKind', toType: 'sandbox-template', by: 'id', target: 'tpl-1', field: 'templateId' },
    ]);
    expect(() => createEdgeCollector('test-source').add('sandbox.nope', 'x', 'f')).toThrow(/Unknown/);
  });
});

describe('community edges that point at enterprise types', () => {
  it('agent.sandboxTemplate reads config.sandbox.templateKey, only while the sandbox is enabled', () => {
    const edges = extractAgentEdges({ config: { sandbox: { enabled: true, templateKey: 'multi-base' } } });
    expect(edges).toEqual([
      { kind: 'agent.sandboxTemplate', toType: 'sandbox-template', by: 'key', target: 'multi-base', field: 'config.sandbox.templateKey' },
    ]);
    // no explicit enabled: the runtime never builds sandbox tools for it, so it references nothing
    expect(extractAgentEdges({ config: { sandbox: { templateKey: 'multi-base' } } })).toBeUndefined();
    expect(extractAgentEdges({ config: { sandbox: { enabled: false, templateKey: 'multi-base' } } })).toBeUndefined();
    expect(extractAgentEdges({ config: { sandbox: { enabled: true } } })).toBeUndefined();
  });

  it('mcp.sandboxTemplate reads stdioConfig.sandbox.templateKey for sandboxed stdio servers only', () => {
    const sandboxed = { stdioConfig: { executionMode: 'sandbox', sandbox: { templateKey: 'node-20', instanceId: 'i-1' } } };
    expect(extractMcpEdges(sandboxed)).toEqual([
      { kind: 'mcp.sandboxTemplate', toType: 'sandbox-template', by: 'key', target: 'node-20', field: 'stdioConfig.sandbox.templateKey' },
    ]);
    expect(extractMcpEdges({ stdioConfig: { executionMode: 'local', sandbox: { templateKey: 'node-20' } } })).toBeUndefined();
  });

  it('the kinds are tenant scoped errors (resolveTemplateIdByKey throws on an unknown key)', () => {
    for (const k of ['agent.sandboxTemplate', 'mcp.sandboxTemplate']) {
      expect(EDGE_KINDS[k]).toMatchObject({ toType: 'sandbox-template', scope: 'tenant', severity: 'error', by: 'key' });
    }
  });
});

describe('edges to a type this build does not have', () => {
  const base = { tenantDbName: 'tenant_acme', tenantId: 't1' };
  const agent = (id = 'a1') => rec({
    type: 'agent', id, projectId: 'p1',
    edges: [
      { kind: 'agent.sandboxTemplate', toType: 'sandbox-template', by: 'key', target: 'multi-base', field: 'config.sandbox.templateKey' },
      { kind: 'agent.tool', toType: 'tool', by: 'key', target: 'ghost', field: 'config.toolBindings[0].sourceKey' },
    ],
  });

  it('graph: dropped silently when knownTypes lacks the target type, resolved when it has it', () => {
    const records = [agent(), rec({ type: 'tool', id: 't1', key: 'real', projectId: 'p1' })];
    const without = buildResourceGraph({ tenantId: 't1', records, projects: [], knownTypes: new Set(['agent', 'tool']) });
    expect(without.usesOf('agent', 'a1').map((u) => u.kind)).toEqual(['agent.tool']);
    expect(without.issues.map((i) => i.edgeKind)).toEqual(['agent.tool']);

    const withEe = buildResourceGraph({ tenantId: 't1', records, projects: [], knownTypes: new Set(['agent', 'tool', 'sandbox-template']) });
    expect(withEe.issues.map((i) => i.edgeKind).sort()).toEqual(['agent.sandboxTemplate', 'agent.tool']);

    // not given: everything is resolved (pure-graph callers)
    expect(buildResourceGraph({ tenantId: 't1', records, projects: [] }).issues).toHaveLength(2);
  });

  describe('service (real community registration)', () => {
    // Every list method answers [] except the agents: the agent binds a sandbox template and a missing tool.
    const rawAgent = {
      _id: 'a1', key: 'a1', name: 'Agent', projectId: 'p1', tenantId: 't1',
      config: {
        sandbox: { enabled: true, templateKey: 'multi-base' },
        toolBindings: [{ source: 'tool', sourceKey: 'ghost' }],
      },
    };
    const fakeDb = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop: string) => {
        if (prop === 'listProjects') return async () => [{ _id: 'p1', name: 'Retail' }];
        if (prop === 'listAgents') return async () => [rawAgent];
        return async () => [];
      },
    });

    beforeEach(() => {
      resetAll();
      h.db = fakeDb as never;
    });
    afterEach(() => {
      resetAll();
      h.db = { listProjects: vi.fn(), listUsers: vi.fn() } as never;
    });

    const issueKinds = async () =>
      (await getResource({ ...base, type: 'agent', id: 'a1' }))!.issues.map((i) => i.edgeKind).sort();

    it('community build: the template edge is not checkable, so it is neither a use nor a finding', async () => {
      const detail = (await getResource({ ...base, type: 'agent', id: 'a1' }))!;
      expect(detail.uses.map((u) => u.kind)).toEqual(['agent.tool']);
      expect(await issueKinds()).toEqual(['agent.tool']);
      expect((await listResources(base)).types.map((t) => t.type)).not.toContain('sandbox-template');
    });

    it('enterprise build: a missing template is reported; an existing one resolves', async () => {
      const templates: ResourceRecord[] = [];
      registerEnterpriseResources({ types: [{ ...eeType('sandbox-template'), list: async () => templates }] });
      expect(await issueKinds()).toEqual(['agent.sandboxTemplate', 'agent.tool']);

      templates.push(rec({ type: 'sandbox-template', id: 'st1', key: 'multi-base', projectId: null }));
      clearResourceCache();
      const detail = (await getResource({ ...base, type: 'agent', id: 'a1' }))!;
      expect(detail.uses.find((u) => u.kind === 'agent.sandboxTemplate')).toMatchObject({
        status: 'ok',
        other: { type: 'sandbox-template', id: 'st1', projectDisplay: { kind: 'all-projects' } },
      });
      expect(await issueKinds()).toEqual(['agent.tool']);
      const list = await listResources(base);
      expect(list.types.find((t) => t.type === 'sandbox-template')).toMatchObject({ edition: 'enterprise' });
    });

    describe('per-tenant entitlement (isAvailable)', () => {
      const entitledTemplate = (isAvailable: () => Promise<boolean>) => {
        const list = vi.fn(async () => [rec({ type: 'sandbox-template', id: 'st1', key: 'multi-base' })]);
        registerEnterpriseResources({ types: [{ ...eeType('sandbox-template'), isAvailable, list }] });
        return list;
      };

      it('not entitled: list() is never called, the type is hidden and edges to it are dropped', async () => {
        const list = entitledTemplate(async () => false);
        const result = await listResources(base);
        expect(list).not.toHaveBeenCalled();
        expect(result.types.map((t) => t.type)).not.toContain('sandbox-template');
        expect(result.counts).not.toHaveProperty('sandbox-template');
        expect(result.items.some((i) => i.type === 'sandbox-template')).toBe(false);
        // the agent still binds a template, but the tenant cannot use sandboxes: not a finding
        expect(await issueKinds()).toEqual(['agent.tool']);
        expect(await getResource({ ...base, type: 'sandbox-template', id: 'st1' })).toBeNull();
      });

      it('a failing entitlement check fails closed', async () => {
        const list = entitledTemplate(async () => { throw new Error('license db down'); });
        const result = await listResources(base);
        expect(list).not.toHaveBeenCalled();
        expect(result.types.map((t) => t.type)).not.toContain('sandbox-template');
        expect(result.errors).toEqual([]);
      });

      it('entitled: listed and counted like any type', async () => {
        const list = entitledTemplate(async () => true);
        const result = await listResources(base);
        expect(list).toHaveBeenCalledTimes(1);
        expect(result.counts['sandbox-template']).toBe(1);
        expect(await issueKinds()).toEqual(['agent.tool']);
      });
    });
  });
});
