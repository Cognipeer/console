import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
}));

import { AlertService } from '@/lib/services/alerts/alertService';
import { getTenantDatabase } from '@/lib/database';

const DB_NAME = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';

const mockRule = {
  _id: 'rule-1',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  name: 'High Error Rate',
  module: 'models' as const,
  metric: 'error_rate' as const,
  condition: { operator: 'gt' as const, threshold: 5 },
  windowMinutes: 15,
  cooldownMinutes: 60,
  enabled: true,
  channels: [{ type: 'email' as const, recipients: ['ops@acme.com'] }],
  createdBy: USER_ID,
};

const mockEvent = {
  _id: 'event-1',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  ruleId: 'rule-1',
  ruleName: 'High Error Rate',
  status: 'fired' as const,
  actualValue: 8.2,
  threshold: 5,
  metric: 'error_rate' as const,
  channels: [{ type: 'email', target: 'ops@acme.com', success: true }],
  firedAt: new Date(),
};

describe('AlertService', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  // ─── createRule ──────────────────────────────────────────────────────

  describe('createRule', () => {
    const validInput = {
      name: 'High Error Rate',
      module: 'models' as const,
      metric: 'error_rate' as const,
      condition: { operator: 'gt' as const, threshold: 5 },
      windowMinutes: 15,
    };

    beforeEach(() => {
      db.createAlertRule.mockResolvedValue(mockRule);
    });

    it('creates an alert rule successfully', async () => {
      const result = await AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, validInput);
      expect(result).toMatchObject({ name: 'High Error Rate', module: 'models' });
      expect(db.createAlertRule).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID, projectId: PROJECT_ID, createdBy: USER_ID }),
      );
    });

    it('uses getTenantDatabase (auto-switches tenant)', async () => {
      await AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, validInput);
      expect(getTenantDatabase).toHaveBeenCalledWith(DB_NAME);
    });

    it('throws on invalid module', async () => {
      await expect(
        AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { ...validInput, module: 'unknown' as never }),
      ).rejects.toThrow(/Invalid module/i);
    });

    it('throws on invalid metric', async () => {
      await expect(
        AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { ...validInput, metric: 'bad_metric' as never }),
      ).rejects.toThrow(/Invalid metric/i);
    });

    it('throws when metric does not belong to module', async () => {
      await expect(
        AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, {
          ...validInput,
          module: 'models' as const,
          metric: 'gpu_cache_usage' as never,
        }),
      ).rejects.toThrow(/not available/i);
    });

    it('throws on invalid window', async () => {
      await expect(
        AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { ...validInput, windowMinutes: 99 }),
      ).rejects.toThrow(/Invalid window/i);
    });

    it('throws on missing threshold', async () => {
      await expect(
        AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, {
          ...validInput,
          condition: { operator: 'gt' as const, threshold: undefined as never },
        }),
      ).rejects.toThrow(/threshold/i);
    });

    it('throws on empty name', async () => {
      await expect(
        AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { ...validInput, name: '  ' }),
      ).rejects.toThrow(/name is required/i);
    });

    it('defaults enabled to true', async () => {
      await AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, validInput);
      expect(db.createAlertRule).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    });

    it('defaults cooldownMinutes to 60', async () => {
      await AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, validInput);
      expect(db.createAlertRule).toHaveBeenCalledWith(expect.objectContaining({ cooldownMinutes: 60 }));
    });
  });

  // ─── updateRule ──────────────────────────────────────────────────────

  describe('updateRule', () => {
    it('updates named fields', async () => {
      db.updateAlertRule.mockResolvedValue({ ...mockRule, name: 'Renamed' });
      const result = await AlertService.updateRule(DB_NAME, 'rule-1', { name: 'Renamed', updatedBy: USER_ID });
      expect(db.updateAlertRule).toHaveBeenCalledWith('rule-1', expect.objectContaining({ name: 'Renamed' }));
      expect(result?.name).toBe('Renamed');
    });

    it('throws on invalid metric during update', async () => {
      await expect(
        AlertService.updateRule(DB_NAME, 'rule-1', { metric: 'bad_metric' as never }),
      ).rejects.toThrow(/Invalid metric/i);
    });

    it('throws on invalid module during update', async () => {
      await expect(
        AlertService.updateRule(DB_NAME, 'rule-1', { module: 'unknown' as never }),
      ).rejects.toThrow(/Invalid module/i);
    });

    it('throws on invalid window during update', async () => {
      await expect(
        AlertService.updateRule(DB_NAME, 'rule-1', { windowMinutes: 999 }),
      ).rejects.toThrow(/Invalid window/i);
    });

    it('only sends defined fields', async () => {
      db.updateAlertRule.mockResolvedValue(mockRule);
      await AlertService.updateRule(DB_NAME, 'rule-1', { enabled: false, updatedBy: USER_ID });
      const call = (db.updateAlertRule as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(call.enabled).toBe(false);
      expect(call.name).toBeUndefined();
    });
  });

  // ─── deleteRule ──────────────────────────────────────────────────────

  describe('deleteRule', () => {
    it('deletes a rule', async () => {
      db.deleteAlertRule.mockResolvedValue(true);
      const result = await AlertService.deleteRule(DB_NAME, 'rule-1');
      expect(result).toBe(true);
      expect(db.deleteAlertRule).toHaveBeenCalledWith('rule-1');
    });
  });

  // ─── getRule ─────────────────────────────────────────────────────────

  describe('getRule', () => {
    it('returns rule by id', async () => {
      db.findAlertRuleById.mockResolvedValue(mockRule);
      const result = await AlertService.getRule(DB_NAME, 'rule-1');
      expect(result).toMatchObject({ _id: 'rule-1' });
    });

    it('returns null if not found', async () => {
      db.findAlertRuleById.mockResolvedValue(null);
      const result = await AlertService.getRule(DB_NAME, 'nonexistent');
      expect(result).toBeNull();
    });
  });

  // ─── listRules ───────────────────────────────────────────────────────

  describe('listRules', () => {
    it('returns list of rules for tenant', async () => {
      db.listAlertRules.mockResolvedValue([mockRule]);
      const result = await AlertService.listRules(DB_NAME, TENANT_ID);
      expect(result).toHaveLength(1);
      expect(db.listAlertRules).toHaveBeenCalledWith(TENANT_ID, { projectId: undefined });
    });

    it('filters by projectId when provided', async () => {
      db.listAlertRules.mockResolvedValue([]);
      await AlertService.listRules(DB_NAME, TENANT_ID, PROJECT_ID);
      expect(db.listAlertRules).toHaveBeenCalledWith(TENANT_ID, { projectId: PROJECT_ID });
    });
  });

  // ─── toggleRule ──────────────────────────────────────────────────────

  describe('toggleRule', () => {
    it('disables a rule', async () => {
      db.updateAlertRule.mockResolvedValue({ ...mockRule, enabled: false });
      const result = await AlertService.toggleRule(DB_NAME, 'rule-1', false, USER_ID);
      expect(db.updateAlertRule).toHaveBeenCalledWith('rule-1', { enabled: false, updatedBy: USER_ID });
      expect(result?.enabled).toBe(false);
    });

    it('enables a rule', async () => {
      db.updateAlertRule.mockResolvedValue({ ...mockRule, enabled: true });
      const result = await AlertService.toggleRule(DB_NAME, 'rule-1', true, USER_ID);
      expect(result?.enabled).toBe(true);
    });
  });

  // ─── listEvents ──────────────────────────────────────────────────────

  describe('listEvents', () => {
    it('returns events list', async () => {
      db.listAlertEvents.mockResolvedValue([mockEvent]);
      const result = await AlertService.listEvents(DB_NAME, TENANT_ID);
      expect(result).toHaveLength(1);
    });

    it('passes options to db', async () => {
      db.listAlertEvents.mockResolvedValue([]);
      await AlertService.listEvents(DB_NAME, TENANT_ID, { ruleId: 'rule-1', status: 'fired', limit: 10 });
      expect(db.listAlertEvents).toHaveBeenCalledWith(TENANT_ID, { ruleId: 'rule-1', status: 'fired', limit: 10 });
    });
  });

  // ─── acknowledgeEvent ────────────────────────────────────────────────

  describe('acknowledgeEvent', () => {
    it('sets status to acknowledged', async () => {
      db.updateAlertEvent.mockResolvedValue({ ...mockEvent, status: 'acknowledged' });
      const result = await AlertService.acknowledgeEvent(DB_NAME, 'event-1');
      expect(db.updateAlertEvent).toHaveBeenCalledWith('event-1', { status: 'acknowledged' });
      expect(result?.status).toBe('acknowledged');
    });
  });

  // ─── countActive ─────────────────────────────────────────────────────

  describe('countActive', () => {
    it('returns active alert count', async () => {
      db.countActiveAlerts.mockResolvedValue(3);
      const result = await AlertService.countActive(DB_NAME, TENANT_ID);
      expect(result).toBe(3);
      expect(db.countActiveAlerts).toHaveBeenCalledWith(TENANT_ID, undefined);
    });

    it('scopes by projectId when provided', async () => {
      db.countActiveAlerts.mockResolvedValue(1);
      await AlertService.countActive(DB_NAME, TENANT_ID, PROJECT_ID);
      expect(db.countActiveAlerts).toHaveBeenCalledWith(TENANT_ID, PROJECT_ID);
    });
  });
});
