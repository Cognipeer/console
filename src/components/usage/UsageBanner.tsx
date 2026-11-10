'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Anchor, Group, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { UsageBanner as UsageBannerData } from '@/lib/limits/usageSummary';
import { bannerMessage } from './format';
import { USAGE_PATH } from './links';
import { useUsageSummary } from './useUsageSummary';

const POLL_MS = 60_000;
const STORAGE_PREFIX = 'usage-banner-dismissed:';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isDismissed(id: string): boolean {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + id) === today();
  } catch {
    return false;
  }
}

function remember(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + id, today());
  } catch {
    /* storage unavailable: the banner just comes back on the next load */
  }
}

/**
 * The most severe plan-usage banner (monthly allowance, storage, credits or
 * repeated capacity hits), with a link to the usage page. Dismissed for the
 * rest of the day, per banner. Renders nothing unless `enabled`.
 */
export function UsageBanner({ enabled }: { enabled: boolean }) {
  const t = useTranslations('usage');
  const locale = useLocale();
  const { summary } = useUsageSummary(POLL_MS, enabled);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!summary) return;
    const next: Record<string, boolean> = {};
    for (const banner of summary.banners) next[banner.id] = isDismissed(banner.id);
    setDismissed(next);
  }, [summary]);

  const dismiss = useCallback((id: string) => {
    remember(id);
    setDismissed((current) => ({ ...current, [id]: true }));
  }, []);

  if (!enabled || !summary) return null;
  // The list arrives most severe first.
  const banner: UsageBannerData | undefined = summary.banners.find((candidate) => !dismissed[candidate.id]);
  if (!banner) return null;

  return (
    <Alert
      color={banner.severity === 'critical' ? 'red' : 'yellow'}
      icon={<IconAlertTriangle size={16} />}
      withCloseButton
      closeButtonLabel={t('banner.dismiss')}
      onClose={() => dismiss(banner.id)}
      mb="md"
      data-testid="usage-banner"
    >
      <Group gap="sm" wrap="wrap">
        <Text size="sm">{bannerMessage(banner, t, locale)}</Text>
        <Anchor component={Link} href={USAGE_PATH} size="sm">
          {t('banner.link')}
        </Anchor>
      </Group>
    </Alert>
  );
}

export default UsageBanner;
