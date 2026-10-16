/**
 * Entity health emission — Tools Hub. `logToolRequest` is called once per
 * executed action by the dashboard, client API and agents.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/entityMetrics/entityMetricsRollup', () => ({
  recordEntityMetric: vi.fn(),
}));
vi.mock('@/lib/services/usage/usageEvents', () => ({
  recordUsageEvent: vi.fn().mockReturnValue({}),
}));

import { getDatabase } from '@/lib/database';
import { logToolRequest } from '@/lib/services/tools/toolService';
import { recordEntityMetric } from '@/lib/services/entityMetrics/entityMetricsRollup';

describe('logToolRequest -> recordEntityMetric', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb());
  });

  it('records a successful action with its latency', async () => {
    await logToolRequest('tenant_acme', 'tenant-1', 'proj-1', 'crm', 'get-user', 'Get user', 'success', 230);

    expect(recordEntityMetric).toHaveBeenCalledTimes(1);
    expect(recordEntityMetric).toHaveBeenCalledWith(expect.objectContaining({
      tenantDbName: 'tenant_acme',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      entityType: 'tool',
      entityKey: 'crm',
      source: 'service',
      outcome: 'ok',
      latencyMs: 230,
    }));
  });

  it('records a failed action as an error (its 0 ms latency is ignored by the rollup)', async () => {
    await logToolRequest(
      'tenant_acme', 'tenant-1', 'proj-1', 'crm', 'get-user', 'Get user', 'error', 0,
      undefined, undefined, 'upstream 500',
    );

    expect(recordEntityMetric).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'tool',
      entityKey: 'crm',
      outcome: 'error',
    }));
  });

  it('still emits when persisting the request log fails', async () => {
    const db = createMockDb();
    db.createToolRequestLog.mockRejectedValue(new Error('db down'));
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);

    await logToolRequest('tenant_acme', 'tenant-1', 'proj-1', 'crm', 'get-user', 'Get user', 'success', 10);
    expect(recordEntityMetric).toHaveBeenCalledTimes(1);
  });
});
