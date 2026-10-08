/**
 * Unit tests — model usage alert collector · Dynamic LLM spend.
 * A router's own rows are priced at zero; `total_cost` scoped to a router key
 * must sum the child / decider rows it routed (SQLite branch, real SQL).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import Database from 'better-sqlite3';

const sqlite = new Database(':memory:');

vi.mock('@/lib/database', () => ({ getTenantDatabase: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/services/alerts/metrics/dbHelper', () => ({
  getRawDb: () => ({ type: 'sqlite', db: sqlite }),
}));

import { ModelUsageCollector } from '@/lib/services/alerts/metrics/modelUsageCollector';

beforeAll(() => {
  sqlite.exec(`CREATE TABLE model_usage_logs (
    tenantId TEXT, projectId TEXT, modelKey TEXT, status TEXT, latencyMs INTEGER,
    pricingSnapshot TEXT, routing TEXT, createdAt TEXT)`);
  const insert = sqlite.prepare(
    'INSERT INTO model_usage_logs VALUES (@tenantId, @projectId, @modelKey, @status, 10, @pricing, @routing, @createdAt)',
  );
  const now = new Date().toISOString();
  const row = (modelKey: string, cost: number, routing: object | null) =>
    insert.run({
      tenantId: 't1',
      projectId: 'p1',
      modelKey,
      status: 'success',
      pricing: JSON.stringify({ totalCost: cost }),
      routing: routing ? JSON.stringify(routing) : null,
      createdAt: now,
    });
  row('router', 0, { role: 'router', routerKey: 'router' });
  row('small', 0.3, { role: 'child', routerKey: 'router' });
  row('decider', 0.05, { role: 'decider', routerKey: 'router' });
  row('small', 1, null); // direct traffic to the child model, not via the router
  row('small', 2, { role: 'child', routerKey: 'other-router' });
});

describe('ModelUsageCollector · total_cost for a Dynamic LLM', () => {
  const collector = new ModelUsageCollector();
  const query = (modelKey: string) => ({
    tenantDbName: 'tenant_t1',
    tenantId: 't1',
    metric: 'total_cost' as const,
    windowMinutes: 60,
    scope: { modelKey },
  });

  it('includes the spend of the rows the router caused', async () => {
    const result = await collector.collect(query('router'));
    expect(result.value).toBeCloseTo(0.35);
  });

  it('leaves a regular model key unchanged', async () => {
    // small: its own rows only (0.3 + 1 + 2), routed-by attribution does not change it.
    expect((await collector.collect(query('small'))).value).toBeCloseTo(3.3);
  });

  it('does not change other metrics for the router key', async () => {
    const result = await collector.collect({ ...query('router'), metric: 'total_requests' });
    expect(result.value).toBe(1);
  });
});
