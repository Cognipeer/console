/**
 * Adding providers to a project in bulk (the project create screen): a platform provider is assignable like any
 * provider, and its platform models' cache entries are dropped for the projects concerned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ invalidate: vi.fn(async () => undefined) }));

vi.mock('@/lib/services/models/modelService', () => ({ invalidatePlatformProviderModelCaches: hoisted.invalidate }));

import { applyProjectExtras } from '@/lib/services/projects/projectMembership';

const provider = (overrides: Record<string, unknown> = {}) => ({
  _id: 'prov-1', tenantId: 't1', key: 'plat', label: 'Platform', type: 'model', platform: true, projectIds: ['p1'], ...overrides,
});

const run = async (providers: Array<Record<string, unknown>>, tenantDbName: string | null = 'db') => {
  const db = { listProviders: vi.fn(async () => providers), updateProvider: vi.fn(async () => ({})) };
  const warnings = await applyProjectExtras(db as never, {
    tenantId: 't1', actorUserId: 'u1', projectId: 'p2', members: [], groups: [],
    providerIds: providers.map((p) => String(p._id)), tenantDbName: tenantDbName ?? undefined,
  });
  return { db, warnings };
};

beforeEach(() => vi.clearAllMocks());

describe('applyProjectExtras and platform providers', () => {
  it('assigns a platform provider to the project and drops its model caches for old and new projects', async () => {
    const { db, warnings } = await run([provider()]);
    expect(warnings).toEqual([]);
    expect(db.updateProvider).toHaveBeenCalledWith('prov-1', { projectIds: ['p1', 'p2'], updatedBy: 'u1' });
    expect(hoisted.invalidate).toHaveBeenCalledWith('db', 'plat', ['p1', 'p2']);
  });

  it('does not touch caches for an ordinary provider, or without a tenant database', async () => {
    await run([provider({ platform: undefined })]);
    expect(hoisted.invalidate).not.toHaveBeenCalled();
    await run([provider()], null);
    expect(hoisted.invalidate).not.toHaveBeenCalled();
  });

  it('still skips a provider of one specific project (legacy single projectId)', async () => {
    const { db, warnings } = await run([provider({ projectId: 'p9' })]);
    expect(db.updateProvider).not.toHaveBeenCalled();
    expect(warnings).toEqual(['Provider "Platform" was skipped: it belongs to another project.']);
  });
});
