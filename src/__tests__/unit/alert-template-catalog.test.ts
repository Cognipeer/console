/**
 * The alert rule template catalog as data: every template makes a rule the validator accepts, uses a mode and a
 * metric the metric catalog allows, and the default set is exactly the five error-rate rules new projects get.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
  runWithTenantScope: vi.fn(),
}));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn() }));

import { validateRuleInput, VALID_WINDOWS } from '@/lib/services/alerts/alertService';
import {
  ALERT_TEMPLATE_CATALOG_VERSION,
  ALERT_TEMPLATE_CATEGORIES,
  ALERT_TEMPLATES,
  DEFAULT_ALERT_TEMPLATE_KEYS,
  getAlertTemplate,
  templateRuleInput,
} from '@/lib/services/alerts/alertTemplates';
import { getCollectorForMetric } from '@/lib/services/alerts/metrics';
import { ALERT_MODULE_METRICS, getMetricDef } from '@/lib/services/alerts/metricCatalog';

const EACH = ALERT_TEMPLATES.map((def) => [def.key, def] as const);

describe('the template catalog', () => {
  it('has 26 templates and a version', () => {
    expect(ALERT_TEMPLATES).toHaveLength(26);
    expect(ALERT_TEMPLATE_CATALOG_VERSION).toBe(1);
  });

  it('has unique kebab-case keys', () => {
    const keys = ALERT_TEMPLATES.map((def) => def.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('has unique names, so the rule list tells them apart', () => {
    expect(new Set(ALERT_TEMPLATES.map((def) => def.name)).size).toBe(ALERT_TEMPLATES.length);
  });

  it('uses only known categories, and every category has a template', () => {
    for (const def of ALERT_TEMPLATES) expect(ALERT_TEMPLATE_CATEGORIES).toContain(def.category);
    for (const category of ALERT_TEMPLATE_CATEGORIES) expect(ALERT_TEMPLATES.some((def) => def.category === category)).toBe(true);
  });

  it('holds each metric and mode once, so a template is the only one of its kind', () => {
    const pairs = ALERT_TEMPLATES.map((def) => `${def.metric}/${def.condition.mode}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it.each(EACH)('%s: the rule passes the validator unchanged in substance', (_key, def) => {
    const input = templateRuleInput(def);
    const rule = validateRuleInput(input, { mode: 'create' });
    expect(rule).toMatchObject({
      name: def.name,
      description: def.description,
      module: def.module,
      metric: def.metric,
      windowMinutes: def.windowMinutes,
      cooldownMinutes: def.cooldownMinutes,
      severity: 'auto',
      notifyOnResolve: true,
      renotifyMinutes: 0,
      enabled: true,
    });
    expect(rule.condition).toEqual(def.condition);
    expect(rule.channels).toEqual([{ type: 'email', recipients: [], audience: 'project_admins' }]);
    expect(VALID_WINDOWS).toContain(def.windowMinutes);
  });

  it.each(EACH)('%s: the mode, metric and module agree with the metric catalog', (_key, def) => {
    const metric = getMetricDef(def.metric);
    expect(metric).toBeDefined();
    expect(metric!.modes).toContain(def.condition.mode);
    expect(metric!.module).toBe(def.module);
    expect(ALERT_MODULE_METRICS[def.module]).toContain(def.metric);
    expect(metric!.hiddenForNewRules).toBeUndefined();
  });

  it.each(EACH)('%s: watches every entity, or the whole project for a metric without entities', (_key, def) => {
    const input = templateRuleInput(def);
    const metric = getMetricDef(def.metric)!;
    if (metric.source === 'entity') expect(input.entity).toEqual({ entityType: metric.entityType, mode: 'all' });
    else {
      expect(input.entity).toBeUndefined();
      expect(input.scope).toBeUndefined();
    }
  });

  it.each(EACH)('%s: has a name and a description that fit the rule', (_key, def) => {
    expect(def.name.length).toBeGreaterThan(0);
    expect(def.name.length).toBeLessThanOrEqual(120);
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.description.length).toBeLessThanOrEqual(1000);
    expect(def.version).toBe(1);
  });

  it.each(EACH)('%s: has a collector in this build', (_key, def) => {
    expect(getCollectorForMetric(def.metric)).toBeDefined();
  });

  it('keeps the modes without a threshold well-formed (operator gt, threshold 0)', () => {
    for (const def of ALERT_TEMPLATES.filter((entry) => entry.condition.mode !== 'threshold')) {
      expect(def.condition).toMatchObject({ operator: 'gt', threshold: 0 });
    }
  });

  it('has no template for inference servers or the AI App Gateway', () => {
    expect(ALERT_TEMPLATES.some((def) => def.module === 'inference' || def.module === 'ai-app-gateway')).toBe(false);
    expect(ALERT_TEMPLATES.some((def) => def.metric.startsWith('appgw_'))).toBe(false);
  });

  it('the default set is exactly the five error-rate threshold templates', () => {
    expect([...DEFAULT_ALERT_TEMPLATE_KEYS]).toEqual(['agent-errors', 'model-errors', 'kb-errors', 'mcp-errors', 'tool-errors']);
    expect(ALERT_TEMPLATES.filter((def) => def.default).map((def) => def.key)).toEqual([...DEFAULT_ALERT_TEMPLATE_KEYS]);
    for (const key of DEFAULT_ALERT_TEMPLATE_KEYS) {
      const def = getAlertTemplate(key)!;
      expect(def.category).toBe('errors');
      expect(def.metric).toMatch(/_error_rate$/);
      expect(def.condition).toMatchObject({ mode: 'threshold', operator: 'gt', forMinutes: 10, minSamples: 20 });
      expect(def.windowMinutes).toBe(30);
      expect(def.cooldownMinutes).toBe(120);
    }
    expect(DEFAULT_ALERT_TEMPLATE_KEYS.map((key) => getAlertTemplate(key)!.condition.threshold)).toEqual([20, 20, 20, 30, 30]);
  });

  it('only the Enterprise modes are baseline and slo_burn: four templates', () => {
    expect(ALERT_TEMPLATES.filter((def) => def.condition.mode === 'baseline' || def.condition.mode === 'slo_burn').map((def) => def.key)).toEqual([
      'agent-error-budget', 'model-error-budget', 'agent-cost-spike', 'model-cost-spike',
    ]);
  });

  it('numbers in the texts are the numbers of the condition (threshold templates)', () => {
    for (const def of ALERT_TEMPLATES.filter((entry) => entry.condition.mode === 'threshold' && getMetricDef(entry.metric)?.unit === '%')) {
      expect(def.name).toContain(`${def.condition.threshold}%`);
      expect(def.description).toContain(`${def.condition.threshold}%`);
    }
  });
});
