/**
 * Smaller pieces of keeping red-team records apart: the scheduler reads a
 * campaign's last run in that campaign's own project, the Mongo search treats
 * its term as text, and the pattern limits of a custom probe apply to what is
 * new on an update, not to a list that was stored before the limits existed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  switchToTenant: vi.fn(async () => undefined),
  listRedTeamCampaigns: vi.fn(),
  listRedTeamRuns: vi.fn(),
  findRedTeamCustomProbeByKey: vi.fn(async () => null),
  createRedTeamCustomProbe: vi.fn(async (probe: Record<string, unknown>) => ({ _id: 'probe-1', ...probe })),
}));

vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/database')>()),
  getDatabase: vi.fn(async () => db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(db)),
}));

import { runScheduledScans } from '@/lib/services/redteam/campaignJob';
import { createCustomProbe, isDuplicateKeyError, RedTeamConflictError } from '@/lib/services/redteam/service';
import { CustomProbeError, validateCustomProbePatterns } from '@/lib/services/redteam/probes';
import { MAX_PATTERNS_PER_ATTEMPT } from '@/lib/services/redteam/detectors/safePattern';
import { RedTeamMixin } from '@/lib/database/mongodb/redteam.mixin';
import { MongoDBProviderBase } from '@/lib/database/mongodb/base';

describe('scheduled scans', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the last run of a campaign in the campaign\'s own project', async () => {
    db.listRedTeamCampaigns.mockResolvedValue([
      { key: 'nightly', projectId: 'proj-a', targetKind: 'model', schedule: { cron: '0 3 * * *', enabled: true } },
    ]);
    // A run that just started: the slot is not due, so nothing is enqueued.
    db.listRedTeamRuns.mockResolvedValue([{ startedAt: new Date(), createdAt: new Date() }]);

    const result = await runScheduledScans('tenant_db', 'tenant-1', new Date());

    expect(result.fired).toEqual([]);
    expect(db.listRedTeamRuns).toHaveBeenCalledWith({ projectId: 'proj-a', campaignKey: 'nightly', limit: 1, omitAttempts: true });
  });
});

describe('Mongo red-team search', () => {
  it('matches the term as text, not as a regex', async () => {
    let seen: Record<string, unknown> | undefined;
    const collection = {
      find: (filter: Record<string, unknown>) => {
        seen = filter;
        return { sort: () => ({ toArray: async () => [] }) };
      },
    };
    const Ops = RedTeamMixin(MongoDBProviderBase as never) as unknown as { prototype: object };
    const ops = Object.create(Ops.prototype) as {
      getTenantDb: () => unknown;
      listRedTeamCampaigns: (f: { search: string }) => Promise<unknown[]>;
      listRedTeamCustomProbes: (f: { search: string }) => Promise<unknown[]>;
    };
    ops.getTenantDb = () => ({ collection: () => collection });

    await ops.listRedTeamCampaigns({ search: 'a.*(' });
    expect((seen?.$or as Array<{ name?: { $regex: string } }>)[0].name?.$regex).toBe('a\\.\\*\\(');

    await ops.listRedTeamCustomProbes({ search: 'x+' });
    expect((seen?.$or as Array<{ name?: { $regex: string } }>)[0].name?.$regex).toBe('x\\+');
  });
});

describe('custom probe identity and category', () => {
  beforeEach(() => vi.clearAllMocks());

  const input =(over: Record<string, unknown> = {}) => ({
    name: 'Probe',
    category: 'LLM01-prompt-injection',
    severity: 'high' as const,
    attempts: [{ id: 'a1', turns: ['hi'] }],
    detectors: { refusal: true, pattern: false, judges: [] },
    projectId: 'proj-a',
    ...over,
  });

  it('stores a category given in the older numbering under its 2025 key', async () => {
    const probe = await createCustomProbe('tenant_db', 'tenant-1', 'user-1', input({ category: 'LLM08-excessive-agency' }));

    expect(probe.category).toBe('LLM06-excessive-agency');
    expect(db.createRedTeamCustomProbe).toHaveBeenCalledWith(expect.objectContaining({ category: 'LLM06-excessive-agency' }));
  });

  it('takes a new key and tries again after a duplicate-key error, then gives up with a conflict', async () => {
    const dup = () => Object.assign(new Error('UNIQUE constraint failed: redteam_custom_probes.key'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    db.createRedTeamCustomProbe.mockRejectedValueOnce(dup());
    const probe = await createCustomProbe('tenant_db', 'tenant-1', 'user-1', input());
    expect(probe.key).toBeTruthy();
    expect(db.createRedTeamCustomProbe).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    db.createRedTeamCustomProbe.mockRejectedValue(dup());
    await expect(createCustomProbe('tenant_db', 'tenant-1', 'user-1', input())).rejects.toBeInstanceOf(RedTeamConflictError);
    expect(db.createRedTeamCustomProbe).toHaveBeenCalledTimes(3);
    db.createRedTeamCustomProbe.mockImplementation(async (p: Record<string, unknown>) => ({ _id: 'probe-1', ...p }));
  });

  it('recognises duplicate-key errors of both providers', () => {
    expect(isDuplicateKeyError(Object.assign(new Error('x'), { code: 11000 }))).toBe(true);
    expect(isDuplicateKeyError(new Error('E11000 duplicate key error'))).toBe(true);
    expect(isDuplicateKeyError(new Error('UNIQUE constraint failed: t.key'))).toBe(true);
    expect(isDuplicateKeyError(new Error('disk full'))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });

  it('refuses a category that is not on the list', async () => {
    await expect(createCustomProbe('tenant_db', 'tenant-1', 'user-1', input({ category: 'LLM99-made-up' })))
      .rejects.toBeInstanceOf(CustomProbeError);
    expect(db.createRedTeamCustomProbe).not.toHaveBeenCalled();
  });

  it('refuses attempt ids that are not plain tokens or repeat inside the probe', async () => {
    await expect(createCustomProbe('tenant_db', 'tenant-1', 'user-1', input({ attempts: [{ id: 'has space', turns: ['hi'] }] })))
      .rejects.toThrow(/attempt id/);
    await expect(createCustomProbe('tenant_db', 'tenant-1', 'user-1', input({ attempts: [{ id: 'x'.repeat(65), turns: ['hi'] }] })))
      .rejects.toThrow(/attempt id/);
    await expect(createCustomProbe('tenant_db', 'tenant-1', 'user-1', input({
      attempts: [{ id: 'a1', turns: ['hi'] }, { id: 'a1', turns: ['again'] }],
    }))).rejects.toThrow(/used twice/);
    expect(db.createRedTeamCustomProbe).not.toHaveBeenCalled();
  });
});

describe('custom probe pattern limits', () => {
  const tooMany = Array.from({ length: MAX_PATTERNS_PER_ATTEMPT + 5 }, (_, i) => `p${i}`);

  it('refuses a new probe whose attempt has too many patterns', async () => {
    await expect(createCustomProbe('tenant_db', 'tenant-1', 'user-1', {
      name: 'Too many',
      category: 'LLM01-prompt-injection',
      severity: 'high',
      attempts: [{ id: 'a1', turns: ['hi'], forbiddenPatterns: tooMany }],
      detectors: { refusal: true, pattern: true, judges: [] },
      projectId: 'proj-a',
    })).rejects.toBeInstanceOf(CustomProbeError);
  });

  it('lets an update keep a stored list that predates the limits', () => {
    const stored = [{ id: 'a1', forbiddenPatterns: tooMany }];
    expect(() => validateCustomProbePatterns([{ id: 'a1', forbiddenPatterns: [...tooMany] }], stored)).not.toThrow();
  });

  it('checks a list that an update changes, and a new attempt', () => {
    const stored = [{ id: 'a1', forbiddenPatterns: tooMany }];
    expect(() => validateCustomProbePatterns([{ id: 'a1', forbiddenPatterns: [...tooMany, 'one more'] }], stored))
      .toThrow(CustomProbeError);
    expect(() => validateCustomProbePatterns([{ id: 'a2', forbiddenPatterns: tooMany }], stored)).toThrow(CustomProbeError);
  });
});
