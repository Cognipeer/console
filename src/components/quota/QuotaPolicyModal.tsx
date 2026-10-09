'use client';

import { NumberInput, Select, Switch, Text, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useEffect, useMemo, useState } from 'react';
import { IconBolt, IconGauge } from '@tabler/icons-react';
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
import type { IQuotaPolicy } from '@/lib/database/provider.interface';
import {
  isTenantWideKind,
  type QuotaDomain,
  type QuotaGroupMode,
  type QuotaScope,
  type QuotaLimits,
  type QuotaRateLimit,
} from '@/lib/quota/types';
import { tryTranslate } from '@/components/resources/i18nLookup';
import { useTranslations } from '@/lib/i18n';
import { ScopeIdSelector } from './ScopeIdSelector';

interface QuotaPolicyModalProps {
  opened: boolean;
  onClose: () => void;
  onSubmit: (data: QuotaPolicyFormData) => Promise<void>;
  policy?: IQuotaPolicy | null;
  loading?: boolean;
  defaultDomain?: QuotaDomain;
  allowedDomains?: QuotaDomain[];
  allowedScopes?: QuotaScope[];
  resourceOptions?: { value: string; label: string }[];
  /**
   * The projects a limit can live in. When given, the editor shows a project
   * field (required for the kinds of limit that only apply inside a project,
   * optional — "all projects" — for group and agent-run limits).
   */
  projects?: { value: string; label: string }[];
  /** Starting values for a NEW policy (a duplicate, a deep link). Ignored when editing. */
  seed?: Partial<QuotaPolicyFormData> | null;
  /** Replaces the header when the editor is not tied to one domain. */
  title?: string;
  subtitle?: string;
}

export interface QuotaPolicyFormData {
  scope: QuotaScope;
  scopeId?: string;
  /** Group scope only: count each member separately (default) or the group as one. */
  groupMode?: QuotaGroupMode;
  domain: QuotaDomain;
  priority: number;
  enabled: boolean;
  label?: string;
  description?: string;
  limits: QuotaLimits;
  /** Where the limit lives. On an update, '' moves it to "all projects". */
  projectId?: string;
}

/** The select cannot hold an empty value, so "all projects" is this sentinel. */
const ALL_PROJECTS = '__all__';

const toFormValue = (value?: number | string | null): number | '' => {
  if (value === undefined || value === null || value === '') return '';
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : '';
};

const fromFormValue = (
  value: number | string | '' | null | undefined,
): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

/** The name the Limits table resolved for a saved policy's target, if it came with one. */
const targetLabelOf = (policy: IQuotaPolicy): string | undefined =>
  (policy as { target?: { label?: string } }).target?.label;

const hasAnyValue = (obj?: object | null) =>
  !!obj &&
  Object.values(obj as Record<string, unknown>).some(
    (v) => v !== undefined && v !== null && v !== '',
  );

const RATE_KINDS = ['requests', 'tokens', 'vectors', 'files', 'storage'] as const;

const anyDefined = (o?: object) => !!o && Object.values(o).some((v) => v !== undefined);

export function QuotaPolicyModal({
  opened,
  onClose,
  onSubmit,
  policy,
  loading = false,
  defaultDomain = 'global',
  allowedDomains,
  allowedScopes,
  resourceOptions = [],
  projects,
  seed = null,
  title,
  subtitle,
}: QuotaPolicyModalProps) {
  const isEditing = !!policy;
  // The name behind the chosen target, for the summary (the form itself keeps the id).
  const [targetName, setTargetName] = useState<string | undefined>(undefined);
  const t = useTranslations('settings.quotaSection.form');
  const tScopes = useTranslations('settings.quotaSection.scopes');
  const tDomains = useTranslations('settings.quotaSection.domains');
  const tl = useTranslations('iamLimits.form');

  const emptyLimits: QuotaLimits = {
    rateLimit: { requests: {}, tokens: {} },
    perRequest: {},
    quotas: {},
    budget: {},
  };

  const form = useForm<QuotaPolicyFormData>({
    initialValues: {
      scope: 'tenant',
      scopeId: '',
      groupMode: 'perMember',
      projectId: '',
      domain: defaultDomain,
      priority: 0,
      enabled: true,
      label: '',
      description: '',
      limits: emptyLimits,
    },
  });

  useEffect(() => {
    if (policy) {
      const rl = policy.limits?.rateLimit;
      const normalizedLimits: QuotaLimits = {
        ...policy.limits,
        rateLimit: Object.fromEntries(RATE_KINDS.map((k) => [k, { ...rl?.[k] }] as const)),
        perRequest: { ...policy.limits?.perRequest },
        quotas: { ...policy.limits?.quotas },
        budget: { ...policy.limits?.budget },
      };

      form.setValues({
        scope: policy.scope,
        scopeId: policy.scopeId || '',
        groupMode: policy.groupMode ?? 'perMember',
        projectId: policy.projectId ? String(policy.projectId) : '',
        domain: policy.domain,
        priority: policy.priority || 0,
        enabled: policy.enabled !== false,
        label: policy.label || '',
        description: policy.description || '',
        limits: normalizedLimits,
      });
    } else {
      form.reset();
      form.setFieldValue('domain', defaultDomain);
      form.setFieldValue('limits', emptyLimits);
      if (seed) {
        form.setValues({
          ...seed,
          scopeId: seed.scopeId ?? '',
          projectId: seed.projectId ?? '',
          limits: seed.limits ? { ...emptyLimits, ...structuredClone(seed.limits) } : emptyLimits,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy, opened, defaultDomain, seed]);

  const handleSubmit = async () => {
    const values = form.getValues();

    // Clean up empty values: a group with nothing set is left out entirely.
    const { rateLimit, quotas, perRequest, budget } = values.limits;
    const rates = Object.fromEntries(
      RATE_KINDS.map((k) => [k, rateLimit?.[k]] as const).filter(([, w]) => anyDefined(w)),
    );
    const cleanLimits: QuotaLimits = {
      ...(Object.keys(rates).length > 0 ? { rateLimit: rates } : {}),
      ...(anyDefined(quotas) ? { quotas } : {}),
      ...(anyDefined(perRequest) ? { perRequest } : {}),
      ...(anyDefined(budget) ? { budget } : {}),
    };

    const { projectId, groupMode, ...rest } = values;
    await onSubmit({
      ...rest,
      scopeId: values.scope === 'tenant' ? undefined : values.scopeId || undefined,
      limits: cleanLimits,
      ...(values.scope === 'group' ? { groupMode: groupMode ?? 'perMember' } : {}),
      // A new limit with no project is tenant-wide, which the server takes as
      // "no projectId"; an edit must say '' to move one out of its project.
      ...(projects ? (isEditing ? { projectId: projectId || '' } : projectId ? { projectId } : {}) : {}),
    });
  };

  const scopeOptions = (allowedScopes ||
    (['tenant', 'group', 'user', 'token', 'resource', 'provider'] as QuotaScope[])).map((s) => ({
    value: s,
    label: tScopes(s),
  }));

  const domainOptions = (allowedDomains ||
    (['global', 'llm', 'embedding', 'vector', 'file', 'tracing', 'agent'] as QuotaDomain[])).map((d) => ({
    value: d,
    label: tDomains(d),
  }));

  const showScopeId = form.values.scope !== 'tenant';
  const currentDomain = form.values.domain;
  const currentScope = form.values.scope;
  const values = form.values;
  const limits = values.limits;

  // Agent runs are limited by requests and tokens per person (optionally per
  // agent): none of the model, vector, file, tracing, budget or resource-cap
  // fields apply to them.
  const isAgentDomain = currentDomain === 'agent';
  const showTokens =
    currentDomain === 'global' || currentDomain === 'llm' || currentDomain === 'embedding';
  const showTokenWindows = showTokens || isAgentDomain;
  const showVectors = currentDomain === 'global' || currentDomain === 'vector';
  // Storage limits belong to the file domain, so showFiles also gates them.
  const showFiles = currentDomain === 'global' || currentDomain === 'file';
  const showTracing = currentDomain === 'global' || currentDomain === 'tracing';
  const showCreationQuotas = currentScope === 'tenant' || currentScope === 'user';

  // Where the limit lives. Group and agent-run limits may be tenant-wide; every
  // other kind only exists inside a project (see isTenantWideKind).
  const showProjectField = Boolean(projects);
  const tenantWideKind = isTenantWideKind({ scope: currentScope, domain: currentDomain });
  const projectRequired = showProjectField && !tenantWideKind;
  // An agent-narrowed limit lives in the project of the agent it names.
  const projectFromAgent = isAgentDomain && currentScope === 'resource';
  // What the target is called depends on what it is: a group, a person, an agent...
  const targetKind = projectFromAgent ? 'agent' : currentScope;
  const targetLabel = tryTranslate(tl, `targetLabel.${targetKind}`, 'iamLimits.form') ?? t('scopeId');
  const targetHint = tryTranslate(tl, `targetHint.${targetKind}`, 'iamLimits.form') ?? t('scopeIdDescription');
  const projectLabel = values.projectId
    ? projects?.find((p) => p.value === values.projectId)?.label ?? values.projectId
    : undefined;

  // Validation/checklist signals
  const identityDone = !!values.label && !!values.domain;
  const projectDone = !projectRequired || !!values.projectId;
  const scopeDone =
    !!values.scope && (currentScope === 'tenant' || !!values.scopeId);
  const limitsDone = [
    ...RATE_KINDS.map((k) => limits.rateLimit?.[k]),
    limits.perRequest,
    limits.quotas,
    limits.budget,
  ].some((g) => hasAnyValue(g));

  const checklist = useMemo(
    () => [
      { id: 1, label: 'Label set', done: !!values.label },
      { id: 2, label: 'Domain chosen', done: !!values.domain },
      { id: 3, label: 'Scope target valid', done: scopeDone },
      ...(projectRequired ? [{ id: 6, label: tl('checklistProject'), done: projectDone }] : []),
      { id: 4, label: 'At least one limit configured', done: limitsDone },
      { id: 5, label: 'Active', done: values.enabled },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values.label, values.domain, scopeDone, limitsDone, values.enabled, projectRequired, projectDone],
  );

  const headerTitle = isEditing
    ? t('title.edit')
    : t('title.create', { domain: tDomains(defaultDomain) });

  // Every limit is optional: '' in the input means "not set" and is written back
  // as undefined (never 0), so handleSubmit can drop untouched groups. `scale`
  // shows a stored unit in a friendlier one (bytes → MB, ms → s).
  const limitField = (
    label: string,
    path: string,
    value: number | undefined,
    {
      placeholder = t('placeholder'),
      min = 0,
      decimalScale,
      scale,
    }: { placeholder?: string; min?: number; decimalScale?: number; scale?: number } = {},
  ) => (
    <FormField label={label} optional>
      <NumberInput
        placeholder={placeholder}
        min={min}
        allowDecimal={decimalScale !== undefined}
        decimalScale={decimalScale}
        value={toFormValue(scale ? (value ? value / scale : undefined) : value)}
        onChange={(v) => {
          const n = fromFormValue(v);
          form.setFieldValue(path, scale && n !== undefined ? n * scale : n);
        }}
      />
    </FormField>
  );

  // The per-minute/hour/day/month grid shared by every rate-limit section.
  const rateWindowRows = (kind: keyof QuotaRateLimit) => {
    const cell = (win: 'perMinute' | 'perHour' | 'perDay' | 'perMonth', label: string) =>
      limitField(label, `limits.rateLimit.${kind}.${win}`, limits.rateLimit?.[kind]?.[win]);
    return (
      <>
        <FormRow cols={2}>
          {cell('perMinute', t('rateLimits.perMinute'))}
          {cell('perHour', t('rateLimits.perHour'))}
        </FormRow>
        <FormRow cols={2}>
          {cell('perDay', t('rateLimits.perDay'))}
          {cell('perMonth', t('rateLimits.perMonth'))}
        </FormRow>
      </>
    );
  };

  const planLimit = { placeholder: t('planLimit') };

  const summary = (
    <>
      <SummaryGroup title="Identity">
        <SummaryKV
          label="Label"
          value={values.label || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Description"
          value={values.description || <span className="ds-faint">—</span>}
        />
        <SummaryKV label="Priority" value={values.priority ?? 0} mono />
        <SummaryKV label="Status" value={values.enabled ? 'enabled' : 'disabled'} />
      </SummaryGroup>

      <SummaryGroup title="Scope">
        <SummaryKV label="Domain" value={tDomains(values.domain)} />
        <SummaryKV label="Scope" value={tScopes(values.scope)} />
        {showScopeId ? (
          <SummaryKV
            label="Target"
            value={values.scopeId ? targetName || values.scopeId : <span className="ds-faint">—</span>}
            mono={!targetName}
          />
        ) : null}
        {currentScope === 'group' ? (
          <SummaryKV
            label={tl('summaryCounting')}
            value={values.groupMode === 'shared' ? tl('shared') : tl('perMember')}
          />
        ) : null}
        {showProjectField ? (
          <SummaryKV
            label={tl('project')}
            value={projectLabel ?? tl('projectAll')}
          />
        ) : null}
      </SummaryGroup>

      <SummaryGroup title="Limits">
        <SummaryKV
          label="Request RPM"
          value={toFormValue(limits.rateLimit?.requests?.perMinute) || '—'}
          mono
        />
        <SummaryKV
          label="Request RPH"
          value={toFormValue(limits.rateLimit?.requests?.perHour) || '—'}
          mono
        />
        {showTokenWindows ? (
          <SummaryKV
            label="Token TPM"
            value={toFormValue(limits.rateLimit?.tokens?.perMinute) || '—'}
            mono
          />
        ) : null}
        {showTokens ? (
          <>
            <SummaryKV
              label="Max input"
              value={toFormValue(limits.perRequest?.maxInputTokens) || '—'}
              mono
            />
            <SummaryKV
              label="Max output"
              value={toFormValue(limits.perRequest?.maxOutputTokens) || '—'}
              mono
            />
          </>
        ) : null}
        {showFiles ? (
          <SummaryKV
            label="Max file size (MB)"
            value={
              limits.perRequest?.maxFileSize
                ? Math.round(limits.perRequest.maxFileSize / 1024 / 1024)
                : '—'
            }
            mono
          />
        ) : null}
        {isAgentDomain ? null : (
          <>
            <SummaryKV
              label="Daily $"
              value={toFormValue(limits.budget?.dailySpendLimit) || '—'}
              mono
            />
            <SummaryKV
              label="Monthly $"
              value={toFormValue(limits.budget?.monthlySpendLimit) || '—'}
              mono
            />
          </>
        )}
      </SummaryGroup>

      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const readyCount = checklist.filter((c) => c.done).length;

  // Sections come and go with the domain, so they are numbered as they render.
  let sectionNumber = 0;
  const section = () => (sectionNumber += 1);

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconGauge size={16} />}
      title={title ?? headerTitle}
      subtitle={subtitle ?? 'Configure rate limits, resource quotas, and budgets for this scope.'}
      summary={summary}
      footerStatus={`${readyCount} of ${checklist.length} ready`}
      primaryAction={{
        label: isEditing ? t('actions.update') : t('actions.create'),
        icon: <IconBolt size={13} />,
        loading,
        disabled: !values.label || !values.domain || !scopeDone || !projectDone,
        onClick: handleSubmit,
      }}
      secondaryAction={{
        label: t('actions.cancel'),
        onClick: onClose,
      }}
    >
      <FormSection
        number={section()}
        title="Identity"
        description="How this policy is identified across the console."
        done={identityDone}
      >
        <FormRow cols={1}>
          <FormField label={t('label')} required>
            <TextInput
              placeholder={t('labelPlaceholder')}
              {...form.getInputProps('label')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('description')} optional>
            <Textarea
              placeholder={t('descriptionPlaceholder')}
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField
            label={t('priority')}
            hint={t('priorityDescription')}
          >
            <NumberInput min={0} max={100} {...form.getInputProps('priority')} />
          </FormField>
          <FormField label={t('enabled')} hint={t('enabledDescription')}>
            <Switch
              checked={values.enabled}
              onChange={(e) => form.setFieldValue('enabled', e.currentTarget.checked)}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={section()}
        title="Scope"
        description="Choose which domain this policy targets and to whom it applies."
        done={scopeDone}
      >
        <FormRow cols={1}>
          <FormField
            label={t('domain')}
            required
            hint={values.domain === 'global' ? tl('globalAgentNote') : undefined}
          >
            <Select
              data={domainOptions}
              value={values.domain}
              onChange={(v) => {
                const next = (v as QuotaDomain) || defaultDomain;
                // A resource limit points at an agent in the agent domain and at a model, index
                // or bucket elsewhere: the one chosen for the other kind does not carry over.
                if (values.scope === 'resource' && (values.domain === 'agent') !== (next === 'agent')) {
                  form.setFieldValue('scopeId', '');
                }
                form.setFieldValue('domain', next);
              }}
              disabled={allowedDomains?.length === 1}
              allowDeselect={false}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('scope')} required>
            <ChipPicker<QuotaScope>
              options={scopeOptions}
              value={values.scope}
              onChange={(v) => {
                if (v === values.scope) return;
                // A user id is not a token id: a different kind of target starts empty.
                form.setValues({ scope: v as QuotaScope, scopeId: '', groupMode: 'perMember' });
              }}
            />
          </FormField>
        </FormRow>
        {showScopeId ? (
          <FormRow cols={1}>
            <FormField label={targetLabel} required hint={targetHint}>
              <ScopeIdSelector
                scope={values.scope}
                domain={values.domain}
                value={values.scopeId}
                valueLabel={policy ? targetLabelOf(policy) : undefined}
                onLabelChange={setTargetName}
                onChange={(v, option) => {
                  form.setFieldValue('scopeId', v || '');
                  // An agent lives in one project; the limit follows it there.
                  if (projectFromAgent && option?.projectId) form.setFieldValue('projectId', option.projectId);
                }}
                resourceOptions={resourceOptions}
              />
            </FormField>
          </FormRow>
        ) : null}
        {currentScope === 'group' ? (
          <FormRow cols={1}>
            <FormField label={tl('groupMode')} required hint={values.groupMode === 'shared' ? tl('sharedHint') : tl('perMemberHint')}>
              <ChipPicker<QuotaGroupMode>
                options={[
                  { value: 'perMember', label: tl('perMember') },
                  { value: 'shared', label: tl('shared') },
                ]}
                value={values.groupMode ?? 'perMember'}
                onChange={(v) => form.setFieldValue('groupMode', v as QuotaGroupMode)}
              />
            </FormField>
          </FormRow>
        ) : null}
        {showProjectField ? (
          <FormRow cols={1}>
            <FormField
              label={tl('project')}
              required={projectRequired}
              optional={!projectRequired}
              hint={
                projectFromAgent
                  ? tl('projectFromAgent')
                  : projectRequired
                    ? tl('projectRequiredHint')
                    : tl('projectOptionalHint')
              }
            >
              <Select
                data={[
                  ...(projectRequired || projectFromAgent ? [] : [{ value: ALL_PROJECTS, label: tl('projectAll') }]),
                  ...(projects ?? []),
                ]}
                value={values.projectId || (projectRequired || projectFromAgent ? null : ALL_PROJECTS)}
                onChange={(v) => form.setFieldValue('projectId', !v || v === ALL_PROJECTS ? '' : v)}
                placeholder={tl('projectPlaceholder')}
                disabled={projectFromAgent}
                allowDeselect={false}
                searchable
              />
            </FormField>
          </FormRow>
        ) : null}
        {currentScope === 'group' || currentScope === 'tenant' ? (
          <Text size="xs" c="dimmed">
            {currentScope === 'group' ? tl('ceilingHint') : tl('tenantCeilingNote')}
          </Text>
        ) : null}
      </FormSection>

      <FormSection
        number={section()}
        title="Request rate limits"
        description={isAgentDomain ? tl('agentRequestsDescription') : 'Cap how many requests can be made within rolling windows.'}
      >
        {rateWindowRows('requests')}
        {isAgentDomain ? null : (
          <FormRow cols={1}>
            {limitField(
              t('perRequest.maxConcurrentRequests'),
              'limits.perRequest.maxConcurrentRequests',
              limits.perRequest?.maxConcurrentRequests,
            )}
          </FormRow>
        )}
      </FormSection>

      {showTokenWindows ? (
        <FormSection
          number={section()}
          title={t('rateLimits.tokens')}
          description={isAgentDomain ? tl('agentTokensDescription') : 'Throttle token throughput for LLM and embedding workloads.'}
        >
          {rateWindowRows('tokens')}
          {showTokens ? (
            <>
              <FormRow cols={2}>
                {limitField(
                  t('perRequest.maxInputTokens'),
                  'limits.perRequest.maxInputTokens',
                  limits.perRequest?.maxInputTokens,
                )}
                {limitField(
                  t('perRequest.maxOutputTokens'),
                  'limits.perRequest.maxOutputTokens',
                  limits.perRequest?.maxOutputTokens,
                )}
              </FormRow>
              <FormRow cols={1}>
                {limitField(
                  t('perRequest.maxTotalTokens'),
                  'limits.perRequest.maxTotalTokens',
                  limits.perRequest?.maxTotalTokens,
                )}
              </FormRow>
            </>
          ) : null}
        </FormSection>
      ) : null}

      {showVectors ? (
        <FormSection
          number={section()}
          title={t('rateLimits.vectors')}
          description="Upsert and query throughput for vector indexes."
        >
          {rateWindowRows('vectors')}
          <FormRow cols={2}>
            {limitField(
              t('perRequest.maxVectorsPerUpsert'),
              'limits.perRequest.maxVectorsPerUpsert',
              limits.perRequest?.maxVectorsPerUpsert,
            )}
            {limitField(
              t('perRequest.maxQueryResults'),
              'limits.perRequest.maxQueryResults',
              limits.perRequest?.maxQueryResults,
            )}
          </FormRow>
        </FormSection>
      ) : null}

      {showFiles ? (
        <FormSection
          number={section()}
          title={t('rateLimits.files')}
          description="Per-request and rate limits for file operations."
        >
          {rateWindowRows('files')}
          <FormRow cols={2}>
            {limitField(
              t('perRequest.maxFileSizeMB'),
              'limits.perRequest.maxFileSize',
              limits.perRequest?.maxFileSize,
              { scale: 1024 * 1024 },
            )}
            {limitField(
              t('perRequest.maxFilesPerRequest'),
              'limits.perRequest.maxFilesPerRequest',
              limits.perRequest?.maxFilesPerRequest,
            )}
          </FormRow>
        </FormSection>
      ) : null}

      {showFiles ? (
        <FormSection
          number={section()}
          title={t('rateLimits.storage')}
          description="Throttle storage I/O measured in bytes."
        >
          {rateWindowRows('storage')}
        </FormSection>
      ) : null}

      {showTracing ? (
        <FormSection
          number={section()}
          title={t('perRequest.tracing')}
          description="Limits for observability session size and duration."
        >
          <FormRow cols={2}>
            {limitField(
              t('perRequest.maxEventsPerSession'),
              'limits.perRequest.maxEventsPerSession',
              limits.perRequest?.maxEventsPerSession,
            )}
            {limitField(
              t('perRequest.maxSessionDurationSec'),
              'limits.perRequest.maxSessionDurationMs',
              limits.perRequest?.maxSessionDurationMs,
              { scale: 1000 },
            )}
          </FormRow>
        </FormSection>
      ) : null}

      {isAgentDomain ? null : (
        <FormSection
          number={section()}
          title="Resource quotas"
          description={t('quotas.description')}
        >
          {showCreationQuotas ? (
            <>
              <FormRow cols={2}>
                {showTokens ? (
                  limitField(
                    t('quotas.maxModels'),
                    'limits.quotas.maxModels',
                    limits.quotas?.maxModels,
                    planLimit,
                  )
                ) : (
                  <div />
                )}
                {showVectors ? (
                  limitField(
                    t('quotas.maxVectorIndexes'),
                    'limits.quotas.maxVectorIndexes',
                    limits.quotas?.maxVectorIndexes,
                    planLimit,
                  )
                ) : (
                  <div />
                )}
              </FormRow>
              <FormRow cols={2}>
                {showFiles ? (
                  limitField(
                    t('quotas.maxFileBuckets'),
                    'limits.quotas.maxFileBuckets',
                    limits.quotas?.maxFileBuckets,
                    planLimit,
                  )
                ) : (
                  <div />
                )}
                {showTracing ? (
                  limitField(
                    t('quotas.maxTracingSessions'),
                    'limits.quotas.maxTracingSessions',
                    limits.quotas?.maxTracingSessions,
                    planLimit,
                  )
                ) : (
                  <div />
                )}
              </FormRow>
              {currentDomain === 'global' && currentScope === 'tenant' ? (
                <FormRow cols={2}>
                  {limitField(
                    t('quotas.maxApiTokens'),
                    'limits.quotas.maxApiTokens',
                    limits.quotas?.maxApiTokens,
                    planLimit,
                  )}
                  {limitField(
                    t('quotas.maxUsers'),
                    'limits.quotas.maxUsers',
                    limits.quotas?.maxUsers,
                    planLimit,
                  )}
                </FormRow>
              ) : null}
              {currentDomain === 'global' ? (
                <FormRow cols={3}>
                  {limitField(
                    t('quotas.maxAgentSyncTimeoutSeconds'),
                    'limits.quotas.maxAgentSyncTimeoutSeconds',
                    limits.quotas?.maxAgentSyncTimeoutSeconds,
                    { ...planLimit, min: 5 },
                  )}
                  {limitField(
                    t('quotas.maxAgentBackgroundDurationMinutes'),
                    'limits.quotas.maxAgentBackgroundDurationMinutes',
                    limits.quotas?.maxAgentBackgroundDurationMinutes,
                    { ...planLimit, min: 1 },
                  )}
                  {limitField(
                    t('quotas.maxConcurrentAgentRuns'),
                    'limits.quotas.maxConcurrentAgentRuns',
                    limits.quotas?.maxConcurrentAgentRuns,
                    planLimit,
                  )}
                </FormRow>
              ) : null}
            </>
          ) : null}

          <FormRow cols={2}>
            {showVectors ? (
              limitField(
                t('quotas.maxVectorsTotal'),
                'limits.quotas.maxVectorsTotal',
                limits.quotas?.maxVectorsTotal,
              )
            ) : (
              <div />
            )}
            {showFiles ? (
              limitField(
                t('quotas.maxStorageMB'),
                'limits.quotas.maxStorageBytes',
                limits.quotas?.maxStorageBytes,
                { scale: 1024 * 1024 },
              )
            ) : (
              <div />
            )}
          </FormRow>
        </FormSection>
      )}

      {isAgentDomain ? null : (
        <FormSection
          number={section()}
          title={t('tabs.budget')}
          description={t('budget.description')}
        >
          <FormRow cols={2}>
            {limitField(
              t('budget.dailyLimit'),
              'limits.budget.dailySpendLimit',
              limits.budget?.dailySpendLimit,
              { decimalScale: 2 },
            )}
            {limitField(
              t('budget.monthlyLimit'),
              'limits.budget.monthlySpendLimit',
              limits.budget?.monthlySpendLimit,
              { decimalScale: 2 },
            )}
          </FormRow>
        </FormSection>
      )}

      <FormSection
        number={section()}
        title="Activation"
        description="Make the policy active or staged for later enablement."
        done={values.enabled}
      >
        <ToggleList>
          <ToggleRow
            label={t('enabled')}
            description={t('enabledDescription')}
            checked={values.enabled}
            onChange={(v) => form.setFieldValue('enabled', v)}
          />
        </ToggleList>
      </FormSection>
    </FormShell>
  );
}
