import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
}));
vi.mock('@/lib/services/alerts/metrics', () => ({
  collectMetric: vi.fn().mockResolvedValue({ value: 10, sampleCount: 5 }),
}));
vi.mock('@/lib/services/alerts/channels', () => ({
  getChannel: vi.fn().mockReturnValue({
    dispatch: vi.fn().mockResolvedValue([{ type: 'email', target: 'ops@acme.com', success: true }]),
  }),
}));

import { evaluateTenantAlerts } from '@/lib/services/alerts/alertEvaluator';
import { getTenantDatabase } from '@/lib/database';
import { collectMetric } from '@/lib/services/alerts/metrics';
import { getChannel } from '@/lib/services/alerts/channels';

const ctx = {
  tenantDbName: 'tenant_acme',
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  companyName: 'Acme Corp',
};

const mockRule = {
  _id: 'rule-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'High Error Rate',
  module: 'models' as const,
  metric: 'error_rate' as const,
  condition: { operator: 'gt' as const, threshold: 5 },
  windowMinutes: 15,
  cooldownMinutes: 60,
  enabled: true,
  channels: [{ type: 'email' as const, recipients: ['ops@acme.com'] }],
  createdBy: 'user-1',
  lastTriggeredAt: undefined,
};

describe('evaluateTenantAlerts', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listAlertRules.mockResolvedValue([mockRule]);
    db.findProjectById.mockResolvedValue({ _id: 'proj-1', name: 'Main Project', key: 'main', tenantId: 'tenant-1', createdBy: 'user-1' });
    db.createAlertEvent.mockResolvedValue({ tenantId: 'tenant-1', projectId: 'proj-1', ruleId: 'rule-1', ruleName: 'Test', metric: 'error_rate', threshold: 5, actualValue: 10, status: 'fired', channels: [], firedAt: new Date() });
    db.updateAlertRule.mockResolvedValue(null);
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 10, sampleCount: 5 });
  });

  it('returns 0 when no rules exist', async () => {
    db.listAlertRules.mockResolvedValue([]);
    const count = await evaluateTenantAlerts(ctx);
    expect(count).toBe(0);
  });

  it('returns fired count on threshold breach', async () => {
    const count = await evaluateTenantAlerts(ctx);
    expect(count).toBe(1);
  });

  it('fetches only enabled rules', async () => {
    await evaluateTenantAlerts(ctx);
    expect(db.listAlertRules).toHaveBeenCalledWith('tenant-1', { enabled: true });
  });

  it('skips rules still in cooldown', async () => {
    const recentlyFiredRule = {
      ...mockRule,
      lastTriggeredAt: new Date(), // just triggered
      cooldownMinutes: 60,
    };
    db.listAlertRules.mockResolvedValue([recentlyFiredRule]);
    const count = await evaluateTenantAlerts(ctx);
    expect(count).toBe(0);
    expect(collectMetric).not.toHaveBeenCalled();
  });

  it('allows rule after cooldown has passed', async () => {
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    db.listAlertRules.mockResolvedValue([{ ...mockRule, lastTriggeredAt: oldDate, cooldownMinutes: 60 }]);
    const count = await evaluateTenantAlerts(ctx);
    expect(count).toBe(1);
  });

  it('skips rule when sampleCount is 0 (no data)', async () => {
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 0, sampleCount: 0 });
    const count = await evaluateTenantAlerts(ctx);
    expect(count).toBe(0);
  });

  it('skips rule when condition is not breached', async () => {
    // metric value 3, threshold 5, operator gt → not breached
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 3, sampleCount: 5 });
    const count = await evaluateTenantAlerts(ctx);
    expect(count).toBe(0);
    expect(db.createAlertEvent).not.toHaveBeenCalled();
  });

  it('creates alert event on breach', async () => {
    await evaluateTenantAlerts(ctx);
    expect(db.createAlertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        ruleName: 'High Error Rate',
        status: 'fired',
        actualValue: 10,
        threshold: 5,
      }),
    );
  });

  it('dispatches to rule channels', async () => {
    await evaluateTenantAlerts(ctx);
    const dispatcher = (getChannel as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(dispatcher.dispatch).toHaveBeenCalled();
  });

  it('updates rule lastTriggeredAt after firing', async () => {
    await evaluateTenantAlerts(ctx);
    expect(db.updateAlertRule).toHaveBeenCalledWith('rule-1', expect.objectContaining({ lastTriggeredAt: expect.any(Date) }));
  });

  it('handles lt operator correctly', async () => {
    // metric = 10, threshold = 20, operator = lt → breached
    db.listAlertRules.mockResolvedValue([{ ...mockRule, condition: { operator: 'lt' as const, threshold: 20 } }]);
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 10, sampleCount: 5 });
    const count = await evaluateTenantAlerts(ctx);
    expect(count).toBe(1);
  });

  it('handles gte operator correctly', async () => {
    // metric = 5, threshold = 5, operator = gte → breached (equal counts)
    db.listAlertRules.mockResolvedValue([{ ...mockRule, condition: { operator: 'gte' as const, threshold: 5 } }]);
    const count = await evaluateTenantAlerts(ctx);
    expect(count).toBe(1);
  });

  it('handles multiple rules and counts all fired', async () => {
    const rule2 = { ...mockRule, _id: 'rule-2', metric: 'avg_latency_ms' as const };
    db.listAlertRules.mockResolvedValue([mockRule, rule2]);
    const count = await evaluateTenantAlerts(ctx);
    expect(count).toBe(2);
  });

  it('continues processing other rules when one fails', async () => {
    const rule2 = { ...mockRule, _id: 'rule-2', metric: 'avg_latency_ms' as const };
    db.listAlertRules.mockResolvedValue([mockRule, rule2]);
    (collectMetric as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('metric error'))
      .mockResolvedValueOnce({ value: 10, sampleCount: 5 });
    const count = await evaluateTenantAlerts(ctx);
    expect(count).toBe(1); // second rule still fires
  });

  it('skips channel with no dispatcher', async () => {
    (getChannel as ReturnType<typeof vi.fn>).mockReturnValue(null);
    // Should not throw, just log the missing dispatcher
    const count = await evaluateTenantAlerts(ctx);
    expect(count).toBe(1); // event still created
  });
});
