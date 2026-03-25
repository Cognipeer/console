'use client';

import { Paper, Stack } from '@mantine/core';
import { IconLayoutGrid } from '@tabler/icons-react';
import ProjectsManagement from '@/components/settings/ProjectsManagement';
import PageHeader from '@/components/layout/PageHeader';
import { useTranslations } from '@/lib/i18n';

export default function ProjectsPage() {
  const t = useTranslations('navigation');

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconLayoutGrid size={18} />}
        title={t('projects')}
        subtitle={t('projectsDescription')}
      />

      <Paper radius="lg" withBorder p={0} style={{ overflow: 'hidden' }}>
        <ProjectsManagement />
      </Paper>
    </Stack>
  );
}
