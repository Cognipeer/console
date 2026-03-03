'use client';

import { Paper, Stack } from '@mantine/core';
import { IconUsers } from '@tabler/icons-react';
import UserManagement from '@/components/settings/UserManagement';
import PageHeader from '@/components/layout/PageHeader';
import { useTranslations } from '@/lib/i18n';

export default function MembersPage() {
  const t = useTranslations('navigation');

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconUsers size={18} />}
        title={t('members')}
        subtitle={t('membersDescription')}
      />

      <Paper radius="lg" withBorder p={0} style={{ overflow: 'hidden' }}>
        <UserManagement />
      </Paper>
    </Stack>
  );
}
