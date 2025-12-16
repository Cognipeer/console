'use client';

import { useEffect, useState, useMemo } from 'react';
import { Select, TextInput, Loader } from '@mantine/core';
import type { QuotaScope } from '@/lib/quota/types';
import { useTranslations } from '@/lib/i18n';

interface ScopeIdSelectorProps {
  scope: QuotaScope;
  value?: string;
  onChange: (value: string | undefined) => void;
  resourceType?: 'model' | 'vectorIndex' | 'provider';
  resourceOptions?: { value: string; label: string }[];
  disabled?: boolean;
}

interface UserOption {
  value: string;
  label: string;
}

interface TokenOption {
  value: string;
  label: string;
}

export function ScopeIdSelector({
  scope,
  value,
  onChange,
  resourceType,
  resourceOptions = [],
  disabled = false,
}: ScopeIdSelectorProps) {
  const t = useTranslations('settings.quotaSection.form');
  
  const [users, setUsers] = useState<UserOption[]>([]);
  const [tokens, setTokens] = useState<TokenOption[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingTokens, setLoadingTokens] = useState(false);

  // Fetch users when scope is 'user'
  useEffect(() => {
    if (scope === 'user') {
      setLoadingUsers(true);
      fetch('/api/users')
        .then((res) => res.json())
        .then((data) => {
          const userOptions = (data.users || []).map((u: { _id: string; name: string; email: string }) => ({
            value: u._id,
            label: `${u.name} (${u.email})`,
          }));
          setUsers(userOptions);
        })
        .catch(() => setUsers([]))
        .finally(() => setLoadingUsers(false));
    }
  }, [scope]);

  // Fetch tokens when scope is 'token'
  useEffect(() => {
    if (scope === 'token') {
      setLoadingTokens(true);
      fetch('/api/tokens')
        .then((res) => res.json())
        .then((data) => {
          const tokenOptions = (data.tokens || []).map((tok: { _id: string; label: string }) => ({
            value: tok._id,
            label: tok.label,
          }));
          setTokens(tokenOptions);
        })
        .catch(() => setTokens([]))
        .finally(() => setLoadingTokens(false));
    }
  }, [scope]);

  // Tenant scope doesn't need a selector
  if (scope === 'tenant') {
    return null;
  }

  // User scope - dropdown with users
  if (scope === 'user') {
    return (
      <Select
        label={t('scopeId')}
        placeholder={t('selectUser')}
        description={t('scopeIdDescription')}
        data={users}
        value={value || null}
        onChange={(v) => onChange(v || undefined)}
        searchable
        clearable
        disabled={disabled}
        rightSection={loadingUsers ? <Loader size="xs" /> : undefined}
        nothingFoundMessage={t('noUsersFound')}
      />
    );
  }

  // Token scope - dropdown with tokens
  if (scope === 'token') {
    return (
      <Select
        label={t('scopeId')}
        placeholder={t('selectToken')}
        description={t('scopeIdDescription')}
        data={tokens}
        value={value || null}
        onChange={(v) => onChange(v || undefined)}
        searchable
        clearable
        disabled={disabled}
        rightSection={loadingTokens ? <Loader size="xs" /> : undefined}
        nothingFoundMessage={t('noTokensFound')}
      />
    );
  }

  // Resource scope - dropdown with provided resources
  if (scope === 'resource') {
    if (resourceOptions.length > 0) {
      return (
        <Select
          label={t('scopeId')}
          placeholder={t('selectResource')}
          description={t('scopeIdDescription')}
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
        label={t('scopeId')}
        placeholder={t('scopeIdPlaceholder')}
        description={t('scopeIdDescription')}
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
        label={t('scopeId')}
        placeholder={t('scopeIdPlaceholder')}
        description={t('scopeIdDescription')}
        value={value || ''}
        onChange={(e) => onChange(e.currentTarget.value || undefined)}
        disabled={disabled}
      />
    );
  }

  return null;
}
