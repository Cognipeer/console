'use client';

import { Suspense, useCallback, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { Group, Loader, Tabs } from '@mantine/core';
import {
  IconChecklist,
  IconGauge,
  IconHistory,
  IconLayoutDashboard,
  IconSettings,
  IconShieldLock,
  IconUsers,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import AccessCheckTab from '@/components/iam/check/AccessCheckTab';
import AuditTab from '@/components/iam/audit/AuditTab';
import LimitsTab from '@/components/iam/limits/LimitsTab';
import OverviewTab from '@/components/iam/overview/OverviewTab';
import PoliciesTab from '@/components/iam/policies/PoliciesTab';
import PrincipalsTab from '@/components/iam/principals/PrincipalsTab';
import IamSettingsTab from '@/components/iam/settings/IamSettingsTab';
import { iamHref, isIamTabId, parseTabId, type IamTabId } from '@/components/iam/links';
import { useIamCapabilities } from '@/components/iam/useIamCapabilities';
import { useTranslations } from '@/lib/i18n';

/**
 * The IAM center: one place to manage who can do what. The active tab lives in
 * the URL (`?tab=`), so a tab is linkable and the other tabs can deep-link into
 * it (`?tab=check&decisionId=...`, `?tab=policies&new=1&principalType=...`).
 * Every tab is visible to anyone who can read the `iam` service; changing
 * anything needs `iam` admin, which the page resolves once and hands down as
 * `canManage`. The server enforces it again on every write.
 */
function IamCenter() {
  const t = useTranslations('iamCenter');
  const searchParams = useSearchParams()!;
  const active = parseTabId(searchParams.get('tab'));
  const { canManage, ready } = useIamCapabilities();

  const select = useCallback(
    (next: string | null) => {
      if (!next || !isIamTabId(next) || next === active) return;
      // Same page, new query: Next keeps useSearchParams in sync with the history API.
      window.history.pushState(null, '', iamHref(next));
    },
    [active],
  );

  // Until `canManage` is trustworthy the tabs wait (a deep link into the editor must not see a guess).
  const body = (content: ReactNode): ReactNode =>
    ready ? (
      content
    ) : (
      <Group justify="center" py="xl">
        <Loader size="sm" />
      </Group>
    );

  const tabs: Array<{ id: IamTabId; icon: ReactNode }> = [
    { id: 'overview', icon: <IconLayoutDashboard size={15} /> },
    { id: 'policies', icon: <IconShieldLock size={15} /> },
    { id: 'principals', icon: <IconUsers size={15} /> },
    { id: 'check', icon: <IconChecklist size={15} /> },
    { id: 'audit', icon: <IconHistory size={15} /> },
    { id: 'limits', icon: <IconGauge size={15} /> },
    { id: 'settings', icon: <IconSettings size={15} /> },
  ];

  return (
    <Tabs value={active} onChange={select} keepMounted={false}>
      <Tabs.List mb="md" style={{ flexWrap: 'nowrap', overflowX: 'auto' }}>
        {tabs.map((tab) => (
          <Tabs.Tab key={tab.id} value={tab.id} leftSection={tab.icon} style={{ whiteSpace: 'nowrap' }}>
            {t(`tabs.${tab.id}`)}
          </Tabs.Tab>
        ))}
      </Tabs.List>

      <Tabs.Panel value="overview">{body(<OverviewTab canManage={canManage} />)}</Tabs.Panel>
      <Tabs.Panel value="policies">{body(<PoliciesTab canManage={canManage} />)}</Tabs.Panel>
      <Tabs.Panel value="principals">{body(<PrincipalsTab canManage={canManage} />)}</Tabs.Panel>
      <Tabs.Panel value="check">{body(<AccessCheckTab canManage={canManage} />)}</Tabs.Panel>
      <Tabs.Panel value="audit">{body(<AuditTab />)}</Tabs.Panel>
      <Tabs.Panel value="limits">{body(<LimitsTab canManage={canManage} />)}</Tabs.Panel>
      <Tabs.Panel value="settings">{body(<IamSettingsTab canManage={canManage} />)}</Tabs.Panel>
    </Tabs>
  );
}

export default function IamPage() {
  const t = useTranslations('iamCenter');
  const ti = useTranslations('iam');

  return (
    <PageContainer>
      <PageHeader eyebrow={ti('eyebrow')} title={t('title')} subtitle={t('subtitle')} />
      <Suspense
        fallback={
          <Group justify="center" py="xl">
            <Loader size="sm" />
          </Group>
        }
      >
        <IamCenter />
      </Suspense>
    </PageContainer>
  );
}
