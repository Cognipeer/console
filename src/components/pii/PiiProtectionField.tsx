'use client';

import Link from 'next/link';
import { Group, List, Select, Stack, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { piiPolicyState, type PiiPolicyOptions } from './piiProtectionForm';
import { usePiiPolicyOptions } from './usePiiPolicyOptions';

export interface PiiProtectionFieldProps {
  /** The chosen PII policy key; `null` is off. */
  value: string | null;
  onChange: (next: string | null) => void;
  /** Which screen: the wording of the notes differs (a model protects every caller; an agent its own session). */
  surface: 'model' | 'agent';
  /** Agent only: the main model's own policy, which applies when the agent picks none. */
  modelPolicyKey?: string | null;
  /** Agent only: the main model's name, for the note about its policy. */
  modelName?: string;
  disabled?: boolean;
  /** The policies, when the host already loaded them (or a test supplies them); otherwise the field loads its own. */
  policies?: PiiPolicyOptions;
}

/**
 * Reversible PII protection for a model or an agent: one PII policy of the project, or off. What to look for (the
 * categories, the engine, custom patterns) is configured on the policy itself, under PII; here it is only chosen.
 */
export default function PiiProtectionField({
  value,
  onChange,
  surface,
  modelPolicyKey,
  modelName,
  disabled = false,
  policies,
}: PiiProtectionFieldProps) {
  const t = useTranslations('piiProtection');
  const ownPolicies = usePiiPolicyOptions(policies === undefined);
  const options = policies ?? ownPolicies;
  const state = piiPolicyState(value, options);
  const chosen = value ? options.policies.find((policy) => policy.key === value) : undefined;
  const policyName = (key: string) => options.policies.find((policy) => policy.key === key)?.name ?? key;

  const data = options.policies.map((policy) => ({
    value: policy.key,
    label: policy.enabled ? policy.name : `${policy.name} · ${t('policy.disabledSuffix')}`,
  }));
  // A key that is set but not listed stays visible, with the error under the picker.
  if (value && !data.some((item) => item.value === value)) data.push({ value, label: value });

  const error = state === 'missing'
    ? t('policy.missing', { key: value ?? '' })
    : state === 'disabled'
      ? t('policy.disabled')
      : undefined;

  return (
    <Stack gap="sm">
      {surface === 'agent' && modelPolicyKey ? (
        <Text size="sm" c="dimmed">
          {value
            ? t('agent.replaces', { model: modelName ?? '', policy: policyName(modelPolicyKey) })
            : t('agent.inherited', { model: modelName ?? '', policy: policyName(modelPolicyKey) })}
        </Text>
      ) : null}

      <Select
        label={t('policy.label')}
        description={t('policy.hint')}
        placeholder={options.loading ? t('policy.loading') : t('policy.placeholder')}
        data={data}
        value={value}
        onChange={(next) => onChange(next || null)}
        clearable
        searchable
        disabled={disabled}
        error={error}
        nothingFoundMessage={t('policy.none')}
      />

      {options.failed ? <Text size="xs" c="orange">{t('policy.failed')}</Text> : null}

      <Group gap="md">
        {chosen ? (
          <Link href={`/dashboard/pii/${encodeURIComponent(chosen.id)}`} style={{ fontSize: 'var(--mantine-font-size-xs)' }}>
            {t('policy.open')}
          </Link>
        ) : null}
        {!options.loading && !options.failed && options.policies.length === 0 ? (
          <Text size="xs" c="dimmed">
            {t('policy.none')}{' '}
            <Link href="/dashboard/pii">{t('policy.create')}</Link>
          </Text>
        ) : null}
      </Group>

      {value ? (
        <List size="xs" c="dimmed" spacing={2}>
          <List.Item>{t('limits.media')}</List.Item>
          <List.Item>{surface === 'model' ? t('limits.logs') : t('limits.session')}</List.Item>
        </List>
      ) : null}
    </Stack>
  );
}
