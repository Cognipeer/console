'use client';

import { Select, TextInput } from '@mantine/core';
import type { QuotaDomain, QuotaScope } from '@/lib/quota/types';
import { useTranslations } from '@/lib/i18n';
import { PrincipalSelect } from './PrincipalSelect';
import type { PickerOption } from './pickerSources';

interface ScopeIdSelectorProps {
  scope: QuotaScope;
  /** Needed to tell an agent-narrowed limit (resource scope in the agent domain) from any other resource. */
  domain?: QuotaDomain;
  value?: string;
  /** The saved name of `value`, shown until the picker has loaded anything. */
  valueLabel?: string;
  onChange: (value: string | undefined, option?: PickerOption) => void;
  /** The name of the chosen user / group / token / agent, as the picker knows it. */
  onLabelChange?: (label: string | undefined) => void;
  resourceType?: 'model' | 'vectorIndex' | 'provider';
  resourceOptions?: { value: string; label: string }[];
  disabled?: boolean;
}

/**
 * The "who / what does this limit point at" field. Users, groups, API tokens and
 * agents are found by searching (the tenant may have tens of thousands of
 * users), everything else is a plain list or text.
 */
export function ScopeIdSelector({
  scope,
  domain,
  value,
  valueLabel,
  onChange,
  onLabelChange,
  resourceOptions = [],
  disabled = false,
}: ScopeIdSelectorProps) {
  const t = useTranslations('settings.quotaSection.form');

  // The editor wraps this field in its own labelled FormField, so the controls
  // below carry no label or description of their own.

  // Tenant scope doesn't need a selector
  if (scope === 'tenant') {
    return null;
  }

  if (scope === 'user') {
    return (
      <PrincipalSelect
        type="user"
        placeholder={t('selectUser')}
        nothingFoundMessage={t('noUsersFound')}
        value={value}
        valueLabel={valueLabel}
        onChange={onChange}
        onLabelChange={onLabelChange}
        disabled={disabled}
      />
    );
  }

  if (scope === 'group') {
    return (
      <PrincipalSelect
        type="group"
        placeholder={t('selectGroup')}
        nothingFoundMessage={t('noGroupsFound')}
        value={value}
        valueLabel={valueLabel}
        onChange={onChange}
        onLabelChange={onLabelChange}
        disabled={disabled}
      />
    );
  }

  if (scope === 'token') {
    return (
      <PrincipalSelect
        type="token"
        placeholder={t('selectToken')}
        nothingFoundMessage={t('noTokensFound')}
        value={value}
        valueLabel={valueLabel}
        onChange={onChange}
        onLabelChange={onLabelChange}
        disabled={disabled}
      />
    );
  }

  if (scope === 'resource') {
    // In the agent domain a resource limit is a limit on ONE AGENT.
    if (domain === 'agent') {
      return (
        <PrincipalSelect
          type="agent"
          placeholder={t('selectAgent')}
          nothingFoundMessage={t('noAgentsFound')}
          value={value}
          valueLabel={valueLabel}
          onChange={onChange}
          onLabelChange={onLabelChange}
          disabled={disabled}
        />
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
    // Fallback to text input if no options provided
    return (
      <TextInput
        placeholder={t('scopeIdPlaceholder')}
        value={value || ''}
        onChange={(e) => onChange(e.currentTarget.value || undefined)}
        disabled={disabled}
      />
    );
  }

  // Provider scope - text input for provider key
  if (scope === 'provider') {
    return (
      <TextInput
        placeholder={t('scopeIdPlaceholder')}
        value={value || ''}
        onChange={(e) => onChange(e.currentTarget.value || undefined)}
        disabled={disabled}
      />
    );
  }

  return null;
}
