'use client';

import { Alert, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertCircle, IconInfoCircle } from '@tabler/icons-react';
import { ChipPicker } from '@/components/common/ui/FormShell';
import { formatDateTime, formatRelative } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  addDays,
  expiryPresets,
  expiryPreview,
  expiryProblem,
  maxDaysFromNow,
  toDateInput,
  type ExpiryChoice,
  type ExpiryContext,
  type TokenPolicyView,
} from './tokenModel';

export interface ExpiryFieldProps {
  mode: 'create' | 'edit';
  policy: TokenPolicyView;
  value: ExpiryChoice;
  onChange: (next: ExpiryChoice) => void;
  /** Edit: when the token was created (a maximum lifetime counts from there). */
  createdAt?: string | null;
  /** Edit: the expiry the token has now. */
  currentExpiresAt?: string | null;
  disabled?: boolean;
}

/**
 * The expiry of a token: never / N days from now / a calendar day, limited by
 * the tenant's token rules. The choices that would be refused are not offered
 * and a problem is spelled out, but the server checks the same rules again.
 */
export default function ExpiryField({
  mode,
  policy,
  value,
  onChange,
  createdAt,
  currentExpiresAt,
  disabled,
}: ExpiryFieldProps) {
  const t = useTranslations('iamTokens');
  const locale = useLocale();
  const now = Date.now();
  const ctx: ExpiryContext = { policy, createdAt: mode === 'edit' ? createdAt : null, now };
  const maxDays = maxDaysFromNow(ctx);
  const presets = expiryPresets(ctx);
  const exhausted = maxDays !== null && maxDays < 1;
  const problem = expiryProblem(value, ctx);
  const preview = expiryPreview(value, now);
  const today = new Date(now);

  const dayLabel = (count: number) => t(count === 1 ? 'expiry.dayOne' : 'expiry.dayMany', { count });

  const segments = [
    ...(mode === 'edit' ? [{ value: 'keep', label: t('expiry.choice.keep') }] : []),
    { value: 'none', label: t('expiry.choice.none'), disabled: policy.expiryRequired },
    { value: 'days', label: t('expiry.choice.days'), disabled: exhausted },
    { value: 'date', label: t('expiry.choice.date'), disabled: exhausted },
  ];

  const selectKind = (kind: string) => {
    if (kind === 'keep') return onChange({ kind: 'keep' });
    if (kind === 'none') return onChange({ kind: 'none' });
    if (kind === 'days') {
      const fallback = presets.filter((d) => d <= 90).pop() ?? presets[0] ?? 1;
      return onChange({ kind: 'days', days: value.kind === 'days' ? value.days : fallback });
    }
    const suggested = Math.max(1, Math.min(30, maxDays ?? 30));
    return onChange({
      kind: 'date',
      date: value.kind === 'date' ? value.date : toDateInput(addDays(today, suggested)),
    });
  };

  const problemText = problem ? t(`expiry.problem.${problem}`, { days: maxDays ?? '', max: policy.maxLifetimeDays ?? '' }) : null;

  let summary: string | null = null;
  if (value.kind === 'none') summary = t('expiry.never');
  else if (value.kind === 'keep') {
    summary = currentExpiresAt
      ? t('expiry.current', { when: formatDateTime(currentExpiresAt, locale) })
      : t('expiry.currentNone');
  } else if (preview && !problem) {
    summary = t('expiry.preview', {
      when: formatDateTime(preview.toISOString(), locale),
      relative: formatRelative(preview.toISOString(), locale, now),
    });
  }

  return (
    <Stack gap="xs">
      <SegmentedControl
        fullWidth
        size="xs"
        aria-label={t('expiry.title')}
        data={segments}
        value={value.kind}
        onChange={selectKind}
        disabled={disabled}
      />

      {value.kind === 'days' ? (
        <ChipPicker<string>
          options={presets.map((days) => ({ value: String(days), label: dayLabel(days) }))}
          value={String(value.days)}
          onChange={(next) => {
            if (typeof next === 'string' && !disabled) onChange({ kind: 'days', days: Number(next) });
          }}
        />
      ) : null}

      {value.kind === 'date' ? (
        <TextInput
          type="date"
          value={value.date}
          min={toDateInput(addDays(today, 1))}
          max={maxDays !== null ? toDateInput(addDays(today, Math.max(1, maxDays))) : undefined}
          onChange={(event) => onChange({ kind: 'date', date: event.currentTarget.value })}
          disabled={disabled}
          aria-label={t('expiry.dateLabel')}
        />
      ) : null}

      {summary && !problemText ? (
        <Text size="xs" c="dimmed">
          {summary}
        </Text>
      ) : null}

      {problemText ? (
        <Alert color="red" variant="light" p="xs" icon={<IconAlertCircle size={14} />}>
          <Text size="xs">{problemText}</Text>
        </Alert>
      ) : null}

      {policy.maxLifetimeDays !== null ? (
        <Alert color="blue" variant="light" p="xs" icon={<IconInfoCircle size={14} />}>
          <Text size="xs">
            {t('expiry.policyMax', { days: policy.maxLifetimeDays })}
            {mode === 'edit' && !exhausted && maxDays !== null ? ` ${t('expiry.remaining', { days: maxDays })}` : ''}
            {mode === 'edit' && exhausted ? ` ${t('expiry.exhausted')}` : ''}
          </Text>
        </Alert>
      ) : policy.requireExpiry ? (
        <Alert color="blue" variant="light" p="xs" icon={<IconInfoCircle size={14} />}>
          <Text size="xs">{t('expiry.policyRequired')}</Text>
        </Alert>
      ) : null}
    </Stack>
  );
}
