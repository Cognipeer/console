/**
 * `updatePiiPolicy` MERGES `detection` into the stored value. A client that
 * only sends `minConfidence` (the dashboard does) must not wipe a stored
 * `mode`/`ner` it never saw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  findPiiPolicyById: vi.fn(),
  updatePiiPolicy: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => hoisted),
}));

import { updatePiiPolicy } from '@/lib/services/pii/piiService';

const STORED = {
  _id: 'p1',
  key: 'firstpolicy',
  name: 'FirstPolicy',
  tenantId: 't1',
  defaultAction: 'block',
  categories: {},
  customPatterns: [],
  languages: ['tr'],
  enabled: true,
  createdBy: 'u1',
  detection: { mode: 'pattern+dictionary', minConfidence: 0.2, contextBoost: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.findPiiPolicyById.mockResolvedValue(STORED);
  hoisted.updatePiiPolicy.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({ ...STORED, ...data }));
});

describe('updatePiiPolicy · detection', () => {
  it('merges a partial detection into the stored one', async () => {
    await updatePiiPolicy('tenant_t1', 'p1', 'u2', { detection: { minConfidence: 0.6 } });
    expect(hoisted.updatePiiPolicy).toHaveBeenCalledWith('p1', expect.objectContaining({
      detection: { mode: 'pattern+dictionary', minConfidence: 0.6, contextBoost: true },
      updatedBy: 'u2',
    }));
  });

  it('leaves detection untouched (and skips the read) when the field is absent', async () => {
    await updatePiiPolicy('tenant_t1', 'p1', 'u2', { name: 'Renamed' });
    expect(hoisted.findPiiPolicyById).not.toHaveBeenCalled();
    const data = hoisted.updatePiiPolicy.mock.calls[0][1] as Record<string, unknown>;
    expect(data.detection).toBeUndefined();
  });

  it('returns null for a missing policy without writing', async () => {
    hoisted.findPiiPolicyById.mockResolvedValue(null);
    expect(await updatePiiPolicy('tenant_t1', 'nope', 'u2', { detection: { minConfidence: 0.6 } })).toBeNull();
    expect(hoisted.updatePiiPolicy).not.toHaveBeenCalled();
  });
});
