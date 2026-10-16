'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, NumberInput, Select, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBell, IconChevronDown, IconChevronRight, IconPlayerPlay } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  OPERATORS,
  authorableModules,
  createAlertCatalog,
  entityTypeLabel,
  formatMetricValue,
  formatMinutes,
  getDef,
  isEnterpriseMetric,
  isEntityMetric,
  metricLabel,
  metricUnit,
  metricsForModule,
  moduleLabel,
  operatorSymbol,
  type AlertCatalog,
} from './alertCatalog';
import {
  ALL_CHANNEL_TYPES,
  type AlertConditionMode,
  type AlertMeta,
  type AlertRuleDto,
  type AlertRuleSeverity,
  type ChannelTestResult,
  type PreviewTarget,
} from './alertTypes';
import ChannelsEditor, { MAX_CHANNELS } from './ChannelsEditor';
import { buildChannelTestBody } from './channelItems';
import LibraryChannelPicker from './channels/LibraryChannelPicker';
import { useChannelLibrary } from './channels/useChannelLibrary';
import BacktestPanel from './rules/BacktestPanel';
import EntityPicker from './EntityPicker';
import { moduleIcon } from './moduleIcons';
import { translateServerNotes } from './incidentUi';
import { useAlertMeta } from './useAlertMeta';
import {
  BASELINE_PRESETS,
  COOLDOWN_MINUTES,
  DEFAULT_WINDOWS,
  RENOTIFY_MINUTES,
  SCOPE_FIELD_BY_MODULE,
  SLO_LATENCY_BOUNDS_MS,
  applyBaselinePreset,
  applyMetricChange,
  applyBacktestSuggestion,
  applyModuleChange,
  buildBacktestBody,
  buildRulePayload,
  channelsSignature,
  checkRule,
  describeRule,
  isValidRunbookUrl,
  valuesFromRule,
  type BaselinePreset,
  type RuleFormValues,
} from './ruleForm';
import ScopePicker from './ScopePicker';

export interface AlertRuleFormProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /** The rule being edited, or a prefill for a new one (`{ module, metric, entity }`). Read when the form opens. */
  initialData?: Record<string, unknown>;
  mode?: 'create' | 'edit';
  ruleId?: string;
  /** `meta` of `GET /alerts/rules`. Without it the form loads it itself. */
  meta?: AlertMeta | null;
}

const MODES: AlertConditionMode[] = ['threshold', 'baseline', 'absence', 'slo_burn'];
const SEVERITIES: AlertRuleSeverity[] = ['auto', 'info', 'warning', 'critical'];

interface PreviewState {
  key: string;
  loading: boolean;
  targets: PreviewTarget[];
  notes: string[];
  error: string | null;
}

export default function AlertRuleForm({
  opened,
  onClose,
  onSuccess,
  initialData,
  mode = 'create',
  ruleId,
  meta: metaProp,
}: AlertRuleFormProps) {
  const t = useTranslations('alerts');
  const locale = useLocale();
  const isEdit = mode === 'edit';

  // Meta: from the page when it has it, else loaded (and shared with the other alerts screens) when the form opens.
  const shared = useAlertMeta({ enabled: opened && !metaProp });
  const meta = metaProp ?? shared.meta;
  // The request finished without an answer: the bundled catalog stands in and which condition types the workspace
  // may use is unknown (the server still refuses an unavailable one on save).
  const metaUnknown = !meta && shared.failed;

  const catalog: AlertCatalog = useMemo(() => createAlertCatalog(meta?.catalog), [meta?.catalog]);

  const [values, setValues] = useState<RuleFormValues>(() => valuesFromRule(initialData as Partial<AlertRuleDto> | undefined, catalog));
  const patch = useCallback((next: Partial<RuleFormValues>) => setValues((current) => ({ ...current, ...next })), []);
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  // Re-seed when the form opens (or switches rule), from whatever was handed in at that moment. The data is read through
  // a ref so a new object identity on a parent re-render never wipes what the user has typed.
  const initialRef = useRef(initialData);
  initialRef.current = initialData;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  // The channel list as the stored rule has it: an edit that leaves it alone does not send it.
  const initialChannelsSig = useRef<string | null>(null);
  useEffect(() => {
    if (!opened) return;
    const seeded = valuesFromRule(initialRef.current as Partial<AlertRuleDto> | undefined, catalogRef.current);
    initialChannelsSig.current = mode === 'edit' ? channelsSignature(seeded.channels, seeded.libraryRefs) : null;
    setValues(seeded);
    setShowAdvanced(false);
    setPreview(null);
  }, [opened, ruleId, mode]);

  const def = getDef(catalog, values.metric);
  const entityRule = isEntityMetric(def);
  const channelsUnchanged = isEdit && initialChannelsSig.current !== null && channelsSignature(values.channels, values.libraryRefs) === initialChannelsSig.current;
  const checks = useMemo(() => checkRule(values, catalog, { channelsUnchanged }), [values, catalog, channelsUnchanged]);
  const unit = metricUnit(catalog, values.metric);
  const runbookValid = isValidRunbookUrl(values.runbookUrl);
  const library = useChannelLibrary({ enabled: opened, fallbackError: t('libraryUx.loadError') });
  const backtestKey = useMemo(() => JSON.stringify(buildBacktestBody(values, { catalog, isEdit })), [values, catalog, isEdit]);

  const editingMetric = isEdit ? ((initialData?.metric as string | undefined) ?? null) : null;
  const modules = useMemo(() => {
    const list: string[] = authorableModules(catalog, meta?.validModules);
    return list.includes(values.module) ? list : [...list, values.module];
  }, [catalog, meta?.validModules, values.module]);
  const metricOptions = useMemo(
    () =>
      metricsForModule(catalog, values.module, editingMetric ?? values.metric).map((entry) => ({
        value: entry.id as string,
        label: metricLabel(catalog, entry.id, t),
      })),
    [catalog, values.module, editingMetric, values.metric, t],
  );
  const windowOptions = useMemo(
    () => (meta?.validWindows?.length ? meta.validWindows : DEFAULT_WINDOWS).map((minutes) => ({ value: String(minutes), label: formatMinutes(minutes, t) })),
    [meta?.validWindows, t],
  );

  const modeAvailable = (candidate: AlertConditionMode): boolean => {
    const entry = meta?.modes?.[candidate];
    return entry ? entry.available !== false : true;
  };
  const supportedModes = MODES.filter((candidate) => def?.modes.includes(candidate));
  const blockedModes = supportedModes.filter((candidate) => !modeAvailable(candidate));
  const blockedReason = blockedModes.length > 0 ? meta?.modes?.[blockedModes[0]!]?.reason : undefined;

  // ── Preview ────────────────────────────────────────────────────────────
  const previewKey = useMemo(() => JSON.stringify(buildRulePayload(values, { catalog, isEdit, preview: true })), [values, catalog, isEdit]);
  const previewAbort = useRef<AbortController | null>(null);
  useEffect(() => () => previewAbort.current?.abort(), []);
  const runPreview = async () => {
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    const key = previewKey;
    setPreview({ key, loading: true, targets: [], notes: [], error: null });
    try {
      const res = await fetch('/api/alerts/rules/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: key,
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => null)) as { targets?: PreviewTarget[]; notes?: string[]; message?: string; error?: string } | null;
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? t('preview.failed'));
      setPreview({ key, loading: false, targets: data?.targets ?? [], notes: translateServerNotes(data?.notes, t, locale === 'en'), error: null });
    } catch (error) {
      if (controller.signal.aborted) return;
      setPreview({ key, loading: false, targets: [], notes: [], error: error instanceof Error ? error.message : t('preview.failed') });
    }
  };

  // ── Channel test ───────────────────────────────────────────────────────
  const testRuleId = isEdit ? (ruleId ?? null) : null;
  const onTestChannel = useCallback(
    async (item: Parameters<typeof buildChannelTestBody>[0]): Promise<ChannelTestResult> => {
      const body = buildChannelTestBody(item, testRuleId);
      if (!body) throw new Error(t('channels.testUnavailable'));
      const res = await fetch('/api/alerts/channels/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { result?: ChannelTestResult; message?: string; error?: string } | null;
      if (!res.ok || !data?.result) throw new Error(data?.message ?? data?.error ?? t('channels.testNoDetail'));
      return data.result;
    },
    [testRuleId, t],
  );
  const canTestChannel = useCallback((item: Parameters<typeof buildChannelTestBody>[0]) => buildChannelTestBody(item, testRuleId) !== null, [testRuleId]);

  // ── Submit ─────────────────────────────────────────────────────────────
  const submit = async () => {
    if (!checks.canSave || !runbookValid) return;
    setSaving(true);
    try {
      const body = buildRulePayload(values, { catalog, isEdit, channelsUnchanged });
      const res = await fetch(isEdit ? `/api/alerts/rules/${ruleId}` : '/api/alerts/rules', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
        throw new Error(data?.message ?? data?.error ?? t('saveFailed'));
      }
      notifications.show({
        title: t(isEdit ? 'ruleUpdated' : 'ruleCreated'),
        message: t(isEdit ? 'ruleUpdatedMessage' : 'ruleCreatedMessage'),
        color: 'teal',
      });
      onSuccess();
      onClose();
    } catch (error) {
      notifications.show({
        title: t('error'),
        message: error instanceof Error ? error.message : t('saveFailed'),
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  // ── Pieces ─────────────────────────────────────────────────────────────
  const optional = (label: string): ReactNode => (
    <>
      {label}
      <span className="ds-faint" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
        {' · '}
        {t('form.optional')}
      </span>
    </>
  );

  const numberField = (
    field: keyof RuleFormValues,
    options: { min?: number; max?: number; decimals?: number; allowNegative?: boolean; prefix?: string; suffix?: string; step?: number; placeholder?: string } = {},
  ) => ({
    value: values[field] as number | string,
    onChange: (next: number | string) => patch({ [field]: next } as Partial<RuleFormValues>),
    min: options.min,
    max: options.max,
    decimalScale: options.decimals ?? 0,
    allowNegative: options.allowNegative ?? false,
    prefix: options.prefix,
    suffix: options.suffix,
    step: options.step,
    placeholder: options.placeholder,
    hideControls: true,
  });

  const stateSummary = describeRule(values, catalog, t, locale);
  const totalChecks = 5;
  const readyChecks = [checks.name, checks.metric, checks.target, checks.condition, checks.channels].filter(Boolean).length;

  const checklist = [
    { id: 'metric', label: t('form.checkMetric'), done: checks.metric },
    { id: 'target', label: t('form.checkTarget'), done: checks.target },
    { id: 'condition', label: t('form.checkCondition'), done: checks.condition },
    { id: 'channels', label: t('form.checkChannels'), done: checks.channels },
    { id: 'name', label: t('form.checkName'), done: checks.name },
  ];

  const previewCurrent = preview && preview.key === previewKey ? preview : null;

  const summary = (
    <>
      <SummaryGroup title={t('form.summaryRule')}>
        <Text size="sm" style={{ lineHeight: 1.5 }} data-testid="rule-sentence">
          {stateSummary}
        </Text>
        <SummaryKV label={t('form.module')} value={moduleLabel(values.module, t)} />
        <SummaryKV label={t('form.severity')} value={t(`severity.${values.severity}`)} />
        <SummaryKV
          label={t('form.enabled')}
          value={<span className={`ds-badge ${values.enabled ? 'ds-badge-ok' : 'ds-badge-warn'}`}>{values.enabled ? t('form.on') : t('form.off')}</span>}
        />
      </SummaryGroup>

      <SummaryGroup title={t('form.preflight')}>
        <Checklist items={checklist} />
      </SummaryGroup>

      <SummaryGroup title={t('preview.title')}>
        <Text size="xs" c="dimmed">
          {t('preview.hint')}
        </Text>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconPlayerPlay size={12} stroke={1.7} />}
          loading={Boolean(previewCurrent?.loading)}
          disabled={!checks.metric || !checks.target || !checks.condition}
          onClick={() => void runPreview()}
        >
          {t('preview.run')}
        </Button>
        {previewCurrent && !previewCurrent.loading ? (
          previewCurrent.error ? (
            <Text size="xs" c="red" role="alert">
              {previewCurrent.error}
            </Text>
          ) : (
            <PreviewTable targets={previewCurrent.targets} notes={previewCurrent.notes} unit={unit} locale={locale} mode={values.mode} />
          )
        ) : null}
      </SummaryGroup>

      <SummaryGroup title={t('rulesUx.backtest.title')}>
        <BacktestPanel
          requestKey={backtestKey}
          ready={checks.metric && checks.target && checks.condition}
          onApplyThreshold={(threshold) => setValues((current) => applyBacktestSuggestion(current, { threshold }))}
        />
      </SummaryGroup>
    </>
  );

  const entityPlural = def?.entityType ? entityTypeLabel(def.entityType, t, true) : '';
  const entitySingular = def?.entityType ? entityTypeLabel(def.entityType, t) : '';
  const scopeField = SCOPE_FIELD_BY_MODULE[values.module];

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconBell size={16} />}
      title={isEdit ? t('editRule') : t('createRule')}
      subtitle={isEdit ? t('form.subtitleEdit') : t('form.subtitleCreate')}
      summary={summary}
      footerStatus={t('form.ready', { done: readyChecks, total: totalChecks })}
      primaryAction={{
        label: isEdit ? t('save') : t('create'),
        loading: saving,
        disabled: !checks.canSave || !runbookValid,
        onClick: () => void submit(),
      }}
      secondaryAction={{ label: t('cancel'), onClick: onClose }}
    >
      {/* 1 · module & metric */}
      <FormSection number={1} title={t('form.sectionMetric')} description={t('form.sectionMetricDescription')} done={checks.metric}>
        <FormRow cols={1}>
          <FormField label={t('form.module')} required>
            <ChipPicker<string>
              options={modules.map((module) => {
                const ModuleIcon = moduleIcon(module);
                return { value: module, label: moduleLabel(module, t), icon: <ModuleIcon size={14} stroke={1.7} /> };
              })}
              value={values.module}
              onChange={(next) => setValues((current) => applyModuleChange(current, next as string, catalog))}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('form.metric')} required>
            <Select
              aria-label={t('form.metric')}
              data={metricOptions}
              value={values.metric}
              allowDeselect={false}
              onChange={(next) => {
                if (next) setValues((current) => applyMetricChange(current, next, catalog));
              }}
              renderOption={({ option }) => {
                const entry = getDef(catalog, option.value);
                return (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
                    <span style={{ flex: 1 }}>{option.label}</span>
                    {isEntityMetric(entry) ? <span className="ds-badge ds-badge-teal">{t('form.badgePerEntity')}</span> : null}
                    {isEnterpriseMetric(entry) ? <span className="ds-badge ds-badge-info">{t('form.badgeEnterprise')}</span> : null}
                    {entry?.hiddenForNewRules ? <span className="ds-badge">{t('form.badgeLegacy')}</span> : null}
                  </div>
                );
              }}
            />
          </FormField>
        </FormRow>
        {isEnterpriseMetric(def) ? (
          <Text size="xs" c="dimmed">
            {t('form.enterpriseMetricNote')}
          </Text>
        ) : null}
      </FormSection>

      {/* 2 · target */}
      <FormSection number={2} title={t('form.sectionTarget')} description={t('form.sectionTargetDescription')} done={checks.target}>
        {entityRule && def?.entityType ? (
          <>
            <ChipPicker<string>
              options={[
                { value: 'all', label: t('target.all', { type: entityPlural }) },
                { value: 'selected', label: t('target.selected') },
              ]}
              value={values.entityMode}
              onChange={(next) => patch({ entityMode: next as 'all' | 'selected' })}
            />
            {values.entityMode === 'selected' ? (
              <EntityPicker
                entityType={def.entityType}
                value={values.entityKeys}
                onChange={(entityKeys) => patch({ entityKeys })}
                error={values.entityKeys.length === 0 ? t('validation.entityRequired') : undefined}
              />
            ) : (
              <Text size="xs" c="dimmed">
                {t('target.allHint', { type: entitySingular })}
              </Text>
            )}
          </>
        ) : scopeField ? (
          <ScopePicker
            field={scopeField}
            label={optional(t(`form.${scopeField}`))}
            value={values[scopeField]}
            onChange={(next) => patch({ [scopeField]: next } as Partial<RuleFormValues>)}
          />
        ) : (
          <Text size="sm" c="dimmed">
            {t('target.projectWide')}
          </Text>
        )}
      </FormSection>

      {/* 3 · condition */}
      <FormSection number={3} title={t('form.sectionCondition')} description={t('form.sectionConditionDescription')} done={checks.condition}>
        <FormRow cols={1}>
          <FormField label={t('form.conditionMode')} required>
            <div className="form-chips" role="group" aria-label={t('form.conditionMode')}>
              {supportedModes.map((candidate) => {
                const available = modeAvailable(candidate);
                return (
                  <button
                    key={candidate}
                    type="button"
                    className={`form-chip ${values.mode === candidate ? 'selected' : ''}`}
                    aria-pressed={values.mode === candidate}
                    disabled={!available && values.mode !== candidate}
                    title={available ? t(`modeHint.${candidate}`) : t('form.modeNeedsEnterprise')}
                    onClick={() => patch({ mode: candidate })}
                  >
                    {t(`mode.${candidate}`)}
                    {!available ? <span className="ds-badge ds-badge-info">{t('form.badgeEnterprise')}</span> : null}
                  </button>
                );
              })}
            </div>
            <div className="form-field-hint">{t(`modeHint.${values.mode}`)}</div>
            {blockedModes.length > 0 ? (
              <Text size="xs" c="dimmed" data-testid="mode-upsell">
                {t(blockedReason === 'license_required' ? 'form.modeUpsellLicense' : 'form.modeUpsellBuild')}
              </Text>
            ) : null}
            {metaUnknown ? (
              <Text size="xs" c="orange" data-testid="mode-unknown">
                {t('form.modeAvailabilityUnknown')}
              </Text>
            ) : null}
            {!modeAvailable(values.mode) ? (
              <Text size="xs" c="orange" role="alert">
                {t('form.modeUnavailableSelected')}
              </Text>
            ) : null}
          </FormField>
        </FormRow>

        {values.mode === 'threshold' ? (
          <FormRow cols={2}>
            <FormField label={t('form.operator')} required>
              <Select
                aria-label={t('form.operator')}
                data={OPERATORS.map((operator) => ({ value: operator, label: `${operatorSymbol(operator)} ${t(`operators.${operator}`)}` }))}
                value={values.operator}
                allowDeselect={false}
                onChange={(next) => next && patch({ operator: next as RuleFormValues['operator'] })}
              />
            </FormField>
            <FormField label={t('form.threshold')} required>
              <NumberInput
                aria-label={t('form.threshold')}
                {...numberField('threshold', {
                  decimals: 4,
                  allowNegative: true,
                  ...(unit === '%' ? { suffix: '%' } : unit === 'ms' ? { suffix: ' ms' } : unit === '$' ? { prefix: '$' } : {}),
                })}
              />
            </FormField>
          </FormRow>
        ) : null}

        {values.mode === 'baseline' ? (
          <>
            <FormRow cols={1}>
              <FormField label={t('form.sensitivity')} hint={t('form.sensitivityHint')}>
                <ChipPicker<string>
                  options={[
                    { value: 'sensitive', label: t('baseline.sensitive') },
                    { value: 'balanced', label: t('baseline.balanced') },
                    { value: 'calm', label: t('baseline.calm') },
                    ...(values.baselinePreset === 'custom' ? [{ value: 'custom', label: t('baseline.custom') }] : []),
                  ]}
                  value={values.baselinePreset}
                  onChange={(next) => setValues((current) => applyBaselinePreset(current, next as BaselinePreset))}
                />
                <div className="form-field-hint">
                  {values.baselinePreset !== 'custom'
                    ? t('baseline.presetSummary', {
                        ratio: BASELINE_PRESETS[values.baselinePreset].minRatio,
                        z: BASELINE_PRESETS[values.baselinePreset].minZ,
                        days: BASELINE_PRESETS[values.baselinePreset].lookbackDays,
                      })
                    : t('baseline.customSummary')}
                </div>
              </FormField>
            </FormRow>
            <div>
              <Button
                variant="subtle"
                size="compact-xs"
                color="gray"
                // The form is portaled out of the app shell, where the design system's subtle-button colour does not
                // apply and Mantine's own gray is the near-invisible border tone.
                style={{ color: 'var(--ds-text-muted)' }}
                leftSection={showAdvanced ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                aria-expanded={showAdvanced}
                onClick={() => setShowAdvanced((open) => !open)}
              >
                {t('form.advanced')}
              </Button>
            </div>
            {showAdvanced ? (
              <>
                <FormRow cols={2}>
                  <FormField label={t('baseline.direction')}>
                    <Select
                      aria-label={t('baseline.direction')}
                      data={[
                        { value: 'up', label: t('baseline.directionUp') },
                        { value: 'down', label: t('baseline.directionDown') },
                        { value: 'both', label: t('baseline.directionBoth') },
                      ]}
                      value={values.baselineDirection}
                      allowDeselect={false}
                      onChange={(next) => next && patch({ baselineDirection: next as RuleFormValues['baselineDirection'], baselinePreset: 'custom' })}
                    />
                  </FormField>
                  <FormField label={t('baseline.seasonality')}>
                    <Select
                      aria-label={t('baseline.seasonality')}
                      data={[
                        { value: 'daily', label: t('baseline.seasonalityDaily') },
                        { value: 'weekly', label: t('baseline.seasonalityWeekly') },
                        { value: 'trailing', label: t('baseline.seasonalityTrailing') },
                      ]}
                      value={values.baselineSeasonality}
                      allowDeselect={false}
                      onChange={(next) => {
                        if (!next) return;
                        const weekly = next === 'weekly';
                        patch({
                          baselineSeasonality: next as RuleFormValues['baselineSeasonality'],
                          baselinePreset: 'custom',
                          ...(weekly && Number(values.baselineLookbackDays) < 21 ? { baselineLookbackDays: 21 } : {}),
                        });
                      }}
                    />
                  </FormField>
                </FormRow>
                <FormRow cols={2}>
                  <FormField label={t('baseline.minRatio')} hint={t('baseline.minRatioHint')}>
                    <NumberInput
                      aria-label={t('baseline.minRatio')}
                      {...numberField('baselineMinRatio', { min: 1, max: 20, decimals: 2, suffix: '×' })}
                      onChange={(next) => patch({ baselineMinRatio: next, baselinePreset: 'custom' })}
                    />
                  </FormField>
                  <FormField label={t('baseline.minZ')} hint={t('baseline.minZHint')}>
                    <NumberInput
                      aria-label={t('baseline.minZ')}
                      {...numberField('baselineMinZ', { min: 0, max: 20, decimals: 2 })}
                      onChange={(next) => patch({ baselineMinZ: next, baselinePreset: 'custom' })}
                    />
                  </FormField>
                </FormRow>
                <FormRow cols={2}>
                  <FormField label={t('baseline.minDelta')} hint={t('baseline.minDeltaHint')}>
                    <NumberInput
                      aria-label={t('baseline.minDelta')}
                      {...numberField('baselineMinDelta', { min: 0, decimals: 4 })}
                      onChange={(next) => patch({ baselineMinDelta: next, baselinePreset: 'custom' })}
                    />
                  </FormField>
                  <FormField label={t('baseline.lookbackDays')} hint={t('baseline.lookbackDaysHint')}>
                    <NumberInput
                      aria-label={t('baseline.lookbackDays')}
                      {...numberField('baselineLookbackDays', { min: 3, max: 45 })}
                      onChange={(next) => patch({ baselineLookbackDays: next, baselinePreset: 'custom' })}
                    />
                  </FormField>
                </FormRow>
              </>
            ) : null}
          </>
        ) : null}

        {values.mode === 'absence' ? (
          <FormRow cols={2}>
            <FormField label={t('absence.lookbackHours')} hint={t('absence.lookbackHoursHint')}>
              <NumberInput aria-label={t('absence.lookbackHours')} {...numberField('absenceLookbackHours', { min: 1, max: 168 })} />
            </FormField>
            <FormField label={t('absence.minExpected')} hint={t('absence.minExpectedHint')}>
              <NumberInput aria-label={t('absence.minExpected')} {...numberField('absenceMinExpected', { min: 0.001, decimals: 3 })} />
            </FormField>
          </FormRow>
        ) : null}

        {values.mode === 'slo_burn' ? (
          <>
            <FormRow cols={2}>
              <FormField label={t('slo.objective')} hint={t('slo.objectiveHint')}>
                <NumberInput aria-label={t('slo.objective')} {...numberField('sloObjectivePct', { min: 50, max: 99.999, decimals: 3, suffix: '%' })} />
              </FormField>
              <FormField label={t('slo.windowDays')} hint={t('slo.windowDaysHint')}>
                <NumberInput aria-label={t('slo.windowDays')} {...numberField('sloWindowDays', { min: 1, max: 45 })} />
              </FormField>
            </FormRow>
            <FormRow cols={3}>
              <FormField label={t('slo.burnRate')} hint={t('slo.burnRateHint')}>
                <NumberInput aria-label={t('slo.burnRate')} {...numberField('sloBurnRate', { min: 1, max: 100, decimals: 2, suffix: '×' })} />
              </FormField>
              <FormField label={t('slo.longWindow')}>
                <NumberInput aria-label={t('slo.longWindow')} {...numberField('sloLongWindow', { min: 2, suffix: ` ${t('duration.unitMinutes')}` })} />
              </FormField>
              <FormField label={t('slo.shortWindow')}>
                <NumberInput aria-label={t('slo.shortWindow')} {...numberField('sloShortWindow', { min: 1, suffix: ` ${t('duration.unitMinutes')}` })} />
              </FormField>
            </FormRow>
            {values.metric.includes('_p95_') ? (
              <FormRow cols={1}>
                <FormField label={t('slo.latencyThreshold')} hint={t('slo.latencyThresholdHint')}>
                  <Select
                    aria-label={t('slo.latencyThreshold')}
                    data={SLO_LATENCY_BOUNDS_MS.map((bound) => ({ value: String(bound), label: `${bound.toLocaleString(locale)} ms` }))}
                    value={values.sloLatencyThresholdMs}
                    allowDeselect={false}
                    onChange={(next) => next && patch({ sloLatencyThresholdMs: next })}
                  />
                </FormField>
              </FormRow>
            ) : null}
          </>
        ) : null}

        <FormRow cols={3}>
          <FormField label={t('form.window')} required hint={t('form.windowHint')}>
            <Select aria-label={t('form.window')} data={windowOptions} value={values.windowMinutes} allowDeselect={false} onChange={(next) => next && patch({ windowMinutes: next })} />
          </FormField>
          <FormField label={t('form.forMinutes')} hint={t('form.forMinutesHint')}>
            <NumberInput aria-label={t('form.forMinutes')} {...numberField('forMinutes', { min: 0, max: 1440, suffix: ` ${t('duration.unitMinutes')}` })} />
          </FormField>
          <FormField label={t('form.minSamples')} hint={t('form.minSamplesHint')}>
            <NumberInput aria-label={t('form.minSamples')} {...numberField('minSamples', { min: 1, placeholder: t('form.minSamplesDefault') })} />
          </FormField>
        </FormRow>
        {checks.conditionIssue ? (
          <Text size="xs" c="red" role="alert">
            {t(checks.conditionIssue)}
          </Text>
        ) : null}
      </FormSection>

      {/* 4 · severity & notifications */}
      <FormSection number={4} title={t('form.sectionNotify')} description={t('form.sectionNotifyDescription')} done={checks.channels}>
        <FormRow cols={1}>
          <FormField label={t('form.severity')} hint={t('form.severityHint')}>
            <ChipPicker<string>
              options={SEVERITIES.map((severity) => ({ value: severity, label: t(`severity.${severity}`) }))}
              value={values.severity}
              onChange={(next) => patch({ severity: next as AlertRuleSeverity })}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('form.channels')} hint={t('form.channelsHint')}>
            <ChannelsEditor
              value={values.channels}
              onChange={(channels) => patch({ channels })}
              allowedTypes={meta?.channelTypes?.length ? meta.channelTypes : ALL_CHANNEL_TYPES}
              onTest={onTestChannel}
              canTest={canTestChannel}
              maxChannels={Math.max(0, MAX_CHANNELS - values.libraryRefs.length)}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={optional(t('libraryUx.fieldLabel'))} hint={t('libraryUx.fieldHint')}>
            <LibraryChannelPicker
              value={values.libraryRefs}
              onChange={(libraryRefs) => patch({ libraryRefs })}
              library={library.channels}
              loading={library.loading}
              error={library.error}
              canAddMore={values.channels.length + values.libraryRefs.length < MAX_CHANNELS}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <ToggleList>
            <ToggleRow
              label={t('form.notifyOnResolve')}
              description={t('form.notifyOnResolveDescription')}
              checked={values.notifyOnResolve}
              onChange={(next) => patch({ notifyOnResolve: next })}
            />
          </ToggleList>
        </FormRow>
        <FormRow cols={2}>
          <FormField label={t('form.renotify')} hint={t('form.renotifyHint')}>
            <Select
              aria-label={t('form.renotify')}
              data={RENOTIFY_MINUTES.map((minutes) => ({ value: String(minutes), label: minutes === 0 ? t('form.never') : formatMinutes(minutes, t) }))}
              value={values.renotifyMinutes}
              allowDeselect={false}
              onChange={(next) => next && patch({ renotifyMinutes: next })}
            />
          </FormField>
          <FormField label={t('form.cooldown')} hint={t('form.cooldownHint')}>
            <Select
              aria-label={t('form.cooldown')}
              data={COOLDOWN_MINUTES.map((minutes) => ({ value: String(minutes), label: minutes === 0 ? t('form.none') : formatMinutes(minutes, t) }))}
              value={values.cooldownMinutes}
              allowDeselect={false}
              onChange={(next) => next && patch({ cooldownMinutes: next })}
            />
          </FormField>
        </FormRow>
      </FormSection>

      {/* 5 · name, description, enabled */}
      <FormSection number={5} title={t('form.sectionName')} description={t('form.sectionNameDescription')} done={checks.name}>
        <FormRow cols={1}>
          <FormField label={t('form.name')} required>
            <TextInput
              aria-label={t('form.name')}
              placeholder={t('form.namePlaceholder')}
              value={values.name}
              maxLength={120}
              error={values.name.length > 0 && !values.name.trim() ? t('validation.nameRequired') : undefined}
              onChange={(event) => patch({ name: event.currentTarget.value })}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={optional(t('form.description'))}>
            <Textarea
              aria-label={t('form.description')}
              placeholder={t('form.descriptionPlaceholder')}
              autosize
              minRows={2}
              maxRows={4}
              maxLength={1000}
              value={values.description}
              onChange={(event) => patch({ description: event.currentTarget.value })}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={optional(t('rulesUx.runbookUrl'))} hint={t('rulesUx.runbookUrlHint')}>
            <TextInput
              aria-label={t('rulesUx.runbookUrl')}
              placeholder="https://"
              autoComplete="off"
              maxLength={2048}
              value={values.runbookUrl}
              error={runbookValid ? undefined : t('rulesUx.runbookUrlInvalid')}
              onChange={(event) => patch({ runbookUrl: event.currentTarget.value })}
            />
          </FormField>
        </FormRow>
        <ToggleList>
          <ToggleRow
            label={t('form.enabled')}
            description={t('form.enabledDescription')}
            checked={values.enabled}
            onChange={(next) => patch({ enabled: next })}
          />
        </ToggleList>
      </FormSection>
    </FormShell>
  );
}

function PreviewTable({
  targets,
  notes,
  unit,
  locale,
  mode,
}: {
  targets: PreviewTarget[];
  notes: string[];
  unit: string;
  locale: string;
  mode: AlertConditionMode;
}) {
  const t = useTranslations('alerts');
  const showBaseline = mode === 'baseline';
  // An absence rule reports how many requests the entity had, not a metric value.
  const valueUnit = mode === 'absence' ? '' : unit;
  return (
    <div className="ds-col ds-gap-sm" data-testid="rule-preview">
      {targets.length === 0 ? (
        <Text size="xs" c="dimmed">
          {t('preview.empty')}
        </Text>
      ) : (
        <div className="ds-tbl-wrap">
          <table className="ds-tbl">
            <thead>
              <tr>
                <th>{t('preview.entity')}</th>
                <th style={{ textAlign: 'right' }}>{mode === 'absence' ? t('preview.requestsColumn') : t('preview.value')}</th>
                {showBaseline ? <th style={{ textAlign: 'right' }}>{t('preview.baseline')}</th> : null}
                <th>{t('preview.wouldFire')}</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((target) => (
                <tr key={target.entityKey || '__rule__'}>
                  <td className="ds-mono" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {target.entityKey || t('preview.wholeRule')}
                  </td>
                  <td style={{ textAlign: 'right' }}>{target.value === null ? t('preview.noData') : formatMetricValue(target.value, valueUnit, locale)}</td>
                  {showBaseline ? (
                    <td style={{ textAlign: 'right' }}>
                      {target.insufficientData ? t('preview.insufficient') : formatMetricValue(target.baseline ?? null, unit, locale)}
                    </td>
                  ) : null}
                  <td>
                    <span className={`ds-badge ${target.breached ? 'ds-badge-err' : 'ds-badge-ok'}`}>{target.breached ? t('preview.yes') : t('preview.no')}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mode === 'slo_burn' && targets.length > 0 ? (
        <Text size="xs" c="dimmed" data-testid="preview-slo-hint">
          {t('preview.sloHint')}
        </Text>
      ) : null}
      {notes.map((note) => (
        <Text key={note} size="xs" c="dimmed">
          {note}
        </Text>
      ))}
    </div>
  );
}
