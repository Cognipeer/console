'use client';

import { useState } from 'react';
import { Tabs } from '@mantine/core';
import { IconUsers, IconUsersGroup } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import UserManagement from '@/components/settings/UserManagement';
import GroupManagement from '@/components/settings/GroupManagement';
import { useTranslations } from '@/lib/i18n';

export default function MembersPage() {
  const t = useTranslations('navigation');
  const [tab, setTab] = useState<string | null>('users');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Configure · Members"
        title={t('members')}
        subtitle={t('membersDescription')}
      />
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="users" leftSection={<IconUsers size={15} />}>
            Users
          </Tabs.Tab>
          <Tabs.Tab value="groups" leftSection={<IconUsersGroup size={15} />}>
            Groups
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="users">
          <UserManagement />
        </Tabs.Panel>
        <Tabs.Panel value="groups">
          <GroupManagement />
        </Tabs.Panel>
      </Tabs>
    </PageContainer>
  );
}
