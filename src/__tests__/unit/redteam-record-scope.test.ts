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
}));

vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/database')>()),
  getDatabase: vi.fn(async () => db),
}));

import { runScheduledScans } from '@/lib/services/redteam/campaignJob';
import { createCustomProbe } from '@/lib/services/redteam/service';
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
    expect(db.listRedTeamRuns).toHaveBeenCalledWith({ projectId: 'proj-a', campaignKey: 'nightly', limit: 1 });
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
