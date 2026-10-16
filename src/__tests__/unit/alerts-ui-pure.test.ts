/**
 * The pure half of the alerts UI: the catalog client, the rule form model, the channel
 * item model and the incident presentation rules. No DOM.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';
import { ALERT_METRIC_CATALOG } from '@/lib/services/alerts/metricCatalog';
import {
  DEFAULT_ALERT_CATALOG,
  MODULE_ORDER,
  authorableModules,
  createAlertCatalog,
  entityOf,
  entityTypeLabel,
  formatDurationBetween,
  formatMetricValue,
  formatMinutes,
  inferModule,
  metricLabel,
  metricUnit,
  metricsForModule,
  moduleLabel,
  summarizeCondition,
  summarizeTarget,
  type TFn,
} from '@/components/alerts/alertCatalog';
import {
  SLO_LATENCY_BOUNDS_MS,
  DEFAULT_SLO_LATENCY_MS,
  applyBaselinePreset,
  applyMetricChange,
  applyModuleChange,
  buildRulePayload,
  checkRule,
  defaultValues,
  describeRule,
  duplicateRuleSeed,
  prefillFromParams,
  valuesFromRule,
  type RuleFormValues,
} from '@/components/alerts/ruleForm';
import {
  buildChannelTestBody,
  channelToInput,
  channelsFromStored,
  channelsToInput,
  isStoredChannel,
  newChannelItem,
  validateChannel,
  validateChannels,
} from '@/components/alerts/channelItems';
import {
  bulkEligible,
  canTransition,
  statusActionKey,
  timelineEntries,
} from '@/components/alerts/incidentUi';
import type { AlertRuleDto, IncidentDto, IncidentStatus } from '@/components/alerts/alertTypes';

type Tree = { [key: string]: string | Tree };

/** A translator over the real messages, printing the dotted key for a missing one like `useTranslations` does. */
function makeT(locale: 'en' | 'tr', namespace: 'alerts' | 'incidents' = 'alerts'): TFn {
  const root = (messages[locale] as unknown as Record<string, Tree>)[namespace];
  return (key, values) => {
    let node: string | Tree | undefined = root;
    for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined;
    if (typeof node !== 'string') return `${namespace}.${key}`;
    return node.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`));
  };
}

const tEn = makeT('en');
const tTr = makeT('tr');
const catalog = DEFAULT_ALERT_CATALOG;

// ── alertCatalog ────────────────────────────────────────────────────────────

describe('alertCatalog', () => {
  it('is built from the server catalog and falls back to the bundled one', () => {
    expect(DEFAULT_ALERT_CATALOG.metrics).toBe(ALERT_METRIC_CATALOG);
    expect(createAlertCatalog(null).metrics).toBe(ALERT_METRIC_CATALOG);
    const custom = createAlertCatalog([ALERT_METRIC_CATALOG[0]!]);
    expect(custom.metrics).toHaveLength(1);
    expect(custom.byId.has(ALERT_METRIC_CATALOG[1]!.id)).toBe(false);
  });

  it.each(ALERT_METRIC_CATALOG.map((def) => [def.id, def] as const))('covers %s in both languages with a unit and a module', (id, def) => {
    const en = metricLabel(catalog, id, tEn);
    const tr = metricLabel(catalog, id, tTr);
    expect(en, `${id} (en)`).not.toContain('.');
    expect(tr, `${id} (tr)`).not.toContain('.');
    expect(en).not.toBe(id);
    expect(tr).not.toBe(en);
    expect(metricUnit(catalog, id)).toBe(def.unit);
    expect(inferModule(catalog, id)).toBeTruthy();
    expect(MODULE_ORDER).toContain(inferModule(catalog, id));
    // the message label agrees with the server label (the server one is the standalone English text)
    expect(en.replace(/\bAverage\b/g, 'Avg')).toBe(def.label.replace(/\bAverage\b/g, 'Avg'));
  });

  it('labels every module in both languages', () => {
    for (const moduleId of MODULE_ORDER) {
      expect(moduleLabel(moduleId, tEn)).not.toContain('.');
      expect(moduleLabel(moduleId, tTr)).not.toBe(moduleLabel(moduleId, tEn));
    }
    expect(moduleLabel('aegis', tEn)).toBe(moduleLabel('guardrails', tEn));
    expect(moduleLabel(undefined, tEn)).toBe('—');
  });

  it('falls back to the raw id for an unknown module or metric', () => {
    expect(moduleLabel('brand-new', tEn)).toBe('brand-new');
    expect(metricLabel(catalog, 'brand_new_metric', tEn)).toBe('brand_new_metric');
  });

  it('infers the module from the stored module, the catalog and the prefix', () => {
    expect(inferModule(catalog, 'agent_error_rate')).toBe('agents');
    expect(inferModule(catalog, 'error_rate', 'models')).toBe('models');
    expect(inferModule(catalog, 'x', 'aegis')).toBe('guardrails');
    expect(inferModule(catalog, 'kb_future_metric')).toBe('rag');
    expect(inferModule(catalog, 'mcp_server_future')).toBe('mcp');
    expect(inferModule(catalog, undefined)).toBe('models');
  });

  it('hides retired metrics unless the rule being edited uses one', () => {
    expect(metricsForModule(catalog, 'models').map((def) => def.id)).not.toContain('error_rate');
    expect(metricsForModule(catalog, 'models', 'error_rate').map((def) => def.id)).toContain('error_rate');
    expect(metricsForModule(catalog, 'guardrails').map((def) => def.id)).not.toContain('aegis_block_rate');
  });

  it('lists authorable modules in display order and never the retired alias', () => {
    const modules = authorableModules(catalog);
    expect(modules).not.toContain('aegis');
    expect(modules).toEqual(MODULE_ORDER.filter((module) => modules.includes(module)));
    expect(authorableModules(catalog, ['tools', 'agents'])).toEqual(['agents', 'tools']);
  });

  it('formats values, minutes and durations', () => {
    expect(formatMetricValue(12.345, '%', 'en')).toBe('12.35%');
    expect(formatMetricValue(1250, 'ms', 'en')).toBe('1,250 ms');
    expect(formatMetricValue(0.0412, '$', 'en')).toBe('$0.0412');
    expect(formatMetricValue(12.5, '$', 'en')).toBe('$12.50');
    expect(formatMetricValue(null, '%')).toBe('—');
    expect(formatMinutes(15, tEn)).toBe('15 min');
    expect(formatMinutes(120, tEn)).toBe('2 h');
    expect(formatMinutes(1440, tTr)).toBe('1 g');
    const from = '2026-10-15T10:00:00.000Z';
    expect(formatDurationBetween(from, '2026-10-15T12:05:00.000Z')).toBe('2h 5m');
    expect(formatDurationBetween(from, from)).toBe('<1m');
    expect(formatDurationBetween(null)).toBe('—');
  });

  it('reads the entity of an incident from its fields or the legacy scope', () => {
    expect(entityOf({ entityType: 'agent', entityKey: 'support' })).toEqual({ type: 'agent', key: 'support' });
    expect(entityOf({ metadata: { scope: { modelKey: 'gpt-x' } } })).toEqual({ type: 'model', key: 'gpt-x' });
    expect(entityOf({ metadata: {} })).toBeNull();
    expect(entityTypeLabel('kb', tEn, true)).toBe('knowledge bases');
  });

  it('summarizes the target and the condition of a rule', () => {
    expect(summarizeTarget({ entity: { entityType: 'agent', mode: 'all' } }, tEn)).toMatchObject({ kind: 'all', label: 'All agents' });
    expect(summarizeTarget({ entity: { entityType: 'agent', mode: 'selected', keys: ['a', 'b', 'c', 'd'] } }, tEn)).toMatchObject({
      kind: 'selected',
      label: 'a, b, +2',
    });
    expect(summarizeTarget({ scope: { guardrailKey: 'pii' } }, tEn)).toMatchObject({ kind: 'scope', label: 'guardrail: pii' });
    expect(summarizeTarget({}, tEn).kind).toBe('project');

    const rule = { metric: 'agent_error_rate', windowMinutes: 15 };
    expect(summarizeCondition({ ...rule, condition: { operator: 'gt', threshold: 5 } }, catalog, tEn, 'en')).toBe('> 5% · 15 min');
    expect(
      summarizeCondition(
        { ...rule, condition: { operator: 'gt', threshold: 0, mode: 'baseline', baseline: { direction: 'up', minRatio: 2, minZ: 3, minDelta: 0, lookbackDays: 14, seasonality: 'daily' } } },
        catalog,
        tEn,
      ),
    ).toBe('2× above normal (14 d) · 15 min');
    expect(
      summarizeCondition({ ...rule, condition: { operator: 'gt', threshold: 0, mode: 'absence', absence: { lookbackHours: 24, minExpectedPerWindow: 1 } } }, catalog, tEn),
    ).toBe('No data (normal over 24 h) · 15 min');
  });
});

// ── literal i18n keys of the alerts files ───────────────────────────────────

describe('alerts i18n keys referenced by the code', () => {
  const root = join(process.cwd(), 'src');
  const dirs = [join(root, 'components', 'alerts'), join(root, 'app', 'dashboard', 'alerts')];

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(entry) ? [full] : [];
    });
  }

  const resolves = (locale: 'en' | 'tr', namespace: string, key: string): 'string' | 'object' | undefined => {
    let node: unknown = (messages[locale] as unknown as Record<string, unknown>)[namespace];
    for (const part of key.split('.')) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
    return typeof node === 'string' ? 'string' : node && typeof node === 'object' ? 'object' : undefined;
  };

  it('resolves every literal t(...) key and every dynamic key prefix in en and tr', () => {
    const missing: string[] = [];
    for (const file of dirs.flatMap(walk)) {
      const source = readFileSync(file, 'utf8');
      // `const t = useTranslations('ns')`: the namespace of each translator variable. Pure files (no hook) take `alerts`.
      const bindings = new Map<string, string>();
      for (const match of source.matchAll(/const (\w+) = useTranslations\('(\w+)'\)/g)) bindings.set(match[1]!, match[2]!);
      const namespaceOf = (variable: string) => bindings.get(variable) ?? (bindings.size === 0 ? 'alerts' : undefined);

      for (const match of source.matchAll(/(?<![\w.])(t|ta|ti)\(\s*'([\w.]+)'/g)) {
        const namespace = namespaceOf(match[1]!);
        if (!namespace) continue;
        for (const locale of ['en', 'tr'] as const) {
          if (resolves(locale, namespace, match[2]!) !== 'string') missing.push(`${file}: ${locale} ${namespace}.${match[2]}`);
        }
      }
      for (const match of source.matchAll(/(?<![\w.])(t|ta|ti)\(\s*`([\w.]+)\.\$\{/g)) {
        const namespace = namespaceOf(match[1]!);
        if (!namespace) continue;
        for (const locale of ['en', 'tr'] as const) {
          if (resolves(locale, namespace, match[2]!) !== 'object') missing.push(`${file}: ${locale} ${namespace}.${match[2]}.*`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('finds the alerts files it is meant to scan', () => {
    expect(dirs.flatMap(walk).length).toBeGreaterThan(10);
  });
});

// ── ruleForm ────────────────────────────────────────────────────────────────

const STORED_RULE: AlertRuleDto = {
  _id: 'r1',
  name: 'Support errors',
  description: 'old description',
  module: 'agents',
  metric: 'agent_error_rate',
  condition: { operator: 'gt', threshold: 5, mode: 'threshold', forMinutes: 10, minSamples: 20 },
  windowMinutes: 30,
  cooldownMinutes: 60,
  enabled: true,
  entity: { entityType: 'agent', mode: 'selected', keys: ['support', 'sales'] },
  severity: 'warning',
  notifyOnResolve: true,
  renotifyMinutes: 120,
  channels: [
    { id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['ops@example.com'] },
    { id: 'ch_bbbbbbbbbbbb', type: 'slack', urlHint: 'https://hooks.slack.com/…abcd' },
    { id: 'ch_cccccccccccc', type: 'webhook', urlHint: 'https://example.com/…', hasSecret: true },
  ],
};

function validValues(overrides: Partial<RuleFormValues> = {}): RuleFormValues {
  return { ...defaultValues(catalog), name: 'Rule', channels: [{ ...newChannelItem('email'), recipients: ['a@example.com'] }], ...overrides };
}

describe('ruleForm', () => {
  it('builds values from a stored rule and keeps every stored channel as a reference', () => {
    const values = valuesFromRule(STORED_RULE, catalog);
    expect(values).toMatchObject({ module: 'agents', metric: 'agent_error_rate', entityMode: 'selected', entityKeys: ['support', 'sales'], threshold: 5, forMinutes: 10, minSamples: 20, windowMinutes: '30' });
    const payload = buildRulePayload(values, { catalog, isEdit: true });
    // a stored channel is sent as { id, type } (plus recipients for email): never a secret, never dropped
    expect(payload.channels).toEqual([
      { id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['ops@example.com'] },
      { id: 'ch_bbbbbbbbbbbb', type: 'slack' },
      { id: 'ch_cccccccccccc', type: 'webhook' },
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/hooks\.slack|example\.com\/…/);
  });

  it('clears the description and the legacy scope on an edit, and omits them on a create', () => {
    const cleared = valuesFromRule({ ...STORED_RULE, description: undefined }, catalog);
    const edit = buildRulePayload({ ...cleared, description: '   ' }, { catalog, isEdit: true });
    expect(edit.description).toBe('');
    expect(edit.scope).toEqual({});
    const create = buildRulePayload({ ...cleared, description: '' }, { catalog, isEdit: false });
    expect(create).not.toHaveProperty('description');
    expect(create).not.toHaveProperty('scope');
  });

  it('sends the entity scope: all or the selected keys', () => {
    const all = buildRulePayload(validValues(), { catalog, isEdit: false });
    expect(all.entity).toEqual({ entityType: 'agent', mode: 'all' });
    const selected = buildRulePayload(validValues({ entityMode: 'selected', entityKeys: ['support'] }), { catalog, isEdit: false });
    expect(selected.entity).toEqual({ entityType: 'agent', mode: 'selected', keys: ['support'] });
  });

  it('clears a legacy scope and the entity on an edit of a legacy metric', () => {
    const legacy = valuesFromRule({ ...STORED_RULE, module: 'guardrails', metric: 'guardrail_fail_rate', entity: undefined, scope: { guardrailKey: 'pii' }, channels: [] }, catalog);
    expect(buildRulePayload(legacy, { catalog, isEdit: true })).toMatchObject({ scope: { guardrailKey: 'pii' }, entity: null });
    const cleared = { ...legacy, guardrailKey: '' };
    expect(buildRulePayload(cleared, { catalog, isEdit: true })).toMatchObject({ scope: {}, entity: null });
    expect(buildRulePayload(cleared, { catalog, isEdit: false })).not.toHaveProperty('scope');
  });

  it('keeps a negative threshold and a zero threshold', () => {
    expect((buildRulePayload(validValues({ threshold: -3, operator: 'lt' }), { catalog, isEdit: false }).condition as { threshold: number }).threshold).toBe(-3);
    expect((buildRulePayload(validValues({ threshold: 0 }), { catalog, isEdit: false }).condition as { threshold: number }).threshold).toBe(0);
    expect(checkRule(validValues({ threshold: '' }), catalog).conditionIssue).toBe('validation.thresholdRequired');
    expect(checkRule(validValues({ threshold: -3 }), catalog).condition).toBe(true);
  });

  it('applies the baseline presets and sends the baseline condition', () => {
    const balanced = applyBaselinePreset({ ...validValues(), mode: 'baseline' }, 'balanced');
    expect(balanced).toMatchObject({ baselinePreset: 'balanced', baselineMinRatio: 2, baselineMinZ: 3, baselineLookbackDays: 14 });
    const sensitive = applyBaselinePreset(balanced, 'sensitive');
    const payload = buildRulePayload(sensitive, { catalog, isEdit: false });
    expect(payload.condition).toMatchObject({ mode: 'baseline', baseline: { direction: 'up', minRatio: 1.5, minZ: 2, minDelta: 0, lookbackDays: 14, seasonality: 'daily' } });
    expect(payload.condition).not.toHaveProperty('threshold');
    // editing the numbers by hand turns the preset into "custom" when the rule is loaded again
    const loaded = valuesFromRule({ ...STORED_RULE, condition: { operator: 'gt', threshold: 0, mode: 'baseline', baseline: { direction: 'up', minRatio: 2.5, minZ: 3, minDelta: 0, lookbackDays: 14, seasonality: 'daily' } } }, catalog);
    expect(loaded.baselinePreset).toBe('custom');
  });

  it('validates the baseline, absence and SLO conditions', () => {
    const baseline = { ...validValues(), mode: 'baseline' as const };
    expect(checkRule({ ...baseline, baselineMinRatio: 25 }, catalog).conditionIssue).toBe('validation.baselineRatio');
    expect(checkRule({ ...baseline, baselineLookbackDays: 2 }, catalog).conditionIssue).toBe('validation.baselineLookback');
    expect(checkRule({ ...baseline, baselineSeasonality: 'weekly', baselineLookbackDays: 14 }, catalog).conditionIssue).toBe('validation.baselineWeekly');
    expect(checkRule({ ...baseline, baselineSeasonality: 'weekly', baselineLookbackDays: 28 }, catalog).condition).toBe(true);

    const absence = { ...validValues(), mode: 'absence' as const };
    expect(buildRulePayload(absence, { catalog, isEdit: false }).condition).toMatchObject({ mode: 'absence', absence: { lookbackHours: 24, minExpectedPerWindow: 1 } });
    expect(checkRule({ ...absence, absenceLookbackHours: 500 }, catalog).conditionIssue).toBe('validation.absenceHours');
    expect(checkRule({ ...absence, absenceMinExpected: 0 }, catalog).conditionIssue).toBe('validation.absenceExpected');

    const slo = { ...validValues(), mode: 'slo_burn' as const };
    expect(buildRulePayload(slo, { catalog, isEdit: false }).condition).toMatchObject({ mode: 'slo_burn', slo: { objectivePct: 99, windowDays: 30, burnRate: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5 } });
    expect(checkRule({ ...slo, sloObjectivePct: 40 }, catalog).conditionIssue).toBe('validation.sloObjective');
    expect(checkRule({ ...slo, sloLongWindow: 5, sloShortWindow: 5 }, catalog).conditionIssue).toBe('validation.sloWindows');
  });

  it('bounds the latency objective of a p95 SLO to the histogram bounds', () => {
    expect(SLO_LATENCY_BOUNDS_MS).toContain(DEFAULT_SLO_LATENCY_MS);
    const p95 = { ...validValues({ metric: 'agent_p95_duration_ms' }), mode: 'slo_burn' as const };
    expect((buildRulePayload(p95, { catalog, isEdit: false }).condition as { slo: { latencyThresholdMs: number } }).slo.latencyThresholdMs).toBe(DEFAULT_SLO_LATENCY_MS);
    expect(checkRule({ ...p95, sloLatencyThresholdMs: '1234' }, catalog).conditionIssue).toBe('validation.sloLatency');
    expect(checkRule({ ...p95, sloLatencyThresholdMs: String(SLO_LATENCY_BOUNDS_MS[0]) }, catalog).condition).toBe(true);
    const errors = { ...validValues({ metric: 'agent_error_rate' }), mode: 'slo_burn' as const };
    expect((buildRulePayload(errors, { catalog, isEdit: false }).condition as { slo: object }).slo).not.toHaveProperty('latencyThresholdMs');
  });

  it('gates the save on the name, a selected entity and the channels', () => {
    expect(checkRule(validValues(), catalog).canSave).toBe(true);
    expect(checkRule(validValues({ name: '  ' }), catalog)).toMatchObject({ name: false, canSave: false });
    expect(checkRule(validValues({ entityMode: 'selected', entityKeys: [] }), catalog)).toMatchObject({ target: false, canSave: false });
    expect(checkRule(validValues({ channels: [] }), catalog)).toMatchObject({ channels: false, canSave: false });
    expect(checkRule(validValues({ channels: [{ ...newChannelItem('email'), recipients: ['not-an-email'] }] }), catalog).channels).toBe(false);
    expect(checkRule(validValues({ channels: Array.from({ length: 11 }, () => ({ ...newChannelItem('email'), recipients: [] })) }), catalog).channels).toBe(false);
  });

  it('refuses a mode the metric does not support', () => {
    expect(checkRule({ ...validValues({ metric: 'gpu_cache_usage', module: 'inference' }), mode: 'baseline' }, catalog).conditionIssue).toBe('validation.modeUnsupported');
    expect(applyMetricChange({ ...validValues(), mode: 'baseline' }, 'gpu_cache_usage', catalog).mode).toBe('threshold');
  });

  it('resets the target when the module changes', () => {
    const changed = applyModuleChange(validValues({ entityMode: 'selected', entityKeys: ['x'], guardrailKey: 'pii' }), 'models', catalog);
    expect(changed).toMatchObject({ module: 'models', entityMode: 'all', entityKeys: [], guardrailKey: '' });
    expect(catalog.byId.get(changed.metric)?.module).toBe('models');
  });

  it('prefills the create form from the deep link', () => {
    const prefill = prefillFromParams({ module: 'agents', metric: 'agent_error_rate', entityType: 'agent', entityKey: 'support' }, catalog);
    expect(prefill).toEqual({ module: 'agents', metric: 'agent_error_rate', entity: { entityType: 'agent', mode: 'selected', keys: ['support'] } });
    const values = valuesFromRule(prefill, catalog);
    expect(values).toMatchObject({ module: 'agents', metric: 'agent_error_rate', entityMode: 'selected', entityKeys: ['support'], name: '' });
    // an unknown metric and a mismatching entity type are ignored
    expect(prefillFromParams({ metric: 'nope', entityKey: 'x' }, catalog)).toEqual({});
    expect(prefillFromParams({ metric: 'agent_error_rate', entityType: 'model', entityKey: 'x' }, catalog)).not.toHaveProperty('entity');
    // a module alone selects the module's first metric
    const moduleOnly = valuesFromRule(prefillFromParams({ module: 'tools' }, catalog), catalog);
    expect(catalog.byId.get(moduleOnly.metric)?.module).toBe('tools');
  });

  it('duplicates a rule with its email channels only', () => {
    const { seed, droppedChannels } = duplicateRuleSeed(STORED_RULE, 'Copy of Support errors');
    expect(droppedChannels).toBe(2);
    expect(seed).toMatchObject({ name: 'Copy of Support errors', metric: 'agent_error_rate', channels: [{ type: 'email', recipients: ['ops@example.com'] }] });
    expect(seed).not.toHaveProperty('_id');
    const values = valuesFromRule(seed, catalog);
    expect(values.channels.every((channel) => !channel.id)).toBe(true);
  });

  it('describes a rule as a sentence in both languages', () => {
    const values = validValues({ entityMode: 'selected', entityKeys: ['support'], threshold: 5, forMinutes: 10, windowMinutes: '30' });
    expect(describeRule(values, catalog, tEn, 'en')).toBe('Alert when the Agent Error Rate of support is > 5% in a 30 min window for 10 min. Notify: Email.');
    const tr = describeRule(values, catalog, tTr, 'tr');
    expect(tr).toContain('Ajan Hata Oranı');
    expect(tr).not.toContain('{');
    expect(describeRule({ ...values, mode: 'baseline' }, catalog, tEn)).toContain('above its 14-day normal');
    expect(describeRule({ ...values, mode: 'absence' }, catalog, tEn)).toContain('send no data');
    expect(describeRule({ ...values, mode: 'slo_burn', entityMode: 'all' }, catalog, tEn)).toContain('budget');
  });
});

// ── channelItems ────────────────────────────────────────────────────────────

describe('channelItems', () => {
  const stored = channelsFromStored(STORED_RULE.channels);
  const webhook = stored[2]!;

  it('turns stored channels into items that carry hints but no secret', () => {
    expect(stored).toHaveLength(3);
    expect(webhook).toMatchObject({ id: 'ch_cccccccccccc', type: 'webhook', hasSecret: true, urlHint: 'https://example.com/…' });
    expect(webhook.url).toBeUndefined();
    expect(webhook.secret).toBeUndefined();
    expect(isStoredChannel(webhook)).toBe(true);
    expect(isStoredChannel(stored[0]!)).toBe(false);
    expect(channelsFromStored(undefined)).toEqual([]);
  });

  it('sends a stored channel as a reference and a replaced one with its new values', () => {
    expect(channelToInput(webhook)).toEqual({ id: 'ch_cccccccccccc', type: 'webhook' });
    expect(channelToInput({ ...webhook, replace: true, url: ' https://new.example.com/hook ', secret: ' s3cret ' })).toEqual({
      id: 'ch_cccccccccccc',
      type: 'webhook',
      url: 'https://new.example.com/hook',
      secret: 's3cret',
    });
  });

  it('removes a stored signing secret with an empty string, only when asked', () => {
    expect(channelToInput({ ...webhook, clearSecret: true })).toEqual({ id: 'ch_cccccccccccc', type: 'webhook', secret: '' });
    expect(channelToInput({ ...webhook, clearSecret: true, secret: 'new' })).toMatchObject({ secret: 'new' });
    expect(channelToInput(webhook)).not.toHaveProperty('secret');
  });

  it('keeps the other channel types intact', () => {
    const pagerduty = { ...newChannelItem('pagerduty'), routingKey: 'a'.repeat(32) };
    expect(channelsToInput([pagerduty, { ...newChannelItem('teams'), url: 'https://teams.example.com/x' }, { ...newChannelItem('email'), recipients: [' a@b.co ', ''] }])).toEqual([
      { type: 'pagerduty', routingKey: 'a'.repeat(32) },
      { type: 'teams', url: 'https://teams.example.com/x' },
      { type: 'email', recipients: ['a@b.co'] },
    ]);
  });

  it('validates each channel type', () => {
    expect(validateChannel({ ...newChannelItem('email'), recipients: ['bad'] })).toEqual({ code: 'invalidEmail', value: 'bad' });
    expect(validateChannel({ ...newChannelItem('email'), recipients: [] })).toBeNull();
    expect(validateChannel(newChannelItem('webhook'))).toEqual({ code: 'urlRequired' });
    expect(validateChannel({ ...newChannelItem('slack'), url: 'http://insecure.example.com' })).toEqual({ code: 'urlInvalid' });
    expect(validateChannel({ ...newChannelItem('slack'), url: 'https://hooks.slack.com/x' })).toBeNull();
    expect(validateChannel(newChannelItem('pagerduty'))).toEqual({ code: 'routingKeyRequired' });
    expect(validateChannel({ ...newChannelItem('pagerduty'), routingKey: 'short' })).toEqual({ code: 'routingKeyInvalid' });
    // a stored channel may leave its secret fields empty
    expect(validateChannel(webhook)).toBeNull();
    expect(validateChannels(stored)).toBeNull();
    expect(validateChannels([stored[0]!, newChannelItem('webhook')])).toEqual({ code: 'urlRequired' });
  });

  it('tests a stored channel by reference and a typed one as typed', () => {
    expect(buildChannelTestBody(webhook, 'r1')).toEqual({ ruleId: 'r1', channelId: 'ch_cccccccccccc' });
    // an unsaved rule has nothing to reference
    expect(buildChannelTestBody(webhook, null)).toBeNull();
    const typed = { ...newChannelItem('slack'), url: 'https://hooks.slack.com/x' };
    expect(buildChannelTestBody(typed, null)).toEqual({ channel: { type: 'slack', url: 'https://hooks.slack.com/x' } });
    // a replaced channel is tested with the new values, an invalid one not at all
    expect(buildChannelTestBody({ ...webhook, replace: true, url: 'https://new.example.com/h' }, 'r1')).toEqual({
      channel: { id: 'ch_cccccccccccc', type: 'webhook', url: 'https://new.example.com/h' },
    });
    expect(buildChannelTestBody({ ...newChannelItem('slack'), url: 'nope' }, 'r1')).toBeNull();
  });
});

// ── incidentUi ──────────────────────────────────────────────────────────────

function incident(overrides: Partial<IncidentDto> = {}): IncidentDto {
  return {
    _id: 'i1',
    ruleName: 'Rule',
    ruleId: 'r1',
    alertEventId: 'e1',
    metric: 'agent_error_rate',
    threshold: 5,
    actualValue: 9,
    severity: 'warning',
    status: 'open',
    notes: [],
    firedAt: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('incidentUi', () => {
  it('follows the server status lifecycle', () => {
    expect(canTransition('open', 'acknowledged')).toBe(true);
    expect(canTransition('closed', 'resolved')).toBe(false);
    expect(canTransition('resolved', 'open')).toBe(true);
    expect(canTransition('acknowledged', 'acknowledged')).toBe(false);
  });

  it('keeps only the incidents a bulk action applies to', () => {
    const statuses: IncidentStatus[] = ['open', 'acknowledged', 'investigating', 'resolved', 'closed'];
    const incidents = statuses.map((status) => incident({ _id: status, status }));
    expect(bulkEligible(incidents, 'acknowledge').map((entry) => entry._id)).toEqual(['open']);
    expect(bulkEligible(incidents, 'resolve').map((entry) => entry._id)).toEqual(['open', 'acknowledged', 'investigating']);
    expect(bulkEligible(incidents, 'close').map((entry) => entry._id)).toEqual(['open', 'acknowledged', 'investigating', 'resolved']);
  });

  it('names the verb of a transition, with reopen for a resolved or closed incident', () => {
    expect(statusActionKey('open', 'resolved')).toBe('reopen');
    expect(statusActionKey('open', 'closed')).toBe('reopen');
    expect(statusActionKey('resolved', 'open')).toBe('resolve');
    expect(statusActionKey('investigating', 'open')).toBe('investigate');
  });

  it('builds the timeline oldest first with notes and the resolver', () => {
    const entries = timelineEntries(
      incident({
        acknowledgedAt: '2026-10-15T10:05:00.000Z',
        acknowledgedBy: 'u1',
        resolvedAt: '2026-10-15T10:30:00.000Z',
        resolvedBy: 'system',
        autoResolved: true,
        notes: [{ userId: 'u1', userName: 'Ada', content: 'looking', createdAt: '2026-10-15T10:10:00.000Z' }],
      }),
    );
    expect(entries.map((entry) => entry.kind)).toEqual(['fired', 'acknowledged', 'note', 'resolved']);
    expect(entries[1]).toMatchObject({ by: 'u1' });
    expect(entries[2]).toMatchObject({ by: 'Ada', content: 'looking' });
    expect(entries[3]).toMatchObject({ system: true });
    expect(timelineEntries(incident({ resolvedAt: '2026-10-15T11:00:00.000Z', resolvedBy: 'u2' }))[1]).toMatchObject({ system: false, by: 'u2' });
    expect(
      timelineEntries(incident({ resolvedAt: '2026-10-15T11:00:00.000Z', resolvedBy: 'u2', resolvedByName: 'Grace', acknowledgedAt: '2026-10-15T10:30:00.000Z', acknowledgedBy: 'u3', acknowledgedByName: 'Linus' })).slice(1),
    ).toMatchObject([{ kind: 'acknowledged', by: 'u3', byName: 'Linus' }, { kind: 'resolved', by: 'u2', byName: 'Grace' }]);
  });
});
