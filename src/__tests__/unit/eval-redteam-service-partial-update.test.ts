/**
 * What the evaluation and red-team services hand the database on a PATCH: the
 * keys they were given and nothing else (an absent key must never become an
 * explicit `undefined`, which MongoDB stores as `null`), `null` as the way to
 * clear, and, for a custom probe, what clearing means (the values a create
 * would have stored, never a null).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: {
    switchToTenant: vi.fn(async () => undefined),
    findRedTeamCampaignById: vi.fn(),
    findRedTeamCustomProbeById: vi.fn(),
    updateRedTeamCampaign: vi.fn(),
    updateRedTeamCustomProbe: vi.fn(),
    updateEvaluationSuite: vi.fn(),
    updateEvaluationTarget: vi.fn(),
  },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: () => unknown) => fn()),
}));

import { updateSuite, updateTarget } from '@/lib/services/evaluation/service';
import { updateCampaign, updateCustomProbe } from '@/lib/services/redteam/service';

const echo = (_id: string, data: Record<string, unknown>) => ({ _id: 'rec-1', ...data });

beforeEach(() => {
  vi.clearAllMocks();
  h.db.updateRedTeamCampaign.mockImplementation(async (id: string, data: Record<string, unknown>) => echo(id, data));
  h.db.updateRedTeamCustomProbe.mockImplementation(async (id: string, data: Record<string, unknown>) => echo(id, data));
  h.db.updateEvaluationSuite.mockImplementation(async (id: string, data: Record<string, unknown>) => echo(id, data));
  h.db.updateEvaluationTarget.mockImplementation(async (id: string, data: Record<string, unknown>) => echo(id, data));
});

describe('updateCustomProbe', () => {
  it('puts back what a create would have stored when the description or the family is cleared', async () => {
    await updateCustomProbe('tenant', 'p1', 'ann', { description: null, family: null });

    expect(h.db.updateRedTeamCustomProbe).toHaveBeenCalledWith('p1', { description: '', family: 'custom', updatedBy: 'ann' });
  });

  it('treats a blank family as clearing it, and keeps text as it is', async () => {
    await updateCustomProbe('tenant', 'p1', 'ann', { description: 'Leaks the canary', family: '' });

    expect(h.db.updateRedTeamCustomProbe).toHaveBeenCalledWith('p1', { description: 'Leaks the canary', family: 'custom', updatedBy: 'ann' });
  });

  it('hands over only the keys it was given', async () => {
    await updateCustomProbe('tenant', 'p1', 'ann', { name: 'Renamed' });

    expect(h.db.updateRedTeamCustomProbe).toHaveBeenCalledWith('p1', { name: 'Renamed', updatedBy: 'ann' });
    expect(Object.keys(h.db.updateRedTeamCustomProbe.mock.calls[0][1]).sort()).toEqual(['name', 'updatedBy']);
  });
});

describe('updateCampaign', () => {
  it('passes null through as the way to clear, and no key that was not given', async () => {
    await updateCampaign('tenant', 'c1', 'ann', { description: null, judgeModelKey: null, schedule: null });

    expect(h.db.updateRedTeamCampaign).toHaveBeenCalledWith('c1', {
      description: null,
      judgeModelKey: null,
      schedule: null,
      updatedBy: 'ann',
    });
  });

  it('hands over only the keys it was given', async () => {
    await updateCampaign('tenant', 'c1', 'ann', { name: 'Renamed' });

    expect(Object.keys(h.db.updateRedTeamCampaign.mock.calls[0][1]).sort()).toEqual(['name', 'updatedBy']);
  });

  it('folds compliance into the stored metadata instead of replacing it, and adds no metadata key without it', async () => {
    h.db.findRedTeamCampaignById.mockResolvedValue({ _id: 'c1', metadata: { keep: 1 } });

    await updateCampaign('tenant', 'c1', 'ann', { compliance: { notes: 'EU high-risk' } });
    expect(h.db.updateRedTeamCampaign.mock.calls[0][1]).toEqual({
      metadata: { keep: 1, compliance: { notes: 'EU high-risk' } },
      updatedBy: 'ann',
    });

    await updateCampaign('tenant', 'c1', 'ann', { name: 'Renamed' });
    expect('metadata' in h.db.updateRedTeamCampaign.mock.calls[1][1]).toBe(false);
  });
});

describe('updateSuite and updateTarget', () => {
  it('pass null through as the way to clear, and no key that was not given', async () => {
    await updateSuite('tenant', 's1', 'ann', { description: null, judgeModelKey: null, embeddingModelKey: null });
    expect(h.db.updateEvaluationSuite).toHaveBeenCalledWith('s1', {
      description: null,
      judgeModelKey: null,
      embeddingModelKey: null,
      updatedBy: 'ann',
    });

    await updateTarget('tenant', 't1', 'ann', { description: null, retrievalTopK: null, systemPrompt: null, agentVersion: null });
    expect(h.db.updateEvaluationTarget).toHaveBeenCalledWith('t1', {
      description: null,
      retrievalTopK: null,
      systemPrompt: null,
      agentVersion: null,
      updatedBy: 'ann',
    });
  });

  it('hand over only the keys they were given', async () => {
    await updateSuite('tenant', 's1', 'ann', { name: 'Renamed' });
    await updateTarget('tenant', 't1', 'ann', { name: 'Renamed' });

    expect(Object.keys(h.db.updateEvaluationSuite.mock.calls[0][1]).sort()).toEqual(['name', 'updatedBy']);
    expect(Object.keys(h.db.updateEvaluationTarget.mock.calls[0][1]).sort()).toEqual(['name', 'updatedBy']);
  });
});
