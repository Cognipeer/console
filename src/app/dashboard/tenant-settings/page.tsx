'use client';

import { useState } from 'react';
import { Tabs, Paper, Stack, Title, Text, Group } from '@mantine/core';
import { IconUsers, IconFolder, IconPlug } from '@tabler/icons-react';
import UserManagement from '@/components/settings/UserManagement';
import ProjectsManagement from '@/components/settings/ProjectsManagement';
import TenantProviders from '@/components/settings/TenantProviders';
import { useTranslations } from '@/lib/i18n';

export default function TenantSettingsPage() {
  const [activeTab, setActiveTab] = useState<string | null>('users');
  const t = useTranslations('settings');

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>{t('title')}</Title>
          <Text size="sm" c="dimmed" mt={4}>
            {t('subtitle')}
          </Text>
        </div>
      </Group>

      <Paper shadow="sm" radius="md" withBorder>
        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            <Tabs.Tab value="users" leftSection={<IconUsers size={16} />}>
              {t('tabs.users')}
            </Tabs.Tab>
            <Tabs.Tab value="projects" leftSection={<IconFolder size={16} />}>
              {t('tabs.projects')}
            </Tabs.Tab>
            <Tabs.Tab value="providers" leftSection={<IconPlug size={16} />}>
              {t('tabs.providers')}
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="users" pt="md">
            <UserManagement />
          </Tabs.Panel>

          <Tabs.Panel value="projects" pt="md">
            <ProjectsManagement />
          </Tabs.Panel>

          <Tabs.Panel value="providers" pt="md">
            <TenantProviders />
          </Tabs.Panel>
        </Tabs>
      </Paper>
    </Stack>
  );
}
