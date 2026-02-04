'use client';

import { Paper, Stack, Title, Text, Group, ThemeIcon } from '@mantine/core';
import { IconSettings } from '@tabler/icons-react';
import UserManagement from '@/components/settings/UserManagement';
import ProjectsManagement from '@/components/settings/ProjectsManagement';
import TenantProviders from '@/components/settings/TenantProviders';
import { useTranslations } from '@/lib/i18n';

export default function TenantSettingsPage() {
  const t = useTranslations('settings');

  return (
    <Stack gap="lg">
      {/* Header */}
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background: 'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-cyan-0) 100%)',
          borderColor: 'var(--mantine-color-teal-2)',
        }}>
        <Group gap="md">
          <ThemeIcon
            size={50}
            radius="xl"
            variant="gradient"
            gradient={{ from: 'teal', to: 'cyan', deg: 135 }}>
            <IconSettings size={26} />
          </ThemeIcon>
          <div>
            <Title order={2}>{t('title')}</Title>
            <Text size="sm" c="dimmed" mt={4}>
              {t('subtitle')}
            </Text>
          </div>
        </Group>
      </Paper>

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
