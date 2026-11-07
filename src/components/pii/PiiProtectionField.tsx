'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Group, List, Select, Stack, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { useCanWriteService } from '@/components/layout/launcher/LauncherContext';
import CreatePiiPolicyModal from './CreatePiiPolicyModal';
import { piiPolicyState, type PiiPolicyOption, type PiiPolicyOptions } from './piiProtectionForm';
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
  // "+ New PII policy": the PII create form over this one, for someone who can add policies. The new policy is
  // listed at once and chosen.
  const canCreate = useCanWriteService('pii') && !disabled;
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<PiiPolicyOption[]>([]);
  const loaded = policies ?? ownPolicies;
  const options = useMemo<PiiPolicyOptions>(
    () => ({
      ...loaded,
      policies: [
        ...loaded.policies,
        ...created.filter((policy) => !loaded.policies.some((p) => p.key === policy.key)),
      ],
    }),
    [loaded, created],
  );
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
          <Text size="xs" c="dimmed" data-testid="pii-policy-none">
            {canCreate ? t('policy.none') : `${t('policy.none')} ${t('policy.noneReadOnly')}`}
          </Text>
        ) : null}
        {canCreate && !options.loading ? (
          <Button
            variant="subtle"
            size="compact-xs"
            leftSection={<IconPlus size={12} />}
            onClick={() => setCreateOpen(true)}
            data-testid="pii-policy-create-inline"
          >
            {options.policies.length === 0 ? t('policy.create') : t('policy.new')}
          </Button>
        ) : null}
      </Group>

      {canCreate ? (
        <CreatePiiPolicyModal
          opened={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(policy) => {
            setCreated((current) => [
              ...current.filter((p) => p.key !== policy.key),
              { id: policy.id, key: policy.key, name: policy.name || policy.key, enabled: true },
            ]);
            onChange(policy.key);
          }}
        />
      ) : null}

      {value ? (
        <List size="xs" c="dimmed" spacing={2}>
          <List.Item>{t('limits.media')}</List.Item>
          <List.Item>{surface === 'model' ? t('limits.logs') : t('limits.session')}</List.Item>
        </List>
      ) : null}
    </Stack>
  );
}
