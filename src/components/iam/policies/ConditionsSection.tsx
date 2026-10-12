'use client';

import { Stack, Text } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import dayjs from 'dayjs';
import { ChipPicker, FormField, FormRow } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import type { IamCatalog, IamChannel } from '../api';
import CidrInput from '../pickers/CidrInput';
import type { IamLabels } from '../useIamLabels';
import { hasIssue, type DraftIssue, type PolicyDraft } from './specModel';

interface ConditionsSectionProps {
  draft: PolicyDraft;
  patch: (change: Partial<PolicyDraft>) => void;
  catalog: IamCatalog;
  labels: IamLabels;
  issues: readonly DraftIssue[];
}

const toIso = (value: Date | string | null): string | null => {
  if (!value) return null;
  const d = dayjs(value);
  return d.isValid() ? d.toDate().toISOString() : null;
};

const fromIso = (iso: string | null): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Optional limits on when a request counts: time window, source network, channel. All set conditions must hold. */
export default function ConditionsSection({ draft, patch, catalog, labels, issues }: ConditionsSectionProps) {
  const t = useTranslations('iamCenter');

  return (
    <Stack gap="md">
      <Text size="xs" c="dimmed">
        {t('conditions.help')}
      </Text>
      <FormRow cols={2}>
        <FormField label={t('conditions.validFrom')} optional>
          <DateTimePicker
            value={fromIso(draft.validFrom)}
            onChange={(v) => patch({ validFrom: toIso(v) })}
            clearable
            valueFormat="DD MMM YYYY HH:mm"
            placeholder={t('conditions.noLimit')}
          />
        </FormField>
        <FormField
          label={t('conditions.validUntil')}
          optional
        >
          <DateTimePicker
            value={fromIso(draft.validUntil)}
            onChange={(v) => patch({ validUntil: toIso(v) })}
            clearable
            valueFormat="DD MMM YYYY HH:mm"
            placeholder={t('conditions.noLimit')}
            error={hasIssue(issues, 'timeOrder') ? t('validation.timeOrder') : undefined}
          />
        </FormField>
      </FormRow>
      <Text size="xs" c="dimmed" mt={-8}>
        {t('conditions.timeZoneNote')}
      </Text>

      <FormField label={t('conditions.ipRanges')} hint={t('conditions.ipHelp')} optional>
        <CidrInput value={draft.ipRanges} onChange={(ipRanges) => patch({ ipRanges })} />
      </FormField>

      <FormField label={t('conditions.channels')} hint={t('conditions.channelsHelp')} optional>
        <ChipPicker<IamChannel>
          multiple
          options={catalog.channels.map((c) => ({ value: c, label: labels.channel(c) }))}
          value={new Set<IamChannel>(draft.channels)}
          onChange={(next) => patch({ channels: [...(next as Set<IamChannel>)] })}
        />
      </FormField>
    </Stack>
  );
}
