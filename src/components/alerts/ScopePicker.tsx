'use client';

import { useMemo, type ReactNode } from 'react';
import { Select, TextInput } from '@mantine/core';
import { useScopeItems } from '@/lib/api/queries/alerts';
import { useTranslations } from '@/lib/i18n';
import type { ScopeField } from './ruleForm';

interface ScopeSource {
  url: string;
  /** Response property that holds the list. */
  list: string;
}

/** The per-service list endpoint behind each legacy scope field. Each is gated by its own service's RBAC. */
const SCOPE_SOURCES: Record<ScopeField, ScopeSource> = {
  modelKey: { url: '/api/models?category=llm', list: 'models' },
  serverKey: { url: '/api/inference-monitoring/servers', list: 'servers' },
  guardrailKey: { url: '/api/guardrails', list: 'guardrails' },
  ragModuleKey: { url: '/api/rag/modules?status=active', list: 'modules' },
  mcpServerKey: { url: '/api/mcp', list: 'servers' },
};

export interface ScopePickerProps {
  field: ScopeField;
  value: string;
  onChange: (next: string) => void;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * Picker for the optional per-service scope of a legacy rule. When the list cannot be
 * read (no permission for that service, or any error) it degrades to a plain text
 * input, so the scope can still be typed.
 */
export default function ScopePicker({ field, value, onChange, label, disabled }: ScopePickerProps) {
  const t = useTranslations('alerts');
  const source = SCOPE_SOURCES[field];
  const query = useScopeItems(source.url, source.list);
  const items = query.data ?? null;
  const loading = query.isPending;
  const failed = query.isError;

  const data = useMemo(() => {
    const options = (items ?? []).map((item) => ({ value: item.key, label: item.name ? `${item.name} (${item.key})` : item.key }));
    // A stored scope the list no longer offers must still show.
    if (value && !options.some((option) => option.value === value)) options.unshift({ value, label: value });
    return options;
  }, [items, value]);

  if (failed || (!loading && items === null)) {
    return (
      <TextInput
        label={label}
        description={t('target.scopeUnavailable')}
        placeholder={t('target.scopePlaceholder')}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }

  return (
    <Select
      label={label}
      description={t('target.scopeHint')}
      placeholder={loading ? t('target.scopeLoading') : t('target.scopeAny')}
      data={data}
      value={value || null}
      searchable
      clearable
      disabled={disabled || loading}
      nothingFoundMessage={t('target.scopeNothing')}
      onChange={(next) => onChange(next ?? '')}
    />
  );
}
