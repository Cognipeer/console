'use client';

import { Paper, Stack } from '@mantine/core';
import { IconSettings } from '@tabler/icons-react';
import UserManagement from '@/components/settings/UserManagement';
import ProjectsManagement from '@/components/settings/ProjectsManagement';
import TenantProviders from '@/components/settings/TenantProviders';
import PageHeader from '@/components/layout/PageHeader';
import { useTranslations } from '@/lib/i18n';

export default function TenantSettingsPage() {
  const t = useTranslations('settings');

  return (
    <Stack gap="md">
      {/* Header */}
      <PageHeader
        icon={<IconSettings size={18} />}
        title={t('title')}
        subtitle={t('subtitle')}
      />

      <Paper radius="lg" withBorder p={0} style={{ overflow: 'hidden' }}>
        <UserManagement />
      </Paper>

      <Paper radius="lg" withBorder p={0} style={{ overflow: 'hidden' }}>
        <ProjectsManagement />
      </Paper>

      <Paper radius="lg" withBorder p={0} style={{ overflow: 'hidden' }}>
        <TenantProviders />
      </Paper>
    </Stack>
  );
}
