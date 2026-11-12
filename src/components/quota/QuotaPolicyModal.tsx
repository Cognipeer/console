'use client';

import { Alert, NumberInput, Select, Switch, Text, TextInput, Textarea } from '@mantine/core';
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
  type QuotaIpMode,
  type QuotaScope,
  type QuotaLimits,
  type QuotaRateLimit,
} from '@/lib/quota/types';
import { ENFORCED_QUOTA_DOMAINS, QUOTA_DOMAIN_GROUP_ORDER, quotaDomainSpec } from '@/lib/quota/domains';
import { isSameTargetKind, quotaTargetSource } from '@/lib/quota/targets';
import CidrInput from '@/components/iam/pickers/CidrInput';
import { tryTranslate } from '@/components/resources/i18nLookup';
import { useLocale, useTranslations } from '@/lib/i18n';
import { useQuotaDefaults } from '@/lib/api/queries/quota';
import { ScopeIdSelector } from './ScopeIdSelector';
import { SearchableSelect } from './SearchableSelect';

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
  /** IP scope only: the CIDR ranges the caller's address is matched against. */
  ipRanges?: string[];
  /** IP scope only: one counter per address (default) or one for all the ranges. */
  ipMode?: QuotaIpMode;
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

/** The Limits table found the saved person / group / token / agent gone. */
const targetMissingOf = (policy: IQuotaPolicy): boolean =>
  (policy as { target?: { missing?: boolean } }).target?.missing === true;

const hasAnyValue = (obj?: object | null) =>
  !!obj &&
  Object.values(obj as Record<string, unknown>).some(
    (v) => v !== undefined && v !== null && v !== '',
  );

const RATE_KINDS = ['requests', 'tokens', 'vectors', 'files', 'storage', 'units'] as const;

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
  // The project was set by picking a model / index / bucket / provider that lives in exactly one.
  const [projectFromPick, setProjectFromPick] = useState(false);
  const t = useTranslations('settings.quotaSection.form');
  const tScopes = useTranslations('settings.quotaSection.scopes');
  const tDomains = useTranslations('settings.quotaSection.domains');
  const tl = useTranslations('iamLimits.form');
  const te = useTranslations('iamLimits.form.editor');
  const locale = useLocale();

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
      ipRanges: [],
      ipMode: 'perAddress',
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
    setProjectFromPick(false);
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
        ipRanges: Array.isArray(policy.ipRanges) ? [...policy.ipRanges] : [],
        ipMode: policy.ipMode === 'shared' ? 'shared' : 'perAddress',
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
          ipRanges: seed.ipRanges ?? [],
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
    // An IP limit carries rate limits only (the server refuses anything else).
    const rateOnly = values.scope === 'ip';
    const cleanLimits: QuotaLimits = {
      ...(Object.keys(rates).length > 0 ? { rateLimit: rates } : {}),
      ...(!rateOnly && anyDefined(quotas) ? { quotas } : {}),
      ...(!rateOnly && anyDefined(perRequest) ? { perRequest } : {}),
      ...(!rateOnly && anyDefined(budget) ? { budget } : {}),
    };

    const { projectId, groupMode, ipRanges, ipMode, ...rest } = values;
    await onSubmit({
      ...rest,
      scopeId: values.scope === 'tenant' || values.scope === 'ip' ? undefined : values.scopeId || undefined,
      limits: cleanLimits,
      ...(values.scope === 'group' ? { groupMode: groupMode ?? 'perMember' } : {}),
      ...(values.scope === 'ip' ? { ipRanges: ipRanges ?? [], ipMode: ipMode ?? 'perAddress' } : {}),
      // A new limit with no project is tenant-wide, which the server takes as
      // "no projectId"; an edit must say '' to move one out of its project.
      ...(projects ? (isEditing ? { projectId: projectId || '' } : projectId ? { projectId } : {}) : {}),
    });
  };

  const scopeOptions = (allowedScopes ||
    (['tenant', 'group', 'user', 'token', 'resource', 'provider', 'ip'] as QuotaScope[])).map((s) => ({
    value: s,
    label: tScopes(s),
  }));

  // What this install guards (the core's services plus what the enterprise
  // overlay registered), from GET /api/quota/defaults; the core's list until it answers.
  const defaultsQuery = useQuotaDefaults(opened);
  const defaultsBody = defaultsQuery.data;
  const served = useMemo<{ domains?: QuotaDomain[]; jobKinds?: string[] }>(
    () =>
      defaultsBody
        ? {
            domains: Array.isArray(defaultsBody.domains) ? (defaultsBody.domains as QuotaDomain[]) : undefined,
            jobKinds: Array.isArray(defaultsBody.jobKinds) ? (defaultsBody.jobKinds as string[]) : undefined,
          }
        : {},
    [defaultsBody],
  );
  // Services grouped as the registry groups them; only those with a guarded call site
  // (and the one an existing limit already names, so it still shows).
  const baseDomains = allowedDomains || served.domains || [...ENFORCED_QUOTA_DOMAINS];
  const offeredDomains = baseDomains.includes(form.values.domain) || allowedDomains
    ? baseDomains
    : [...baseDomains, form.values.domain];
  const domainOptions = QUOTA_DOMAIN_GROUP_ORDER
    .map((group) => ({
      group: tl(`domainGroups.${group}`),
      items: offeredDomains
        .filter((d) => quotaDomainSpec(d).group === group)
        .map((d) => ({ value: d, label: tDomains(d) })),
    }))
    .filter((group) => group.items.length > 0);

  const showScopeId = form.values.scope !== 'tenant' && form.values.scope !== 'ip';
  const currentDomain = form.values.domain;
  const currentScope = form.values.scope;
  const values = form.values;
  const limits = values.limits;

  // Which sections apply is the service's registry entry (domains.ts). An IP
  // limit counts the address, so it only ever has rate-limit windows.
  const spec = quotaDomainSpec(currentDomain);
  const isIpScope = currentScope === 'ip';
  const isAgentDomain = currentDomain === 'agent';
  const showTokens = spec.perRequest.includes('maxInputTokens') && !isIpScope;
  const showTokenWindows = spec.rateKinds.includes('tokens');
  const showVectors = spec.rateKinds.includes('vectors');
  const showFiles = spec.rateKinds.includes('files');
  const showStorage = spec.rateKinds.includes('storage');
  const showUnits = spec.rateKinds.includes('units') && !!spec.unit;
  const showTracing = spec.perRequest.includes('maxEventsPerSession') && !isIpScope;
  const showConcurrency = spec.perRequest.includes('maxConcurrentRequests') && !isIpScope;
  const showResourceCaps = spec.resourceCaps && !isIpScope;
  const showBudget = spec.budget && !isIpScope;
  const showCreationQuotas = currentScope === 'tenant' || currentScope === 'user';

  // Behind a reverse proxy with no TRUSTED_PROXIES every caller has the proxy's address: say so on an IP limit.
  const [trustedProxiesUnset, setTrustedProxiesUnset] = useState(false);
  useEffect(() => {
    if (!defaultsBody) return;
    setTrustedProxiesUnset(defaultsBody.ipScope?.trustedProxiesUnset === true);
  }, [defaultsBody]);

  // Where the limit lives. Group and agent-run limits may be tenant-wide; every
  // other kind only exists inside a project (see isTenantWideKind).
  const showProjectField = Boolean(projects);
  const tenantWideKind = isTenantWideKind({ scope: currentScope, domain: currentDomain });
  const projectRequired = showProjectField && !tenantWideKind;
  // An agent-narrowed limit lives in the project of the agent it names.
  const projectFromAgent = isAgentDomain && currentScope === 'resource';
  // The target an existing limit was saved with is gone (and still the one in the field).
  const savedTargetGone = policy ? targetMissingOf(policy) && values.scopeId === (policy.scopeId ?? '') : false;
  // What the target is called depends on what it is: a group, a person, an agent, a model, a vector index...
  const targetSource = quotaTargetSource(currentDomain, currentScope);
  const targetKind = projectFromAgent ? 'agent' : currentScope === 'resource' && targetSource ? targetSource.noun : currentScope;
  const targetLabel = tryTranslate(tl, `targetLabel.${targetKind}`, 'iamLimits.form') ?? t('scopeId');
  const targetHint = tryTranslate(tl, `targetHint.${targetKind}`, 'iamLimits.form') ?? t('scopeIdDescription');
  const projectLabel = values.projectId
    ? projects?.find((p) => p.value === values.projectId)?.label ?? values.projectId
    : undefined;

  // Validation/checklist signals
  const identityDone = !!values.label && !!values.domain;
  const projectDone = !projectRequired || !!values.projectId;
  const scopeDone =
    !!values.scope
    && (currentScope === 'tenant'
      || (currentScope === 'ip' ? (values.ipRanges?.length ?? 0) > 0 : !!values.scopeId));
  const limitsDone = [
    ...RATE_KINDS.map((k) => limits.rateLimit?.[k]),
    limits.perRequest,
    limits.quotas,
    limits.budget,
  ].some((g) => hasAnyValue(g));

  const checklist = useMemo(
    () => [
      { id: 1, label: te('checklist.label'), done: !!values.label },
      { id: 2, label: te('checklist.domain'), done: !!values.domain },
      { id: 3, label: te('checklist.target'), done: scopeDone },
      ...(projectRequired ? [{ id: 6, label: tl('checklistProject'), done: projectDone }] : []),
      { id: 4, label: te('checklist.limits'), done: limitsDone },
      { id: 5, label: te('checklist.active'), done: values.enabled },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values.label, values.domain, scopeDone, limitsDone, values.enabled, projectRequired, projectDone, locale],
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

  // `lang`: the page's own is "en", and the upper-cased labels would lose their Turkish dots ("ÖNCELIK", not "ÖNCELİK").
  // `display: contents` keeps the wrapper out of the layout.
  const langScope = { lang: locale, style: { display: 'contents' } as const };

  const summary = (
    <div {...langScope}>
      <SummaryGroup title={te('summary.identity')}>
        <SummaryKV
          label={te('summary.label')}
          value={values.label || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label={te('summary.description')}
          value={values.description || <span className="ds-faint">—</span>}
        />
        <SummaryKV label={te('summary.priority')} value={values.priority ?? 0} mono />
        <SummaryKV label={te('summary.status')} value={values.enabled ? te('summary.enabled') : te('summary.disabled')} />
      </SummaryGroup>

      <SummaryGroup title={te('summary.scopeGroup')}>
        <SummaryKV label={te('summary.domain')} value={tDomains(values.domain)} />
        <SummaryKV label={te('summary.scope')} value={tScopes(values.scope)} />
        {showScopeId ? (
          <SummaryKV
            label={te('summary.target')}
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
        {isIpScope ? (
          <>
            <SummaryKV
              label={tl('ip.rangesLabel')}
              value={(values.ipRanges?.length ?? 0) > 0 ? values.ipRanges!.join(', ') : <span className="ds-faint">—</span>}
              mono
            />
            <SummaryKV
              label={tl('summaryCounting')}
              value={values.ipMode === 'shared' ? tl('ip.shared') : tl('ip.perAddress')}
            />
          </>
        ) : null}
        {showProjectField ? (
          <SummaryKV
            label={tl('project')}
            value={projectLabel ?? tl('projectAll')}
          />
        ) : null}
      </SummaryGroup>

      <SummaryGroup title={te('summary.limits')}>
        <SummaryKV
          label={te('summary.requestsPerMinute')}
          value={toFormValue(limits.rateLimit?.requests?.perMinute) || '—'}
          mono
        />
        <SummaryKV
          label={te('summary.requestsPerHour')}
          value={toFormValue(limits.rateLimit?.requests?.perHour) || '—'}
          mono
        />
        {showTokenWindows ? (
          <SummaryKV
            label={te('summary.tokensPerMinute')}
            value={toFormValue(limits.rateLimit?.tokens?.perMinute) || '—'}
            mono
          />
        ) : null}
        {showTokens ? (
          <>
            <SummaryKV
              label={te('summary.maxInput')}
              value={toFormValue(limits.perRequest?.maxInputTokens) || '—'}
              mono
            />
            <SummaryKV
              label={te('summary.maxOutput')}
              value={toFormValue(limits.perRequest?.maxOutputTokens) || '—'}
              mono
            />
          </>
        ) : null}
        {showFiles && !isIpScope ? (
          <SummaryKV
            label={te('summary.maxFileSize')}
            value={
              limits.perRequest?.maxFileSize
                ? Math.round(limits.perRequest.maxFileSize / 1024 / 1024)
                : '—'
            }
            mono
          />
        ) : null}
        {showBudget ? (
          <>
            <SummaryKV
              label={te('summary.dailySpend')}
              value={toFormValue(limits.budget?.dailySpendLimit) || '—'}
              mono
            />
            <SummaryKV
              label={te('summary.monthlySpend')}
              value={toFormValue(limits.budget?.monthlySpendLimit) || '—'}
              mono
            />
          </>
        ) : null}
      </SummaryGroup>

      <SummaryGroup title={te('summary.preflight')}>
        <Checklist items={checklist} />
      </SummaryGroup>
    </div>
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
      subtitle={subtitle ?? te('subtitle')}
      summary={summary}
      footerStatus={te('ready', { done: readyCount, total: checklist.length })}
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
      <div {...langScope}>
        <FormSection
          number={section()}
          title={te('sections.identityTitle')}
          description={te('sections.identityDescription')}
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
          title={te('sections.scopeTitle')}
          description={te('sections.scopeDescription')}
          done={scopeDone}
        >
          <FormRow cols={1}>
            <FormField
              label={t('domain')}
              required
              hint={
                values.domain === 'global'
                  ? tl('globalAgentNote')
                  : !spec.globalFallback && !isAgentDomain
                    ? tl('noGlobalFallbackNote')
                    : undefined
              }
            >
              <Select
                data={domainOptions}
                value={values.domain}
                onChange={(v) => {
                  const next = (v as QuotaDomain) || defaultDomain;
                  // A resource limit points at an agent in the agent domain, at a model in the model
                  // domains, at an index for vector...: a target chosen for another kind of value does
                  // not carry over (a model key is not an index key, an embedding model is not a chat one).
                  if (!isSameTargetKind(values.scope, values.domain, next)) {
                    form.setFieldValue('scopeId', '');
                    setProjectFromPick(false);
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
                  setProjectFromPick(false);
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
                  jobKinds={served.jobKinds}
                  value={values.scopeId}
                  valueLabel={policy ? targetLabelOf(policy) : undefined}
                  valueMissing={savedTargetGone}
                  projectId={values.projectId || undefined}
                  onLabelChange={setTargetName}
                  onChange={(v, option) => {
                    form.setFieldValue('scopeId', v || '');
                    // An agent, a model, an index or a bucket lives in one project (a provider in one or
                    // several); a limit on it only ever applies there, so the limit follows it.
                    const follows = Boolean(option?.projectId)
                      && (projectFromAgent || currentScope === 'resource' || currentScope === 'provider');
                    if (follows && option?.projectId) form.setFieldValue('projectId', option.projectId);
                    setProjectFromPick(follows && !projectFromAgent);
                  }}
                  resourceOptions={resourceOptions}
                />
              </FormField>
            </FormRow>
          ) : null}
          {isIpScope ? (
            <>
              <FormRow cols={1}>
                <FormField label={tl('ip.rangesLabel')} required hint={tl('ip.rangesHint')}>
                  <CidrInput
                    value={values.ipRanges ?? []}
                    onChange={(next) => form.setFieldValue('ipRanges', next)}
                  />
                </FormField>
              </FormRow>
              <FormRow cols={1}>
                <FormField
                  label={tl('summaryCounting')}
                  required
                  hint={values.ipMode === 'shared' ? tl('ip.sharedHint') : tl('ip.perAddressHint')}
                >
                  <ChipPicker<QuotaIpMode>
                    options={[
                      { value: 'perAddress', label: tl('ip.perAddress') },
                      { value: 'shared', label: tl('ip.shared') },
                    ]}
                    value={values.ipMode ?? 'perAddress'}
                    onChange={(v) => form.setFieldValue('ipMode', v as QuotaIpMode)}
                  />
                </FormField>
              </FormRow>
              {trustedProxiesUnset ? (
                <Alert color="yellow" variant="light" title={tl('ip.proxyWarningTitle')}>
                  {tl('ip.proxyWarning')}
                </Alert>
              ) : null}
              <Text size="xs" c="dimmed">
                {tl('ip.rateOnlyNote')}
              </Text>
            </>
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
                    : projectFromPick
                      ? tl('projectFromTarget')
                      : projectRequired
                        ? tl('projectRequiredHint')
                        : tl('projectOptionalHint')
                }
              >
                <SearchableSelect
                  data={[
                    ...(projectRequired || projectFromAgent ? [] : [{ value: ALL_PROJECTS, label: tl('projectAll') }]),
                    ...(projects ?? []),
                  ]}
                  value={values.projectId || (projectRequired || projectFromAgent ? null : ALL_PROJECTS)}
                  onChange={(v) => form.setFieldValue('projectId', !v || v === ALL_PROJECTS ? '' : v)}
                  placeholder={tl('projectPlaceholder')}
                  disabled={projectFromAgent || projectFromPick}
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
          title={te('sections.requestsTitle')}
          description={isAgentDomain ? tl('agentRequestsDescription') : te('sections.requestsDescription')}
        >
          {rateWindowRows('requests')}
          {showConcurrency ? (
            <FormRow cols={1}>
              {limitField(
                t('perRequest.maxConcurrentRequests'),
                'limits.perRequest.maxConcurrentRequests',
                limits.perRequest?.maxConcurrentRequests,
              )}
            </FormRow>
          ) : null}
        </FormSection>

        {showTokenWindows ? (
          <FormSection
            number={section()}
            title={t('rateLimits.tokens')}
            description={isAgentDomain ? tl('agentTokensDescription') : te('sections.tokensDescription')}
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
            description={te('sections.vectorsDescription')}
          >
            {rateWindowRows('vectors')}
            {isIpScope ? null : <FormRow cols={2}>
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
            </FormRow>}
          </FormSection>
        ) : null}

        {showFiles ? (
          <FormSection
            number={section()}
            title={t('rateLimits.files')}
            description={te('sections.filesDescription')}
          >
            {rateWindowRows('files')}
            {isIpScope ? null : <FormRow cols={2}>
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
            </FormRow>}
          </FormSection>
        ) : null}

        {showStorage ? (
          <FormSection
            number={section()}
            title={t('rateLimits.storage')}
            description={te('sections.storageDescription')}
          >
            {rateWindowRows('storage')}
          </FormSection>
        ) : null}

        {showUnits ? (
          <FormSection
            number={section()}
            title={tl(`units.${spec.unit}.title`)}
            description={tl(`units.${spec.unit}.description`)}
          >
            {rateWindowRows('units')}
          </FormSection>
        ) : null}

        {showTracing ? (
          <FormSection
            number={section()}
            title={t('perRequest.tracing')}
            description={te('sections.tracingDescription')}
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

        {showResourceCaps ? (
          <FormSection
            number={section()}
            title={te('sections.quotasTitle')}
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
                {currentDomain === 'global' ? (
                  <FormRow cols={3}>
                    {limitField(
                      t('quotas.maxActiveAgentReminders'),
                      'limits.quotas.maxActiveAgentReminders',
                      limits.quotas?.maxActiveAgentReminders,
                      planLimit,
                    )}
                    {limitField(
                      t('quotas.maxAgentRemindersPerDay'),
                      'limits.quotas.maxAgentRemindersPerDay',
                      limits.quotas?.maxAgentRemindersPerDay,
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
        ) : null}

        {showBudget ? (
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
        ) : null}

        <FormSection
          number={section()}
          title={te('sections.activationTitle')}
          description={te('sections.activationDescription')}
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
      </div>
    </FormShell>
  );
}
