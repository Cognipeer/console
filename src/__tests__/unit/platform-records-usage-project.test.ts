/**
 * A platform model has no project of its own: its usage log row, usage event and health sample carry the project of
 * the call (explicit attribution, else the request context) so project views show them. A project model keeps its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: { switchToTenant: vi.fn(), createModelUsageLog: vi.fn() },
  recordEntityMetric: vi.fn(),
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/database', () => ({
  getDatabase: async () => hoisted.db,
  runWithTenantScope: async (_tenant: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
}));
vi.mock('@/lib/services/entityMetrics/entityMetricsRollup', () => ({ recordEntityMetric: hoisted.recordEntityMetric }));
vi.mock('@/lib/services/usage/usageEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/usage/usageEvents')>();
  return {
    ...actual,
    recordUsageEvent: (event: Record<string, unknown>) => {
      hoisted.events.push(event);
      return actual.resolveUsageAttribution(event.attribution as never);
    },
  };
});

import { runWithRequestContext } from '@/lib/core/requestContext';
import { logModelUsage } from '@/lib/services/models/usageLogger';

const model = (overrides: Record<string, unknown> = {}) => ({
  _id: 'm1', tenantId: 't1', name: 'M', key: 'm', providerKey: 'prov', providerDriver: 'openai',
  category: 'llm', modelId: 'x', settings: {}, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1 }, ...overrides,
});
const payload = (extra: Record<string, unknown> = {}) => ({
  requestId: 'r1', route: '/x', status: 'success' as const, providerRequest: {}, providerResponse: {},
  usage: { inputTokens: 1, outputTokens: 1 }, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.events.length = 0;
  hoisted.db.createModelUsageLog.mockResolvedValue({});
});

const projectsOfCall = () => ({
  row: hoisted.db.createModelUsageLog.mock.calls[0][0].projectId,
  event: hoisted.events[0].projectId,
  metric: hoisted.recordEntityMetric.mock.calls[0][0].projectId,
});

describe('usage project of a platform model', () => {
  it('uses the project of the request context', async () => {
    await runWithRequestContext({ projectId: 'p-call' }, () => logModelUsage('db', model({ platform: true }) as never, payload()));
    expect(projectsOfCall()).toEqual({ row: 'p-call', event: 'p-call', metric: 'p-call' });
  });

  it('prefers the explicit attribution of the call', async () => {
    await runWithRequestContext({ projectId: 'p-ctx' }, () =>
      logModelUsage('db', model({ platform: true }) as never, payload({ attribution: { projectId: 'p-attr' } })));
    expect(projectsOfCall()).toEqual({ row: 'p-attr', event: 'p-attr', metric: 'p-attr' });
  });

  it('keeps a project model on its own project, whatever the call context says', async () => {
    await runWithRequestContext({ projectId: 'p-call' }, () => logModelUsage('db', model({ projectId: 'p-own' }) as never, payload()));
    expect(projectsOfCall()).toEqual({ row: 'p-own', event: 'p-own', metric: 'p-own' });
  });

  it('has no project outside any request or attribution (as before)', async () => {
    await logModelUsage('db', model({ platform: true }) as never, payload());
    expect(projectsOfCall()).toEqual({ row: undefined, event: undefined, metric: undefined });
  });
});
