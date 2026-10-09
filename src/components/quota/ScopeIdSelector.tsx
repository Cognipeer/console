'use client';

import { useMemo, type ReactNode } from 'react';
import { Select, Stack, Text } from '@mantine/core';
import type { QuotaDomain, QuotaScope } from '@/lib/quota/types';
import { quotaTargetSource } from '@/lib/quota/targets';
import { useTranslations } from '@/lib/i18n';
import { PrincipalSelect } from './PrincipalSelect';
import { TargetSelect } from './TargetSelect';
import type { PickerOption } from './pickerSources';

interface ScopeIdSelectorProps {
  scope: QuotaScope;
  /**
   * Which service the limit is for: it decides what a `resource` or `provider`
   * target is (an agent in the agent domain, a model in the model domains, an
   * index for vector...) — see `quotaTargetSource`.
   */
  domain?: QuotaDomain;
  value?: string;
  /** The saved name of `value`, shown until the picker has loaded anything. */
  valueLabel?: string;
  /** The limit's project: tells apart rows that store the same value in different projects. */
  projectId?: string;
  /**
   * The saved person / group / token / agent is known to be gone (the Limits
   * table flags it): the id stays, with a note, until another is chosen. A
   * resource or provider is looked up by its own picker instead.
   */
  valueMissing?: boolean;
  onChange: (value: string | undefined, option?: PickerOption) => void;
  /** The name of the chosen user / group / token / agent / resource, as the picker knows it. */
  onLabelChange?: (label: string | undefined) => void;
  resourceType?: 'model' | 'vectorIndex' | 'provider';
  /** A fixed list of resources for callers that have one; without it the registry is searched. */
  resourceOptions?: { value: string; label: string }[];
  disabled?: boolean;
}

/**
 * The "who / what does this limit point at" field. Everything that can be long
 * is found by searching as you type (the tenant may have tens of thousands of
 * users, hundreds of models): users, groups, API tokens, agents, and the
 * resource or provider of a resource / provider limit.
 */
export function ScopeIdSelector({
  scope,
  domain,
  value,
  valueLabel,
  projectId,
  valueMissing = false,
  onChange,
  onLabelChange,
  resourceOptions = [],
  disabled = false,
}: ScopeIdSelectorProps) {
  const t = useTranslations('settings.quotaSection.form');
  const tTarget = useTranslations('settings.quotaSection.target');
  const tDomains = useTranslations('settings.quotaSection.domains');
  // One object per (service, kind of target): the picker below is keyed by its id.
  const source = useMemo(() => quotaTargetSource(domain ?? 'global', scope), [domain, scope]);

  // The editor wraps this field in its own labelled FormField, so the controls
  // below carry no label or description of their own.

  /** A picker of people / groups / tokens / agents, with the note for a saved one that is gone. */
  const withGoneNote = (kind: 'user' | 'group' | 'token' | 'agent', picker: ReactNode) => (
    <Stack gap={4}>
      {picker}
      {valueMissing && value ? (
        <Text size="xs" c="orange" role="status">
          {tTarget(`gone.${kind}`)}
        </Text>
      ) : null}
    </Stack>
  );

  // Tenant scope doesn't need a selector
  if (scope === 'tenant') {
    return null;
  }

  if (scope === 'user') {
    return withGoneNote(
      'user',
      <PrincipalSelect
        type="user"
        placeholder={t('selectUser')}
        nothingFoundMessage={t('noUsersFound')}
        value={value}
        valueLabel={valueLabel}
        onChange={onChange}
        onLabelChange={onLabelChange}
        disabled={disabled}
      />,
    );
  }

  if (scope === 'group') {
    return withGoneNote(
      'group',
      <PrincipalSelect
        type="group"
        placeholder={t('selectGroup')}
        nothingFoundMessage={t('noGroupsFound')}
        value={value}
        valueLabel={valueLabel}
        onChange={onChange}
        onLabelChange={onLabelChange}
        disabled={disabled}
      />,
    );
  }

  if (scope === 'token') {
    return withGoneNote(
      'token',
      <PrincipalSelect
        type="token"
        placeholder={t('selectToken')}
        nothingFoundMessage={t('noTokensFound')}
        value={value}
        valueLabel={valueLabel}
        onChange={onChange}
        onLabelChange={onLabelChange}
        disabled={disabled}
      />,
    );
  }

  if (scope === 'resource') {
    // In the agent domain a resource limit is a limit on ONE AGENT.
    if (domain === 'agent') {
      return withGoneNote(
        'agent',
        <PrincipalSelect
          type="agent"
          placeholder={t('selectAgent')}
          nothingFoundMessage={t('noAgentsFound')}
          value={value}
          valueLabel={valueLabel}
          onChange={onChange}
          onLabelChange={onLabelChange}
          disabled={disabled}
        />,
      );
    }
    if (resourceOptions.length > 0) {
      return (
        <Select
          placeholder={t('selectResource')}
          data={resourceOptions}
          value={value || null}
          onChange={(v) => onChange(v || undefined)}
          searchable
          clearable
          disabled={disabled}
          nothingFoundMessage={t('noResourcesFound')}
        />
      );
    }
    return source ? (
      <TargetSelect
        key={source.id}
        source={source}
        value={value}
        projectId={projectId}
        onChange={onChange}
        onLabelChange={onLabelChange}
        disabled={disabled}
      />
    ) : null;
  }

  // A provider limit is matched on the provider's key, which only vector and file calls report.
  if (scope === 'provider' && source) {
    return (
      <Stack gap="xs">
        <TargetSelect
          key={source.id}
          source={source}
          value={value}
          projectId={projectId}
          onChange={onChange}
          onLabelChange={onLabelChange}
          disabled={disabled}
        />
        {source.neverApplies ? (
          <Text size="xs" c="orange" role="status">
            {tTarget('providerNeverApplies', { domain: tDomains(domain ?? 'global') })}
          </Text>
        ) : null}
      </Stack>
    );
  }

  return null;
}
