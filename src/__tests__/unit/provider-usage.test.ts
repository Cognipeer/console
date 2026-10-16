/**
 * Where a provider is used: per project the models on it and the agents that use them,
 * plus the traffic of the last 7 days. Read before a provider is unassigned from a project.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  switchToTenant: vi.fn(async () => undefined),
  listProjects: vi.fn(),
  listModels: vi.fn(),
  listAgents: vi.fn(),
  listUsageDaily: vi.fn(),
}));
vi.mock('@/lib/database', () => ({ getDatabase: async () => db }));

import { assignedProjectIds, getProviderUsage } from '@/lib/services/providers/providerUsage';

const NOW = new Date('2026-10-15T12:00:00Z');
const provider = { key: 'azure-eu', projectId: undefined, projectIds: ['p1', 'p2'] };

beforeEach(() => {
  vi.clearAllMocks();
  db.listProjects.mockResolvedValue([
    { _id: 'p1', name: 'Support' },
    { _id: 'p2', name: 'Analytics' },
    { _id: 'p3', name: 'Billing' },
  ]);
  db.listModels.mockResolvedValue([
    { _id: 'm1', projectId: 'p1', key: 'gpt-chat', name: 'GPT chat', providerKey: 'azure-eu' },
    { _id: 'm2', projectId: 'p1', key: 'other', name: 'Other', providerKey: 'openai-main' },
    // pooled: azure-eu is a replica
    { _id: 'm3', projectId: 'p2', key: 'pooled', name: 'Pooled', providerKey: 'openai-main', replicas: [{ providerKey: 'azure-eu', modelId: 'd' }] },
    // a model of a project the provider is not assigned to is not counted
    { _id: 'm4', projectId: 'p3', key: 'stray', name: 'Stray', providerKey: 'azure-eu' },
  ]);
  db.listAgents.mockResolvedValue([
    { _id: 'a1', projectId: 'p1', name: 'Helper', config: { modelKey: 'gpt-chat' } },
    { _id: 'a2', projectId: 'p1', name: 'Other agent', config: { modelKey: 'other' } },
    { _id: 'a3', projectId: 'p2', name: 'Extra', config: { modelKey: 'zzz', additionalModels: [{ modelKey: 'pooled' }] } },
    // same model key in another project does not count
    { _id: 'a4', projectId: 'p3', name: 'Elsewhere', config: { modelKey: 'gpt-chat' } },
  ]);
  db.listUsageDaily.mockResolvedValue([
    { projectId: 'p1', refKey: 'gpt-chat', day: '2026-10-14', requests: 30 },
    { projectId: 'p1', refKey: 'gpt-chat', day: '2026-10-15', requests: 12 },
    { projectId: 'p1', refKey: 'other', day: '2026-10-15', requests: 999 },
    { projectId: 'p2', refKey: 'pooled', day: '2026-10-12', requests: 5 },
  ]);
});

describe('getProviderUsage', () => {
  it('lists assigned projects first with their models, agents and 7-day traffic', async () => {
    const usage = await getProviderUsage('tenant_x', 't1', provider, NOW);
    expect(usage.projects.map((p) => [p.projectId, p.assigned])).toEqual([
      ['p2', true], ['p1', true], ['p3', false],
    ]);
    const support = usage.projects.find((p) => p.projectId === 'p1')!;
    expect(support).toEqual({
      projectId: 'p1',
      name: 'Support',
      assigned: true,
      models: [{ id: 'm1', name: 'GPT chat' }],
      agents: [{ id: 'a1', name: 'Helper' }],
      requests7d: 42,
      lastUsedAt: '2026-10-15',
    });
    const analytics = usage.projects.find((p) => p.projectId === 'p2')!;
    expect(analytics.models).toEqual([{ id: 'm3', name: 'Pooled' }]);
    expect(analytics.agents).toEqual([{ id: 'a3', name: 'Extra' }]);
    expect(analytics.requests7d).toBe(5);
  });

  it('carries no models for a project the provider is not assigned to', async () => {
    const usage = await getProviderUsage('tenant_x', 't1', provider, NOW);
    expect(usage.projects.find((p) => p.projectId === 'p3')).toEqual({
      projectId: 'p3', name: 'Billing', assigned: false, models: [], agents: [],
    });
  });

  it('reads the tenant once per kind (no read per project) and only the 7-day window', async () => {
    await getProviderUsage('tenant_x', 't1', provider, NOW);
    expect(db.listModels).toHaveBeenCalledTimes(1);
    expect(db.listAgents).toHaveBeenCalledTimes(1);
    expect(db.listUsageDaily).toHaveBeenCalledTimes(1);
    expect(db.listUsageDaily).toHaveBeenCalledWith(expect.objectContaining({ service: 'models', fromDay: '2026-10-09', toDay: '2026-10-15' }));
  });

  it('reports zero requests for a project with models and no traffic', async () => {
    db.listUsageDaily.mockResolvedValue([]);
    const usage = await getProviderUsage('tenant_x', 't1', provider, NOW);
    const support = usage.projects.find((p) => p.projectId === 'p1')!;
    expect(support.requests7d).toBe(0);
    expect(support.lastUsedAt).toBeUndefined();
  });

  it('skips the agent and usage reads when nothing runs on the provider', async () => {
    db.listModels.mockResolvedValue([]);
    const usage = await getProviderUsage('tenant_x', 't1', provider, NOW);
    expect(db.listAgents).not.toHaveBeenCalled();
    expect(db.listUsageDaily).not.toHaveBeenCalled();
    expect(usage.projects.every((p) => p.models.length === 0 && p.requests7d === undefined)).toBe(true);
  });

  it('an unassigned provider has no usage at all', async () => {
    const usage = await getProviderUsage('tenant_x', 't1', { key: 'azure-eu', projectIds: [] }, NOW);
    expect(db.listModels).not.toHaveBeenCalled();
    expect(usage.projects.every((p) => !p.assigned)).toBe(true);
  });
});

describe('assignedProjectIds', () => {
  it('merges the legacy project and the list without duplicates', () => {
    expect(assignedProjectIds({ projectId: 'a', projectIds: ['b', 'a'] })).toEqual(['a', 'b']);
    expect(assignedProjectIds({})).toEqual([]);
  });
});
