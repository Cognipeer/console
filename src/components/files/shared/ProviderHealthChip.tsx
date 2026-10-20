'use client';

import Link from 'next/link';
import { Anchor, Group, Stack, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import { formatRelativeTime } from '@/components/providers/providerAccessModel';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { ProviderHealth, ProviderHealthState } from '../filesApi';

export interface ProviderHealthChipProps {
  health: ProviderHealth | null | undefined;
  /** The provider's page. Shown as "Open provider" beside a problem (failed, disabled, never tested). */
  href?: string | null;
  /** Leave out the "· 2 hours ago" after the state. */
  hideTime?: boolean;
  /** Print the reason under the chip (a table cell) instead of keeping it in the tooltip. */
  showReason?: boolean;
}

const TONE: Record<ProviderHealthState, string> = {
  ok: 'ds-badge-ok',
  failed: 'ds-badge-err',
  inactive: 'ds-badge-warn',
  untested: '',
  builtin: '',
};

/**
 * A storage provider's standing as a chip: connected, test failed, disabled, not tested yet or built-in, with when it
 * was tested and why it is not fine. Renders nothing when the answer carries no health.
 */
export default function ProviderHealthChip({ health, href, hideTime, showReason }: ProviderHealthChipProps) {
  const t = useTranslations('files.common');
  const locale = useLocale();
  if (!health) return null;

  const { state } = health;
  const label = (() => {
    switch (state) {
      case 'ok': return t('health.ok');
      case 'failed': return t('health.failed');
      case 'inactive': return t('health.inactive');
      case 'builtin': return t('health.builtin');
      default: return t('health.untested');
    }
  })();
  const reason = (() => {
    const own = health.message?.trim();
    if (own) return own;
    switch (state) {
      case 'failed': return t('health.failedReason');
      case 'inactive': return t('health.inactiveReason');
      case 'untested': return t('health.untestedReason');
      case 'builtin': return t('health.builtinNote');
      default: return '';
    }
  })();
  const when = state === 'ok' || state === 'failed' ? formatRelativeTime(health.testedAt, locale) : '';
  const text = !hideTime && when ? `${label} · ${when}` : label;
  const isProblem = state === 'failed' || state === 'inactive' || state === 'untested';
  const tooltip = [reason, when ? t('health.testedAt', { when }) : ''].filter(Boolean).join(' · ');
  const link = href && isProblem ? (
    <Anchor component={Link} href={href} size="xs">
      {t('health.openProvider')}
    </Anchor>
  ) : null;

  const chip = <span className={`ds-badge ${TONE[state]}`.trim()}>{text}</span>;

  if (showReason) {
    return (
      <Stack gap={2} align="flex-start">
        {chip}
        {reason || link ? (
          <Group gap={6} wrap="wrap">
            {reason && state !== 'ok' ? (
              <Text size="xs" c="dimmed">
                {reason}
              </Text>
            ) : null}
            {link}
          </Group>
        ) : null}
      </Stack>
    );
  }

  // The tooltip is for the pointer; a screen reader gets the same words as text next to the chip.
  return (
    <Group gap={8} wrap="wrap" align="center">
      {tooltip ? (
        <Tooltip label={tooltip} multiline w={280} withArrow events={{ hover: true, focus: false, touch: true }}>
          <span style={{ display: 'inline-flex' }}>{chip}</span>
        </Tooltip>
      ) : (
        chip
      )}
      {tooltip ? <VisuallyHidden>{tooltip}</VisuallyHidden> : null}
      {link}
    </Group>
  );
}
