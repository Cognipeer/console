/**
 * Unit tests — QuotaService
 * Tests: getPlanDefaults, listQuotaPolicies, createQuotaPolicy, updateQuotaPolicy, deleteQuotaPolicy
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/quota/planLimits', () => ({
  getPlanQuotaLimits: vi.fn().mockReturnValue({
    requestsPerMonth: 10_000,
    maxModels: 5,
    maxVectorIndexes: 3,
  }),
}));

import { getDatabase } from '@/lib/database';
import { getPlanQuotaLimits } from '@/lib/quota/planLimits';
import { createMockDb } from '../helpers/db.mock';
import {
  listQuotaPolicies,
  createQuotaPolicy,
  updateQuotaPolicy,
  deleteQuotaPolicy,
  getPlanDefaults,
} from '@/lib/services/quota/quotaService';
import type { IQuotaPolicy } from '@/lib/database/provider.interface';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';

function makePolicy(overrides: Partial<IQuotaPolicy> = {}): IQuotaPolicy {
  return {
    _id: 'policy-1',
    tenantId: TENANT_ID,
    label: 'Rate Limit Policy',
    domain: 'llm',
    scope: 'tenant',
    priority: 100,
    enabled: true,
    projectId: PROJECT_ID,
    limits: { rateLimit: { requests: { perMinute: 60 } } },
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ── getPlanDefaults ───────────────────────────────────────────────────────────

describe('getPlanDefaults', () => {
  it('delegates to getPlanQuotaLimits and returns the result', async () => {
    const result = await getPlanDefaults('FREE');
    expect(getPlanQuotaLimits).toHaveBeenCalledWith('FREE');
    expect(result.requestsPerMonth).toBe(10_000);
  });

  it('returns plan limits for different license types', async () => {
    (getPlanQuotaLimits as ReturnType<typeof vi.fn>).mockReturnValueOnce({ requestsPerMonth: 100_000 });
    const result = await getPlanDefaults('PROFESSIONAL');
    expect(result.requestsPerMonth).toBe(100_000);
  });
});

// ── listQuotaPolicies ─────────────────────────────────────────────────────────

describe('listQuotaPolicies', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listQuotaPolicies.mockResolvedValue([makePolicy()]);
  });

  it('returns all policies for the tenant', async () => {
    const result = await listQuotaPolicies(TENANT_DB, TENANT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Rate Limit Policy');
  });

  it('calls switchToTenant with correct DB name', async () => {
    await listQuotaPolicies(TENANT_DB, TENANT_ID);
    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
  });

  it('filters by domain when provided (includes global policies too)', async () => {
    db.listQuotaPolicies.mockResolvedValue([
      makePolicy({ domain: 'llm' }),
      makePolicy({ _id: 'p2', domain: 'tracing' }),
      makePolicy({ _id: 'p3', domain: 'global' }), // global is always included
    ]);

    const result = await listQuotaPolicies(TENANT_DB, TENANT_ID, { domain: 'llm' });
    // 'llm' + 'global' match
    expect(result.length).toBe(2);
    expect(result.every((p) => p.domain === 'llm' || p.domain === 'global')).toBe(true);
  });

  it('filters by scope when provided', async () => {
    db.listQuotaPolicies.mockResolvedValue([
      makePolicy({ scope: 'tenant' }),
      makePolicy({ _id: 'p2', scope: 'user' }),
    ]);

    const result = await listQuotaPolicies(TENANT_DB, TENANT_ID, { scope: 'tenant' });
    expect(result).toHaveLength(1);
    expect(result[0].scope).toBe('tenant');
  });

  it('filters by enabled flag', async () => {
    db.listQuotaPolicies.mockResolvedValue([
      makePolicy({ enabled: true }),
      makePolicy({ _id: 'p2', enabled: false }),
    ]);

    const result = await listQuotaPolicies(TENANT_DB, TENANT_ID, { enabled: false });
    expect(result).toHaveLength(1);
    expect(result[0].enabled).toBe(false);
  });

  it('normalizes _id to string', async () => {
    const result = await listQuotaPolicies(TENANT_DB, TENANT_ID);
    expect(typeof result[0]._id).toBe('string');
  });

  it('returns empty array when no policies exist', async () => {
    db.listQuotaPolicies.mockResolvedValue([]);
    const result = await listQuotaPolicies(TENANT_DB, TENANT_ID);
    expect(result).toHaveLength(0);
  });
});

// ── createQuotaPolicy ─────────────────────────────────────────────────────────

describe('createQuotaPolicy', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.createQuotaPolicy.mockResolvedValue(makePolicy());
  });

  it('creates a quota policy and returns a normalized view', async () => {
    const input = {
      scope: 'tenant' as const,
      domain: 'llm' as const,
      priority: 100,
      enabled: true,
      label: 'New Policy',
      limits: { rateLimit: { requests: { perMinute: 30 } } },
    };

    const result = await createQuotaPolicy(TENANT_DB, TENANT_ID, input);

    expect(db.createQuotaPolicy).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(typeof result._id).toBe('string');
  });

  it('passes tenantId to db.createQuotaPolicy', async () => {
    await createQuotaPolicy(TENANT_DB, TENANT_ID, {
      scope: 'tenant' as const,
      domain: 'vector' as const,
      priority: 50,
      enabled: true,
      limits: {},
    });

    const call = db.createQuotaPolicy.mock.calls[0][0];
    expect(call.tenantId).toBe(TENANT_ID);
  });

  it('sets createdAt and updatedAt timestamps', async () => {
    const before = Date.now();

    await createQuotaPolicy(TENANT_DB, TENANT_ID, {
      scope: 'token' as const,
      domain: 'tracing' as const,
      priority: 10,
      enabled: true,
      limits: {},
    });

    const call = db.createQuotaPolicy.mock.calls[0][0];
    expect(call.createdAt).toBeInstanceOf(Date);
    expect((call.createdAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(call.updatedAt).toBeInstanceOf(Date);
  });

  it('switches to correct tenant DB before creating', async () => {
    await createQuotaPolicy(TENANT_DB, TENANT_ID, {
      scope: 'tenant' as const,
      domain: 'llm' as const,
      priority: 100,
      enabled: false,
      limits: {},
    });

    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
  });
});

// ── updateQuotaPolicy ─────────────────────────────────────────────────────────

describe('updateQuotaPolicy', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns updated policy when found', async () => {
    const updated = makePolicy({ label: 'Updated Policy' });
    db.updateQuotaPolicy.mockResolvedValue(updated);

    const result = await updateQuotaPolicy(TENANT_DB, TENANT_ID, 'policy-1', {
      label: 'Updated Policy',
    });

    expect(result).not.toBeNull();
    expect(result!.label).toBe('Updated Policy');
  });

  it('returns null when policy is not found', async () => {
    db.updateQuotaPolicy.mockResolvedValue(null);

    const result = await updateQuotaPolicy(TENANT_DB, TENANT_ID, 'nonexistent', {
      label: 'X',
    });

    expect(result).toBeNull();
  });

  it('adds updatedAt timestamp to the update payload', async () => {
    db.updateQuotaPolicy.mockResolvedValue(makePolicy());
    const before = Date.now();

    await updateQuotaPolicy(TENANT_DB, TENANT_ID, 'policy-1', { label: 'X' });

    const payloadArg = db.updateQuotaPolicy.mock.calls[0][2];
    expect(payloadArg.updatedAt).toBeInstanceOf(Date);
    expect((payloadArg.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('passes the id and tenantId to db.updateQuotaPolicy', async () => {
    db.updateQuotaPolicy.mockResolvedValue(null);

    await updateQuotaPolicy(TENANT_DB, TENANT_ID, 'policy-abc', { enabled: false });

    expect(db.updateQuotaPolicy).toHaveBeenCalledWith(
      'policy-abc',
      TENANT_ID,
      expect.objectContaining({ enabled: false }),
      undefined,
    );
  });

  it('passes optional projectId to db.updateQuotaPolicy', async () => {
    db.updateQuotaPolicy.mockResolvedValue(null);

    await updateQuotaPolicy(TENANT_DB, TENANT_ID, 'policy-1', {}, PROJECT_ID);

    expect(db.updateQuotaPolicy).toHaveBeenCalledWith(
      'policy-1',
      TENANT_ID,
      expect.any(Object),
      PROJECT_ID,
    );
  });
});

// ── deleteQuotaPolicy ─────────────────────────────────────────────────────────

describe('deleteQuotaPolicy', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns true when deletion succeeds', async () => {
    db.deleteQuotaPolicy.mockResolvedValue(true);
    const result = await deleteQuotaPolicy(TENANT_DB, TENANT_ID, 'policy-1');
    expect(result).toBe(true);
  });

  it('returns false when policy not found', async () => {
    db.deleteQuotaPolicy.mockResolvedValue(false);
    const result = await deleteQuotaPolicy(TENANT_DB, TENANT_ID, 'nonexistent');
    expect(result).toBe(false);
  });

  it('passes optional projectId to db.deleteQuotaPolicy', async () => {
    db.deleteQuotaPolicy.mockResolvedValue(true);
    await deleteQuotaPolicy(TENANT_DB, TENANT_ID, 'policy-1', PROJECT_ID);
    expect(db.deleteQuotaPolicy).toHaveBeenCalledWith('policy-1', TENANT_ID, PROJECT_ID);
  });
});
