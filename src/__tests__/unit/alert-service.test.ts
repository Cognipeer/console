import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

/** The mock db with every method as a plain vitest mock: tests feed it partial rows. */
type LooseDb = Record<string, import('vitest').Mock>;

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
}));
vi.mock('@/lib/security/outboundFetch', () => ({
  assertPublicUrl: vi.fn(async (url: string) => {
    if (url.includes('internal.test')) throw new Error('blocked');
    return new URL(url);
  }),
  safeFetch: vi.fn(),
}));
vi.mock('@/lib/services/alerts/channels', () => ({
  dispatchNotification: vi.fn(),
}));
vi.mock('@/lib/services/alerts/alertEvaluator', () => ({
  evaluateRuleTargets: vi.fn(),
}));
vi.mock('@/lib/services/entityMetrics/entityHealthService', () => ({
  listActiveEntityKeys: vi.fn(),
}));
vi.mock('@/lib/license/tenantLicense', () => ({
  isTenantEnterpriseLicensed: vi.fn().mockResolvedValue(false),
}));

import { AlertService, validateRuleInput } from '@/lib/services/alerts/alertService';
import { AlertApiError } from '@/lib/services/alerts/alertApiError';
import { getDatabase, getTenantDatabase } from '@/lib/database';
import { dispatchNotification } from '@/lib/services/alerts/channels';
import { evaluateRuleTargets } from '@/lib/services/alerts/alertEvaluator';
import { listActiveEntityKeys } from '@/lib/services/entityMetrics/entityHealthService';
import { isTenantEnterpriseLicensed } from '@/lib/license/tenantLicense';
import { unsealChannel } from '@/lib/services/alerts/channels/channelSecrets';
import {
  __resetAlertExtensionsForTests,
  registerEntityBaselineProvider,
  registerSloBurnEvaluator,
} from '@/enterprise/alert-extensions';
import type { IAlertChannel, IAlertRule } from '@/lib/database';

const DB_NAME = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';
const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/XXXXsecretABCD';
const ROUTING_KEY = 'R0123456789abcdefghijklmnopqrstu';

const legacyInput = {
  name: 'High Error Rate',
  module: 'models' as const,
  metric: 'error_rate' as const,
  condition: { operator: 'gt' as const, threshold: 5 },
  windowMinutes: 15,
};

const agentInput = {
  name: 'Agent errors',
  module: 'agents' as const,
  metric: 'agent_error_rate' as const,
  condition: { operator: 'gt' as const, threshold: 10 },
  windowMinutes: 15,
};

const storedRule: IAlertRule = {
  _id: 'rule-1',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  ...legacyInput,
  condition: { operator: 'gt', threshold: 5 },
  cooldownMinutes: 60,
  enabled: true,
  channels: [{ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['ops@acme.com'] }],
  createdBy: USER_ID,
};

function validate(patch: Record<string, unknown>, base: Record<string, unknown> = legacyInput) {
  return validateRuleInput({ ...base, ...patch }, { mode: 'create' });
}

function expectInvalid(patch: Record<string, unknown>, code: string, base: Record<string, unknown> = legacyInput) {
  try {
    validate(patch, base);
  } catch (error) {
    expect(error).toBeInstanceOf(AlertApiError);
    expect((error as AlertApiError).status).toBe(400);
    expect((error as AlertApiError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${code} validation error`);
}

describe('validateRuleInput', () => {
  describe('basics', () => {
    it('normalises a legacy rule with the defaults', () => {
      const rule = validate({});
      expect(rule).toMatchObject({
        name: 'High Error Rate',
        description: '',
        cooldownMinutes: 60,
        severity: 'auto',
        notifyOnResolve: true,
        renotifyMinutes: 0,
        enabled: true,
        scope: {},
        entity: null,
        channels: [{ type: 'email', recipients: [] }],
      });
      expect(rule.condition).toEqual({ operator: 'gt', threshold: 5, mode: 'threshold' });
    });

    it.each([
      [{ name: '  ' }, 'invalid_name'],
      [{ name: 'x'.repeat(121) }, 'invalid_name'],
      [{ name: 42 }, 'invalid_name'],
      [{ description: 'x'.repeat(1001) }, 'invalid_description'],
      [{ module: 'unknown' }, 'invalid_module'],
      [{ module: 'aegis' }, 'invalid_module'],
      [{ metric: 'bad_metric' }, 'invalid_metric'],
      [{ metric: 'gpu_cache_usage' }, 'metric_module_mismatch'],
      [{ windowMinutes: 99 }, 'invalid_window'],
      [{ windowMinutes: 0 }, 'invalid_window'],
      [{ cooldownMinutes: -1 }, 'out_of_range'],
      [{ cooldownMinutes: 10_081 }, 'out_of_range'],
      [{ enabled: 'yes' }, 'invalid_value'],
      [{ notifyOnResolve: 1 }, 'invalid_value'],
      [{ severity: 'urgent' }, 'invalid_value'],
      [{ renotifyMinutes: 10 }, 'invalid_renotify'],
      [{ renotifyMinutes: 1441 }, 'invalid_renotify'],
      [{ renotifyMinutes: 20.5 }, 'invalid_renotify'],
    ])('rejects %j with %s', (patch, code) => {
      expectInvalid(patch, code);
    });

    it.each([5, 15, 30, 60, 120, 240, 1440])('accepts the %s minute window', (windowMinutes) => {
      expect(validate({ windowMinutes }).windowMinutes).toBe(windowMinutes);
    });

    it.each([0, 15, 60, 1440])('accepts renotifyMinutes %s', (renotifyMinutes) => {
      expect(validate({ renotifyMinutes }).renotifyMinutes).toBe(renotifyMinutes);
    });

    it('requires an object body', () => {
      expect(() => validateRuleInput('nope', { mode: 'create' })).toThrow(AlertApiError);
      expect(() => validateRuleInput(null, { mode: 'create' })).toThrow(AlertApiError);
    });

    it('does not need a name or channels for a preview', () => {
      const rule = validateRuleInput({ ...legacyInput, name: undefined }, { mode: 'preview' });
      expect(rule.name).toBe('Preview');
      expect(rule.channels).toBeUndefined();
    });
  });

  describe('condition', () => {
    it('allows negative thresholds', () => {
      expect(validate({ condition: { operator: 'lt', threshold: -3.5 } }).condition.threshold).toBe(-3.5);
    });

    it.each([
      [{ operator: 'gt' }, 'invalid_condition'],
      [{ operator: 'gt', threshold: '5' }, 'invalid_condition'],
      [{ operator: 'gt', threshold: Number.NaN }, 'invalid_number'],
      [{ operator: 'gt', threshold: Number.POSITIVE_INFINITY }, 'invalid_number'],
      [{ operator: 'between', threshold: 5 }, 'invalid_value'],
      [{ threshold: 5 }, 'invalid_value'],
      [{ operator: 'gt', threshold: 5, forMinutes: -1 }, 'out_of_range'],
      [{ operator: 'gt', threshold: 5, forMinutes: 1441 }, 'out_of_range'],
      [{ operator: 'gt', threshold: 5, forMinutes: 2.5 }, 'out_of_range'],
      [{ operator: 'gt', threshold: 5, minSamples: 0 }, 'out_of_range'],
      [{ operator: 'gt', threshold: 5, mode: 'weird' }, 'invalid_value'],
    ])('rejects condition %j with %s', (condition, code) => {
      expectInvalid({ condition }, code);
    });

    it('rejects a missing condition', () => {
      expectInvalid({ condition: undefined }, 'invalid_condition');
    });

    it('keeps forMinutes and minSamples', () => {
      expect(validate({ condition: { operator: 'gt', threshold: 5, forMinutes: 1440, minSamples: 30 } }).condition)
        .toMatchObject({ forMinutes: 1440, minSamples: 30 });
    });

    it('rejects a mode the metric does not support', () => {
      expectInvalid({ condition: { operator: 'gt', threshold: 5, mode: 'baseline' } }, 'invalid_mode');
      expectInvalid(
        { metric: 'agent_avg_duration_ms', condition: { operator: 'gt', threshold: 5, mode: 'slo_burn' } },
        'invalid_mode',
        agentInput,
      );
    });
  });

  describe('baseline mode', () => {
    const baseline = (patch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
      condition: { operator: 'gt', threshold: 0, mode: 'baseline', baseline: patch, ...extra },
    });

    it('fills the documented defaults', () => {
      expect(validate(baseline(), agentInput).condition.baseline).toEqual({
        direction: 'up', minRatio: 2, minZ: 3, minDelta: 0, lookbackDays: 14, seasonality: 'daily',
      });
    });

    it.each([
      [{ minRatio: 0.9 }], [{ minRatio: 21 }],
      [{ minZ: -1 }], [{ minZ: 21 }],
      [{ minDelta: -1 }],
      [{ lookbackDays: 2 }], [{ lookbackDays: 46 }], [{ lookbackDays: 10.5 }],
      [{ direction: 'sideways' }], [{ seasonality: 'monthly' }],
    ])('rejects %j', (patch) => {
      expect(() => validate(baseline(patch), agentInput)).toThrow(AlertApiError);
    });

    it('weekly seasonality needs at least 21 lookback days', () => {
      expect(() => validate(baseline({ seasonality: 'weekly', lookbackDays: 14 }), agentInput)).toThrow(/21/);
      expect(validate(baseline({ seasonality: 'weekly', lookbackDays: 21 }), agentInput).condition.baseline?.seasonality).toBe('weekly');
    });

    it('accepts the boundary values', () => {
      expect(validate(baseline({ minRatio: 1, minZ: 0, lookbackDays: 3 }), agentInput).condition.baseline)
        .toMatchObject({ minRatio: 1, minZ: 0, lookbackDays: 3 });
      expect(validate(baseline({ minRatio: 20, minZ: 20, lookbackDays: 45 }), agentInput).condition.baseline)
        .toMatchObject({ minRatio: 20, minZ: 20, lookbackDays: 45 });
    });

    it('drops the settings of other modes', () => {
      const condition = validate({
        condition: { operator: 'gt', threshold: 0, mode: 'baseline', absence: { lookbackHours: 5 }, slo: { objectivePct: 99 } },
      }, agentInput).condition;
      expect(condition.absence).toBeUndefined();
      expect(condition.slo).toBeUndefined();
    });
  });

  describe('absence mode', () => {
    const absence = (patch: Record<string, unknown> = {}) => ({
      metric: 'agent_sessions',
      condition: { operator: 'lt', threshold: 1, mode: 'absence', absence: patch },
    });

    it('defaults to a 24 hour lookback and one expected session', () => {
      expect(validate(absence(), agentInput).condition.absence).toEqual({ lookbackHours: 24, minExpectedPerWindow: 1 });
    });

    it.each([[{ lookbackHours: 0 }], [{ lookbackHours: 169 }], [{ lookbackHours: 2.5 }], [{ minExpectedPerWindow: 0 }], [{ minExpectedPerWindow: -1 }]])(
      'rejects %j',
      (patch) => {
        expect(() => validate(absence(patch), agentInput)).toThrow(AlertApiError);
      },
    );

    it('accepts the boundaries', () => {
      expect(validate(absence({ lookbackHours: 1 }), agentInput).condition.absence?.lookbackHours).toBe(1);
      expect(validate(absence({ lookbackHours: 168 }), agentInput).condition.absence?.lookbackHours).toBe(168);
    });
  });

  describe('slo_burn mode', () => {
    const slo = (patch: Record<string, unknown> = {}, metric = 'agent_error_rate') => ({
      metric,
      condition: { operator: 'gt', threshold: 0, mode: 'slo_burn', slo: patch },
    });

    it('defaults an availability objective', () => {
      expect(validate(slo(), agentInput).condition.slo).toEqual({
        objectivePct: 99, windowDays: 30, burnRate: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5,
      });
    });

    it.each([
      [{ objectivePct: 49.9 }], [{ objectivePct: 100 }],
      [{ windowDays: 0 }], [{ windowDays: 46 }],
      [{ burnRate: 0.9 }], [{ burnRate: 101 }],
      [{ longWindowMinutes: 5, shortWindowMinutes: 5 }],
      [{ longWindowMinutes: 5, shortWindowMinutes: 30 }],
      [{ longWindowMinutes: 0 }],
    ])('rejects %j', (patch) => {
      expect(() => validate(slo(patch), agentInput)).toThrow(AlertApiError);
    });

    it('accepts the boundaries', () => {
      expect(validate(slo({ objectivePct: 50, burnRate: 1, windowDays: 1, longWindowMinutes: 60 }), agentInput).condition.slo)
        .toMatchObject({ objectivePct: 50, burnRate: 1, windowDays: 1 });
      expect(validate(slo({ objectivePct: 99.999, burnRate: 100, windowDays: 45 }), agentInput).condition.slo)
        .toMatchObject({ objectivePct: 99.999, burnRate: 100, windowDays: 45 });
    });

    it('latency objectives need a histogram bound as the threshold', () => {
      expect(() => validate(slo({}, 'agent_p95_duration_ms'), agentInput)).toThrow(/latencyThresholdMs/);
      expect(() => validate(slo({ latencyThresholdMs: 1234 }, 'agent_p95_duration_ms'), agentInput)).toThrow(/one of/);
      expect(validate(slo({ latencyThresholdMs: 2000 }, 'agent_p95_duration_ms'), agentInput).condition.slo?.latencyThresholdMs).toBe(2000);
    });

    it('availability objectives carry no latency threshold', () => {
      expect(validate(slo({ latencyThresholdMs: 2000 }), agentInput).condition.slo?.latencyThresholdMs).toBeUndefined();
    });
  });

  describe('target', () => {
    it('entity metrics default to every entity of their type', () => {
      expect(validate({}, agentInput).entity).toEqual({ entityType: 'agent', mode: 'all' });
    });

    it('trims, de-duplicates and keeps selected keys', () => {
      expect(validate({ entity: { entityType: 'agent', mode: 'selected', keys: [' Pulse Main ', 'Pulse Main', '50%off', ''] } }, agentInput).entity)
        .toEqual({ entityType: 'agent', mode: 'selected', keys: ['Pulse Main', '50%off'] });
    });

    it('drops keys when the mode is all', () => {
      expect(validate({ entity: { entityType: 'agent', mode: 'all', keys: ['x'] } }, agentInput).entity)
        .toEqual({ entityType: 'agent', mode: 'all' });
    });

    it.each([
      [{ entityType: 'model', mode: 'all' }],
      [{ entityType: 'agent', mode: 'some' }],
      [{ entityType: 'agent', mode: 'selected' }],
      [{ entityType: 'agent', mode: 'selected', keys: [] }],
      [{ entityType: 'agent', mode: 'selected', keys: ['  '] }],
      [{ entityType: 'agent', mode: 'selected', keys: [1] }],
      [{ entityType: 'agent', mode: 'selected', keys: ['k'.repeat(201)] }],
      [{ entityType: 'agent', mode: 'selected', keys: Array.from({ length: 51 }, (_, i) => `a${i}`) }],
      ['agents'],
    ])('rejects entity %j', (entity) => {
      expect(() => validate({ entity }, agentInput)).toThrow(AlertApiError);
    });

    it('accepts 50 selected keys', () => {
      const keys = Array.from({ length: 50 }, (_, i) => `a${i}`);
      expect(validate({ entity: { entityType: 'agent', mode: 'selected', keys } }, agentInput).entity?.keys).toHaveLength(50);
    });

    it('legacy metrics reject an entity scope', () => {
      expectInvalid({ entity: { entityType: 'model', mode: 'all' } }, 'invalid_entity');
    });

    it('entity metrics ignore the legacy scope', () => {
      expect(validate({ scope: { modelKey: 'm' } }, agentInput).scope).toEqual({});
    });

    it('validates the legacy scope as short strings of known fields', () => {
      expect(validate({ scope: { modelKey: ' gpt-4o ', serverKey: '' } }).scope).toEqual({ modelKey: 'gpt-4o' });
      expectInvalid({ scope: { nope: 'x' } }, 'invalid_scope');
      expectInvalid({ scope: { modelKey: 42 } }, 'invalid_scope');
      expectInvalid({ scope: { modelKey: 'm'.repeat(201) } }, 'invalid_scope');
      expectInvalid({ scope: 'm' }, 'invalid_scope');
    });
  });

  describe('channels', () => {
    const SECRET_ID = 'ch_0123456789ab';

    it('requires 1 to 10 channels when given', () => {
      expectInvalid({ channels: [] }, 'invalid_channel');
      expectInvalid({ channels: Array.from({ length: 11 }, () => ({ type: 'email', recipients: [] })) }, 'invalid_channel');
      expectInvalid({ channels: 'email' }, 'invalid_channel');
      expect(validate({ channels: Array.from({ length: 10 }, () => ({ type: 'email', recipients: [] })) }).channels).toHaveLength(10);
    });

    it.each([
      [{ type: 'email', recipients: ['not-an-email'] }],
      [{ type: 'email', recipients: [''] }],
      [{ type: 'email' }],
      [{ type: 'email', recipients: Array.from({ length: 51 }, (_, i) => `u${i}@acme.com`) }],
      [{ type: 'webhook' }],
      [{ type: 'slack' }],
      [{ type: 'teams', url: '   ' }],
      [{ type: 'pagerduty' }],
      [{ type: 'pagerduty', routingKey: 'short' }],
      [{ type: 'pagerduty', routingKey: `${'a'.repeat(31)}-` }],
      ['email'],
    ])('rejects channel %j', (channel) => {
      expectInvalid({ channels: [channel] }, 'invalid_channel');
    });

    it('allows channel urls up to the url limit, which is longer than the secret limit', () => {
      const url = `https://example.webhook.office.com/${'a'.repeat(1_000)}`;
      expect(validate({ channels: [{ type: 'teams', url }] }).channels?.[0]).toEqual({ type: 'teams', url });
      expectInvalid({ channels: [{ type: 'teams', url: `${url}${'a'.repeat(1_100)}` }] }, 'invalid_channel');
      expectInvalid({ channels: [{ type: 'webhook', url: 'https://hooks.example.com/x', secret: 's'.repeat(513) }] }, 'invalid_channel');
    });

    it('rejects an unknown channel type', () => {
      expect(() => validate({ channels: [{ type: 'sms', recipients: [] }] })).toThrow(AlertApiError);
    });

    it('accepts every channel type and trims recipients', () => {
      const channels = validate({
        channels: [
          { type: 'email', recipients: [' ops@acme.com ', 'ops@acme.com', 'dev@acme.com'] },
          { type: 'webhook', url: ' https://hooks.example.com/x ', secret: 's' },
          { type: 'slack', url: SLACK_URL },
          { type: 'teams', url: 'https://example.webhook.office.com/x' },
          { type: 'pagerduty', routingKey: ROUTING_KEY },
        ],
      }).channels;
      expect(channels?.[0]).toEqual({ type: 'email', recipients: ['ops@acme.com', 'dev@acme.com'] });
      expect(channels?.[1]).toEqual({ type: 'webhook', url: 'https://hooks.example.com/x', secret: 's' });
      expect(channels).toHaveLength(5);
    });

    it('a stored channel id keeps its secrets: the url may be omitted on update', () => {
      const existing: IAlertRule = {
        ...storedRule,
        channels: [{ id: SECRET_ID, type: 'slack', urlHint: 'h', sealed: 'x' }],
      };
      const rule = validateRuleInput({ channels: [{ id: SECRET_ID, type: 'slack' }] }, { mode: 'update', existing });
      expect(rule.channels).toEqual([{ id: SECRET_ID, type: 'slack' }]);
      // ...but not for another type, an unknown id, or on create
      expect(() => validateRuleInput({ channels: [{ id: SECRET_ID, type: 'teams' }] }, { mode: 'update', existing })).toThrow(AlertApiError);
      expect(() => validateRuleInput({ channels: [{ id: 'ch_ffffffffffff', type: 'slack' }] }, { mode: 'update', existing })).toThrow(AlertApiError);
      expect(() => validate({ channels: [{ id: SECRET_ID, type: 'slack' }] })).toThrow(AlertApiError);
    });
  });

  describe('update', () => {
    it('overlays the given fields on the stored rule and revalidates the whole', () => {
      const rule = validateRuleInput({ name: 'Renamed' }, { mode: 'update', existing: storedRule });
      expect(rule).toMatchObject({ name: 'Renamed', metric: 'error_rate', windowMinutes: 15, condition: { threshold: 5 } });
      expect(rule.channels).toBeUndefined();
    });

    it('checks module and metric together, not each on its own', () => {
      expect(() => validateRuleInput({ module: 'agents' }, { mode: 'update', existing: storedRule })).toThrow(/not available/);
      expect(() => validateRuleInput({ windowMinutes: 0 }, { mode: 'update', existing: storedRule })).toThrow(/Invalid window/);
    });

    it('empty description, empty scope, null entity/severity/renotify clear the stored value', () => {
      const existing: IAlertRule = {
        ...storedRule,
        description: 'old',
        scope: { modelKey: 'gpt' },
        severity: 'critical',
        renotifyMinutes: 30,
      };
      const rule = validateRuleInput(
        { description: '', scope: {}, severity: null, renotifyMinutes: null },
        { mode: 'update', existing },
      );
      expect(rule).toMatchObject({ description: '', scope: {}, severity: 'auto', renotifyMinutes: 0 });

      const agent: IAlertRule = {
        ...storedRule, module: 'agents', metric: 'agent_error_rate', entity: { entityType: 'agent', mode: 'selected', keys: ['a'] },
      };
      expect(validateRuleInput({ entity: null }, { mode: 'update', existing: agent }).entity).toEqual({ entityType: 'agent', mode: 'all' });
    });

    it('retargeting with a partial body drops the stored entity or scope that no longer fits', () => {
      const agent: IAlertRule = {
        ...storedRule, module: 'agents', metric: 'agent_error_rate', entity: { entityType: 'agent', mode: 'selected', keys: ['a'] },
      };
      // agent -> model entity metric
      const toModel = validateRuleInput({ module: 'models', metric: 'model_error_rate' }, { mode: 'update', existing: agent });
      expect(toModel.entity).toEqual({ entityType: 'model', mode: 'all' });
      // entity metric -> legacy metric
      const toLegacy = validateRuleInput({ module: 'models', metric: 'error_rate' }, { mode: 'update', existing: agent });
      expect(toLegacy.entity).toBeNull();
      // legacy (with scope) -> entity metric
      const scoped: IAlertRule = { ...storedRule, scope: { modelKey: 'gpt' } };
      const toEntity = validateRuleInput({ module: 'agents', metric: 'agent_error_rate' }, { mode: 'update', existing: scoped });
      expect(toEntity.scope).toEqual({});
      expect(toEntity.entity).toEqual({ entityType: 'agent', mode: 'all' });
      // the same entity type keeps the stored selection
      const same = validateRuleInput({ metric: 'agent_p95_duration_ms' }, { mode: 'update', existing: agent });
      expect(same.entity).toEqual({ entityType: 'agent', mode: 'selected', keys: ['a'] });
    });

    it('a stored rule may keep the retired aegis module, a new one may not', () => {
      const aegis: IAlertRule = { ...storedRule, module: 'aegis', metric: 'aegis_block_rate' };
      expect(validateRuleInput({ name: 'x' }, { mode: 'update', existing: aegis }).module).toBe('aegis');
      expectInvalid({ module: 'aegis', metric: 'aegis_block_rate' }, 'invalid_module');
    });
  });
});

// ── The service ─────────────────────────────────────────────────────────────

describe('AlertService', () => {
  let db: LooseDb;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetAlertExtensionsForTests();
    (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    db = createMockDb() as unknown as LooseDb;
    (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.createAlertRule.mockImplementation(async (rule: Record<string, unknown>) => ({ ...rule, _id: 'rule-1' }));
    db.updateAlertRule.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({ ...storedRule, ...data }));
  });

  describe('createRule', () => {
    it('creates a rule, seals every channel secret and returns it masked', async () => {
      const rule = await AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, {
        ...legacyInput,
        channels: [
          { type: 'email', recipients: ['ops@acme.com'] },
          { type: 'slack', url: SLACK_URL },
          { type: 'pagerduty', routingKey: ROUTING_KEY },
        ],
      });

      const stored = db.createAlertRule.mock.calls[0][0] as unknown as { channels: IAlertChannel[]; createdBy: string; tenantId: string; projectId: string };
      expect(stored).toMatchObject({ tenantId: TENANT_ID, projectId: PROJECT_ID, createdBy: USER_ID });
      expect(stored.channels.map((c) => c.type)).toEqual(['email', 'slack', 'pagerduty']);
      expect(stored.channels.every((c) => /^ch_[0-9a-f]{12}$/.test(c.id ?? ''))).toBe(true);
      expect(JSON.stringify(stored)).not.toContain(SLACK_URL);
      expect(JSON.stringify(stored)).not.toContain(ROUTING_KEY);
      expect(unsealChannel(stored.channels[1])).toMatchObject({ type: 'slack', url: SLACK_URL });

      expect(JSON.stringify(rule)).not.toContain('sealed');
      expect(JSON.stringify(rule)).not.toContain(SLACK_URL);
      expect(rule.channels[1]).toMatchObject({ type: 'slack', urlHint: expect.stringContaining('hooks.slack.com') });
    });

    it('uses getTenantDatabase and applies the defaults', async () => {
      await AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, legacyInput);
      expect(getTenantDatabase).toHaveBeenCalledWith(DB_NAME);
      expect(db.createAlertRule).toHaveBeenCalledWith(expect.objectContaining({
        enabled: true,
        cooldownMinutes: 60,
        severity: 'auto',
        notifyOnResolve: true,
        renotifyMinutes: 0,
        channels: [expect.objectContaining({ type: 'email', recipients: [] })],
      }));
    });

    it('stores the entity scope of an entity metric and omits it for a legacy one', async () => {
      await AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, {
        ...agentInput,
        entity: { entityType: 'agent', mode: 'selected', keys: ['Pulse Main'] },
      });
      expect(db.createAlertRule.mock.calls[0][0]).toMatchObject({ entity: { entityType: 'agent', mode: 'selected', keys: ['Pulse Main'] } });
      await AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, legacyInput);
      expect(db.createAlertRule.mock.calls[1][0]).not.toHaveProperty('entity');
    });

    it('answers validation failures as AlertApiError and writes nothing', async () => {
      await expect(AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { ...legacyInput, name: ' ' }))
        .rejects.toMatchObject({ name: 'AlertApiError', status: 400 });
      await expect(AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { ...legacyInput, metric: 'bad' as never }))
        .rejects.toThrow(/Invalid metric/i);
      expect(db.createAlertRule).not.toHaveBeenCalled();
    });

    it('refuses a webhook destination that is not public', async () => {
      await expect(AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, {
        ...legacyInput,
        channels: [{ type: 'webhook', url: 'https://internal.test/hook' }],
      })).rejects.toMatchObject({ status: 400, code: 'invalid_channel' });
      await expect(AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, {
        ...legacyInput,
        channels: [{ type: 'slack', url: 'http://hooks.slack.com/x' }],
      })).rejects.toThrow(/https/);
      expect(db.createAlertRule).not.toHaveBeenCalled();
    });

    describe('enterprise condition modes', () => {
      const baselineInput = { ...agentInput, condition: { operator: 'gt' as const, threshold: 0, mode: 'baseline' as const } };

      it('402s without the provider (community build)', async () => {
        (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
        const error = await AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, baselineInput).catch((e) => e);
        expect(error).toBeInstanceOf(AlertApiError);
        expect(error).toMatchObject({ status: 402, code: 'not_enterprise_build', extra: { error: 'Payment Required', requiresEnterprise: true, module: 'alerts-advanced' } });
        expect(db.createAlertRule).not.toHaveBeenCalled();
      });

      it('402s without a licence', async () => {
        registerEntityBaselineProvider({ evaluate: vi.fn(), band: vi.fn() });
        await expect(AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, baselineInput))
          .rejects.toMatchObject({ status: 402, code: 'license_required' });
      });

      it('creates the rule with provider and licence', async () => {
        registerEntityBaselineProvider({ evaluate: vi.fn(), band: vi.fn() });
        (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
        await AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, baselineInput);
        expect(db.createAlertRule).toHaveBeenCalledTimes(1);
      });

      it('slo_burn is gated the same way', async () => {
        const sloInput = { ...agentInput, condition: { operator: 'gt' as const, threshold: 0, mode: 'slo_burn' as const } };
        await expect(AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, sloInput)).rejects.toMatchObject({ status: 402 });
        registerSloBurnEvaluator(vi.fn());
        (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
        await AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, sloInput);
        expect(db.createAlertRule).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('updateRule', () => {
    beforeEach(() => {
      db.findAlertRuleById.mockResolvedValue(storedRule);
    });

    it('returns null for a missing rule (or one outside the project) without writing', async () => {
      db.findAlertRuleById.mockResolvedValue(null);
      expect(await AlertService.updateRule(DB_NAME, 'nope', { name: 'x' }, { projectId: PROJECT_ID })).toBeNull();
      expect(db.findAlertRuleById).toHaveBeenCalledWith('nope', PROJECT_ID);
      expect(db.updateAlertRule).not.toHaveBeenCalled();
    });

    it('scopes the lookup and the write to the project', async () => {
      await AlertService.updateRule(DB_NAME, 'rule-1', { name: 'Renamed', updatedBy: USER_ID }, { projectId: PROJECT_ID });
      expect(db.findAlertRuleById).toHaveBeenCalledWith('rule-1', PROJECT_ID);
      expect(db.updateAlertRule).toHaveBeenCalledWith('rule-1', expect.objectContaining({ name: 'Renamed', updatedBy: USER_ID }), PROJECT_ID);
    });

    it('validates module/metric consistency and windows on update, as create does', async () => {
      await expect(AlertService.updateRule(DB_NAME, 'rule-1', { module: 'agents' })).rejects.toMatchObject({ status: 400, code: 'metric_module_mismatch' });
      await expect(AlertService.updateRule(DB_NAME, 'rule-1', { windowMinutes: 0 })).rejects.toMatchObject({ status: 400 });
      await expect(AlertService.updateRule(DB_NAME, 'rule-1', { metric: 'bad_metric' as never })).rejects.toThrow(/Invalid metric/i);
      await expect(AlertService.updateRule(DB_NAME, 'rule-1', { condition: { operator: 'between' as never, threshold: 1 } })).rejects.toMatchObject({ status: 400 });
      expect(db.updateAlertRule).not.toHaveBeenCalled();
    });

    it('clears description and scope when they come back empty', async () => {
      db.findAlertRuleById.mockResolvedValue({ ...storedRule, description: 'old', scope: { modelKey: 'gpt' } });
      await AlertService.updateRule(DB_NAME, 'rule-1', { description: '', scope: {} });
      expect(db.updateAlertRule.mock.calls[0][1]).toMatchObject({ description: '', scope: {} });
    });

    it('keeps the stored secret of a channel whose url is omitted, and never returns a sealed value', async () => {
      const created = await AlertService.createRule(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, {
        ...legacyInput,
        channels: [{ type: 'slack', url: SLACK_URL }],
      });
      const stored = (db.createAlertRule.mock.calls[0][0] as unknown as { channels: IAlertChannel[] }).channels;
      db.findAlertRuleById.mockResolvedValue({ ...storedRule, channels: stored });

      const updated = await AlertService.updateRule(DB_NAME, 'rule-1', {
        channels: [{ id: created.channels[0].id, type: 'slack' }, { type: 'email', recipients: ['a@b.co'] }],
      });
      const written = (db.updateAlertRule.mock.calls[0][1] as unknown as { channels: IAlertChannel[] }).channels;
      expect(written).toHaveLength(2);
      expect(unsealChannel(written[0])).toMatchObject({ url: SLACK_URL });
      expect(written[0].id).toBe(created.channels[0].id);
      expect(JSON.stringify(updated)).not.toContain('sealed');
    });

    it('does not touch channels when none are sent (an edit no longer wipes non-email channels)', async () => {
      await AlertService.updateRule(DB_NAME, 'rule-1', { name: 'Renamed' });
      expect(db.updateAlertRule.mock.calls[0][1]).not.toHaveProperty('channels');
    });

    describe('state reset', () => {
      it.each([
        ['metric', { module: 'models', metric: 'avg_latency_ms' }],
        ['window', { windowMinutes: 30 }],
        ['condition', { condition: { operator: 'gt', threshold: 9 } }],
        ['condition forMinutes', { condition: { operator: 'gt', threshold: 5, forMinutes: 10 } }],
      ])('a change of the %s deletes the rule states', async (_label, patch) => {
        await AlertService.updateRule(DB_NAME, 'rule-1', patch as never);
        expect(db.deleteAlertStates).toHaveBeenCalledWith({ ruleId: 'rule-1' });
      });

      it('a change of the entity scope deletes the rule states', async () => {
        const agentRule: IAlertRule = {
          ...storedRule, module: 'agents', metric: 'agent_error_rate', entity: { entityType: 'agent', mode: 'all' },
        };
        db.findAlertRuleById.mockResolvedValue(agentRule);
        await AlertService.updateRule(DB_NAME, 'rule-1', { entity: { entityType: 'agent', mode: 'selected', keys: ['a'] } });
        expect(db.deleteAlertStates).toHaveBeenCalledWith({ ruleId: 'rule-1' });
      });

      it('a change of the legacy scope deletes the rule states (the firing state described another model)', async () => {
        db.findAlertRuleById.mockResolvedValue({ ...storedRule, scope: { modelKey: 'model-a' } });
        await AlertService.updateRule(DB_NAME, 'rule-1', { scope: { modelKey: 'model-b' } });
        expect(db.deleteAlertStates).toHaveBeenCalledWith({ ruleId: 'rule-1' });
      });

      it('an equal scope, or a stored empty scope against none, keeps the states', async () => {
        db.findAlertRuleById.mockResolvedValue({ ...storedRule, scope: { modelKey: 'model-a' } });
        await AlertService.updateRule(DB_NAME, 'rule-1', { scope: { modelKey: ' model-a ' } });
        expect(db.deleteAlertStates).not.toHaveBeenCalled();
        db.findAlertRuleById.mockResolvedValue({ ...storedRule, scope: undefined });
        await AlertService.updateRule(DB_NAME, 'rule-1', { scope: {} });
        expect(db.deleteAlertStates).not.toHaveBeenCalled();
      });

      it('retiring clears lastTriggeredAt so the pre-state cooldown does not outlive the old conditions', async () => {
        await AlertService.updateRule(DB_NAME, 'rule-1', { condition: { operator: 'gt', threshold: 9 } });
        expect(db.updateAlertRule).toHaveBeenCalledWith('rule-1', { lastTriggeredAt: null });
      });

      it('a rename, a channel change or an unchanged legacy condition keeps them', async () => {
        await AlertService.updateRule(DB_NAME, 'rule-1', { name: 'Renamed', condition: { operator: 'gt', threshold: 5 }, channels: [{ type: 'email', recipients: [] }] });
        expect(db.deleteAlertStates).not.toHaveBeenCalled();
      });

      it('a change of the conditions notes the open incidents before the states go', async () => {
        db.listAlertStates.mockResolvedValue([{ ruleId: 'rule-1', entityKey: '', phase: 'firing', incidentId: 'incident-1' }]);
        db.findIncidentById.mockResolvedValue({ _id: 'incident-1', notes: [], status: 'open' });
        db.updateIncident.mockResolvedValue({});
        await AlertService.updateRule(DB_NAME, 'rule-1', { condition: { operator: 'gt', threshold: 9 } });
        expect(db.updateIncident).toHaveBeenCalledWith(
          'incident-1',
          { notes: [expect.objectContaining({ content: 'Rule conditions changed', userId: 'system' })] },
          undefined,
        );
        expect(db.deleteAlertStates).toHaveBeenCalledWith({ ruleId: 'rule-1' });
      });

      it('disabling retires the states and notes the open incidents', async () => {
        db.listAlertStates.mockResolvedValue([{ ruleId: 'rule-1', entityKey: 'a', phase: 'firing', incidentId: 'incident-1' }]);
        db.findIncidentById.mockResolvedValue({ _id: 'incident-1', notes: [], status: 'open' });
        db.updateIncident.mockResolvedValue({});
        await AlertService.updateRule(DB_NAME, 'rule-1', { enabled: false });
        expect(db.updateIncident).toHaveBeenCalledWith(
          'incident-1',
          { notes: [expect.objectContaining({ content: 'Rule disabled', userId: 'system' })] },
          undefined,
        );
        expect(db.deleteAlertStates).toHaveBeenCalledWith({ ruleId: 'rule-1' });
      });
    });
  });

  describe('deleteRule / getRule / listRules / toggleRule', () => {
    it('deletes with the project scope and retires the states', async () => {
      db.deleteAlertRule.mockResolvedValue(true);
      expect(await AlertService.deleteRule(DB_NAME, 'rule-1', { projectId: PROJECT_ID })).toBe(true);
      expect(db.deleteAlertRule).toHaveBeenCalledWith('rule-1', PROJECT_ID);
      expect(db.deleteAlertStates).toHaveBeenCalledWith({ ruleId: 'rule-1' });
    });

    it('leaves the states alone when nothing was deleted', async () => {
      db.deleteAlertRule.mockResolvedValue(false);
      expect(await AlertService.deleteRule(DB_NAME, 'rule-1')).toBe(false);
      expect(db.deleteAlertRule).toHaveBeenCalledWith('rule-1');
      expect(db.deleteAlertStates).not.toHaveBeenCalled();
    });

    it('returns masked rules from get and list', async () => {
      const sealed: IAlertChannel = { id: 'ch_aaaaaaaaaaaa', type: 'slack', urlHint: 'https://hooks.slack.com/…/ABCD', sealed: 'SECRET-BLOB' };
      db.findAlertRuleById.mockResolvedValue({ ...storedRule, channels: [sealed] });
      db.listAlertRules.mockResolvedValue([{ ...storedRule, channels: [sealed] }]);
      expect(JSON.stringify(await AlertService.getRule(DB_NAME, 'rule-1', { projectId: PROJECT_ID }))).not.toContain('SECRET-BLOB');
      expect(JSON.stringify(await AlertService.listRules(DB_NAME, TENANT_ID, PROJECT_ID))).not.toContain('SECRET-BLOB');
      expect(db.findAlertRuleById).toHaveBeenCalledWith('rule-1', PROJECT_ID);
      expect(db.listAlertRules).toHaveBeenCalledWith(TENANT_ID, { projectId: PROJECT_ID });
    });

    it('returns null for an unknown rule', async () => {
      db.findAlertRuleById.mockResolvedValue(null);
      expect(await AlertService.getRule(DB_NAME, 'nonexistent')).toBeNull();
    });

    it('toggles, retiring the states only when disabling', async () => {
      await AlertService.toggleRule(DB_NAME, 'rule-1', false, USER_ID, { projectId: PROJECT_ID });
      expect(db.updateAlertRule).toHaveBeenCalledWith('rule-1', { enabled: false, updatedBy: USER_ID }, PROJECT_ID);
      expect(db.deleteAlertStates).toHaveBeenCalledTimes(1);
      await AlertService.toggleRule(DB_NAME, 'rule-1', true, USER_ID);
      expect(db.updateAlertRule).toHaveBeenLastCalledWith('rule-1', { enabled: true, updatedBy: USER_ID });
      expect(db.deleteAlertStates).toHaveBeenCalledTimes(1);
    });
  });

  describe('stateCounts', () => {
    it('counts persisted states per rule and ignores the licence marker', async () => {
      db.listAlertStates.mockResolvedValue([
        { ruleId: 'a', phase: 'firing' },
        { ruleId: 'a', phase: 'firing' },
        { ruleId: 'a', phase: 'pending' },
        { ruleId: 'b', phase: 'ok' },
        { ruleId: 'b', phase: 'ok', detail: { licenseRequired: true } },
      ]);
      expect(await AlertService.stateCounts(DB_NAME, ['a', 'b'])).toEqual({
        a: { ok: 0, pending: 1, firing: 2 },
        b: { ok: 1, pending: 0, firing: 0 },
      });
      expect(await AlertService.stateCounts(DB_NAME, [])).toEqual({});
    });
  });

  describe('acknowledgeEvent', () => {
    const event = { _id: 'event-1', status: 'fired', projectId: PROJECT_ID };

    it('records who and when, and acknowledges the open incident', async () => {
      db.findAlertEventById.mockResolvedValue(event);
      db.updateAlertEvent.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({ ...event, ...data }));
      db.findIncidentByAlertEventId.mockResolvedValue({ _id: 'incident-1', status: 'open' });
      db.findIncidentById.mockResolvedValue({ _id: 'incident-1', status: 'open', notes: [] });
      db.updateIncident.mockResolvedValue({});

      const result = await AlertService.acknowledgeEvent(DB_NAME, 'event-1', { projectId: PROJECT_ID, userId: USER_ID });
      expect(db.findAlertEventById).toHaveBeenCalledWith('event-1', PROJECT_ID);
      expect(db.updateAlertEvent).toHaveBeenCalledWith('event-1', {
        status: 'acknowledged', acknowledgedBy: USER_ID, acknowledgedAt: expect.any(Date),
      });
      expect(result).toMatchObject({ status: 'acknowledged', acknowledgedBy: USER_ID });
      expect(db.updateIncident).toHaveBeenCalledWith(
        'incident-1',
        expect.objectContaining({ status: 'acknowledged', acknowledgedBy: USER_ID }),
        PROJECT_ID,
      );
    });

    it('keeps the resolved status of an already resolved event', async () => {
      db.findAlertEventById.mockResolvedValue({ ...event, status: 'resolved' });
      db.updateAlertEvent.mockImplementation(async (_id: string, data: Record<string, unknown>) => data);
      await AlertService.acknowledgeEvent(DB_NAME, 'event-1', { userId: USER_ID });
      expect(db.updateAlertEvent.mock.calls[0][1]).not.toHaveProperty('status');
    });

    it('returns null for an event outside the project', async () => {
      db.findAlertEventById.mockResolvedValue(null);
      expect(await AlertService.acknowledgeEvent(DB_NAME, 'event-1', { projectId: 'other' })).toBeNull();
      expect(db.updateAlertEvent).not.toHaveBeenCalled();
    });
  });

  describe('previewRule', () => {
    const session = { tenantId: TENANT_ID, tenantSlug: 'acme' };

    it('returns at most 50 targets, breaching ones first, without writing any state', async () => {
      const targets = Array.from({ length: 70 }, (_, i) => ({
        entityKey: `agent-${String(i).padStart(2, '0')}`,
        value: i,
        sampleCount: 100 - i,
        breached: i === 69,
        noData: false,
      }));
      (evaluateRuleTargets as ReturnType<typeof vi.fn>).mockResolvedValue({ entityType: 'agent', targets, notes: [] });
      const preview = await AlertService.previewRule(DB_NAME, session, PROJECT_ID, agentInput);
      expect(preview.targets).toHaveLength(50);
      expect(preview.targets[0]).toMatchObject({ entityKey: 'agent-69', breached: true });
      expect(preview.notes).toContain('Showing 50 of 70 entities');
      expect(db.upsertAlertState).not.toHaveBeenCalled();
      expect(db.createAlertEvent).not.toHaveBeenCalled();
      const synthetic = (evaluateRuleTargets as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(synthetic).toMatchObject({ projectId: PROJECT_ID, metric: 'agent_error_rate', entity: { mode: 'all' } });
    });

    it('says so when nothing has data yet', async () => {
      (evaluateRuleTargets as ReturnType<typeof vi.fn>).mockResolvedValue({ entityType: 'agent', targets: [], notes: [] });
      const preview = await AlertService.previewRule(DB_NAME, session, PROJECT_ID, agentInput);
      expect(preview.targets).toEqual([]);
      expect(preview.notes[0]).toMatch(/No entity has data/);
    });

    it('validates like create and gates enterprise modes', async () => {
      await expect(AlertService.previewRule(DB_NAME, session, PROJECT_ID, { ...agentInput, windowMinutes: 7 })).rejects.toMatchObject({ status: 400 });
      await expect(AlertService.previewRule(DB_NAME, session, PROJECT_ID, {
        ...agentInput, condition: { operator: 'gt', threshold: 0, mode: 'baseline' },
      })).rejects.toMatchObject({ status: 402 });
      expect(evaluateRuleTargets).not.toHaveBeenCalled();
    });
  });

  describe('listEntities', () => {
    it('lists active entities of the project and maps the last bucket to lastSeenMs', async () => {
      (listActiveEntityKeys as ReturnType<typeof vi.fn>).mockResolvedValue([{ key: 'Pulse Main', requests: 12, lastBucketMs: 1_700_000_000_000 }]);
      const entities = await AlertService.listEntities(DB_NAME, TENANT_ID, PROJECT_ID, { entityType: 'agent', q: 'pul', limit: 10 });
      expect(entities).toEqual([{ key: 'Pulse Main', requests: 12, lastSeenMs: 1_700_000_000_000 }]);
      expect(listActiveEntityKeys).toHaveBeenCalledWith(expect.objectContaining({
        tenantDbName: DB_NAME, tenantId: TENANT_ID, projectId: PROJECT_ID, entityType: 'agent', q: 'pul', limit: 10,
      }));
      const call = (listActiveEntityKeys as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.toMs - call.fromMs).toBe(30 * 86_400_000);
    });

    it('rejects an unknown entity type', async () => {
      await expect(AlertService.listEntities(DB_NAME, TENANT_ID, PROJECT_ID, { entityType: 'planet' })).rejects.toMatchObject({ status: 400 });
      await expect(AlertService.listEntities(DB_NAME, TENANT_ID, PROJECT_ID, {})).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('testChannel', () => {
    const session = { tenantId: TENANT_ID, tenantSlug: 'acme' };
    const scope = { projectId: PROJECT_ID, projectName: 'Main Project' };

    beforeEach(() => {
      (dispatchNotification as ReturnType<typeof vi.fn>).mockResolvedValue([{ type: 'slack', target: 'hooks.slack.com', success: true }]);
      db.findTenantById.mockResolvedValue({ companyName: 'Acme Corp' });
    });

    it('sends a labelled test notification on an unsaved channel, sealed on the way', async () => {
      const result = await AlertService.testChannel(DB_NAME, session, scope, { channel: { type: 'slack', url: SLACK_URL } });
      expect(result).toEqual({ type: 'slack', target: 'hooks.slack.com', success: true });
      const [notification, channels, context] = (dispatchNotification as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(notification).toMatchObject({ kind: 'test', projectName: 'Main Project', companyName: 'Acme Corp', severity: 'info', value: null });
      expect(channels).toHaveLength(1);
      expect(JSON.stringify(channels)).not.toContain(SLACK_URL);
      expect(unsealChannel(channels[0])).toMatchObject({ url: SLACK_URL });
      expect(context).toMatchObject({ tenantDbName: DB_NAME, projectName: 'Main Project' });
    });

    it('validates an unsaved channel (https, public, well-formed)', async () => {
      await expect(AlertService.testChannel(DB_NAME, session, scope, { channel: { type: 'slack', url: 'https://internal.test/x' } }))
        .rejects.toMatchObject({ status: 400 });
      await expect(AlertService.testChannel(DB_NAME, session, scope, { channel: { type: 'pagerduty', routingKey: 'nope' } }))
        .rejects.toMatchObject({ status: 400 });
      expect(dispatchNotification).not.toHaveBeenCalled();
    });

    it('tests a stored channel of a rule inside the project scope', async () => {
      const stored: IAlertChannel = { id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['ops@acme.com'] };
      db.findAlertRuleById.mockResolvedValue({ ...storedRule, channels: [stored] });
      await AlertService.testChannel(DB_NAME, session, { ...scope, ruleScopeProjectId: PROJECT_ID }, { ruleId: 'rule-1', channelId: 'ch_aaaaaaaaaaaa' });
      expect(db.findAlertRuleById).toHaveBeenCalledWith('rule-1', PROJECT_ID);
      const [notification, channels] = (dispatchNotification as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(channels).toEqual([stored]);
      expect(notification.rule).toMatchObject({ id: 'rule-1', name: 'High Error Rate', metric: 'error_rate' });
    });

    it('404s an unknown rule or channel and 400s a malformed body', async () => {
      db.findAlertRuleById.mockResolvedValue(null);
      await expect(AlertService.testChannel(DB_NAME, session, scope, { ruleId: 'x', channelId: 'y' })).rejects.toMatchObject({ status: 404 });
      db.findAlertRuleById.mockResolvedValue(storedRule);
      await expect(AlertService.testChannel(DB_NAME, session, scope, { ruleId: 'rule-1', channelId: 'ch_ffffffffffff' })).rejects.toMatchObject({ status: 404 });
      await expect(AlertService.testChannel(DB_NAME, session, scope, {})).rejects.toMatchObject({ status: 400 });
    });

    it('reports a failed delivery without throwing', async () => {
      (dispatchNotification as ReturnType<typeof vi.fn>).mockResolvedValue([
        { type: 'email', target: 'a@b.co', success: true },
        { type: 'email', target: 'c@d.co', success: false, error: 'rejected' },
      ]);
      const result = await AlertService.testChannel(DB_NAME, session, scope, { channel: { type: 'email', recipients: ['a@b.co'] } });
      expect(result).toMatchObject({ success: false, error: 'rejected' });
    });
  });

  describe('events', () => {
    it('lists events and counts the active ones', async () => {
      db.listAlertEvents.mockResolvedValue([{ _id: 'event-1' }]);
      db.countActiveAlerts.mockResolvedValue(3);
      expect(await AlertService.listEvents(DB_NAME, TENANT_ID, { ruleId: 'rule-1', status: 'fired', limit: 10 })).toHaveLength(1);
      expect(db.listAlertEvents).toHaveBeenCalledWith(TENANT_ID, { ruleId: 'rule-1', status: 'fired', limit: 10 });
      expect(await AlertService.countActive(DB_NAME, TENANT_ID, PROJECT_ID)).toBe(3);
      expect(db.countActiveAlerts).toHaveBeenCalledWith(TENANT_ID, PROJECT_ID);
    });
  });

  describe('mode availability', () => {
    it('reports every mode with its reason', async () => {
      expect(await AlertService.getModeAvailability(TENANT_ID)).toEqual({
        threshold: { available: true },
        absence: { available: true },
        baseline: { available: false, reason: 'not_enterprise_build' },
        slo_burn: { available: false, reason: 'not_enterprise_build' },
      });
      registerEntityBaselineProvider({ evaluate: vi.fn(), band: vi.fn() });
      expect((await AlertService.getModeAvailability(TENANT_ID)).baseline).toEqual({ available: false, reason: 'license_required' });
      (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      expect((await AlertService.getModeAvailability(TENANT_ID)).baseline).toEqual({ available: true });
    });
  });
});
