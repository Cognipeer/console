'use client';

import { Suspense, useCallback, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert, Button, Group, Loader, Tabs } from '@mantine/core';
import { IconCoins, IconHistory, IconLayoutDashboard, IconLock } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import UsageCreditsTab from '@/components/usage/UsageCreditsTab';
import UsageEventsTab from '@/components/usage/UsageEventsTab';
import UsageOverviewTab from '@/components/usage/UsageOverviewTab';
import { isUsageTabId, parseUsageTab, usageHref, type UsageTabId } from '@/components/usage/links';
import { useUsageSummary, type UsageSummaryState } from '@/components/usage/useUsageSummary';
import { useTranslations } from '@/lib/i18n';

const POLL_MS = 10_000;

/**
 * The usage page: plan, capacity, monthly allowances, credits and limit events.
 * The active tab lives in the URL (`?tab=`), like the IAM center. The credits
 * tab exists only when the summary carries credits.
 */
function UsageCenter() {
  const t = useTranslations('usage');
  const searchParams = useSearchParams()!;
  const requested = parseUsageTab(searchParams.get('tab'));
  const { summary, loading, error, forbidden, refetch } = useUsageSummary(POLL_MS);

  const hasCredits = summary?.credits != null;
  // A link to a tab that is not there lands on the overview.
  const active: UsageTabId = requested === 'credits' && summary && !hasCredits ? 'overview' : requested;

  const select = useCallback(
    (next: string | null) => {
      if (!next || !isUsageTabId(next) || next === active) return;
      window.history.pushState(null, '', usageHref(next));
    },
    [active],
  );

  const spinner = (
    <Group justify="center" py="xl">
      <Loader size="sm" />
    </Group>
  );

  const body = (content: (summary: NonNullable<UsageSummaryState['summary']>) => ReactNode): ReactNode => {
    if (summary) return content(summary);
    if (error) {
      return (
        <Alert color="red" title={t('loadError')}>
          <Button variant="light" size="xs" onClick={() => void refetch()}>{t('retry')}</Button>
        </Alert>
      );
    }
    return loading ? spinner : null;
  };

  // Members and other non-admin roles: say who can see usage instead of a load error with a retry that cannot work.
  if (forbidden) {
    return (
      <Alert color="blue" variant="light" icon={<IconLock size={16} />} title={t('noAccessTitle')}>
        {t('noAccessDescription')}
      </Alert>
    );
  }

  return (
    <Tabs value={active} onChange={select} keepMounted={false}>
      <Tabs.List mb="md" style={{ flexWrap: 'nowrap', overflowX: 'auto' }}>
        <Tabs.Tab value="overview" leftSection={<IconLayoutDashboard size={15} />} style={{ whiteSpace: 'nowrap' }}>
          {t('tabs.overview')}
        </Tabs.Tab>
        {hasCredits ? (
          <Tabs.Tab value="credits" leftSection={<IconCoins size={15} />} style={{ whiteSpace: 'nowrap' }}>
            {t('tabs.credits')}
          </Tabs.Tab>
        ) : null}
        <Tabs.Tab value="events" leftSection={<IconHistory size={15} />} style={{ whiteSpace: 'nowrap' }}>
          {t('tabs.events')}
        </Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="overview">
        {body((data) => <UsageOverviewTab summary={data} onOpenCredits={() => select('credits')} />)}
      </Tabs.Panel>
      {hasCredits ? (
        <Tabs.Panel value="credits">
          {body((data) => <UsageCreditsTab summary={data} onRedeemed={refetch} />)}
        </Tabs.Panel>
      ) : null}
      <Tabs.Panel value="events">
        <UsageEventsTab />
      </Tabs.Panel>
    </Tabs>
  );
}

export default function UsagePage() {
  const t = useTranslations('usage');

  return (
    <PageContainer>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} subtitle={t('subtitle')} />
      <Suspense
        fallback={
          <Group justify="center" py="xl">
            <Loader size="sm" />
          </Group>
        }
      >
        <UsageCenter />
      </Suspense>
    </PageContainer>
  );
}
