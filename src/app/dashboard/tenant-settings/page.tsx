'use client';

import { useState } from 'react';
import { Tabs, Paper, Stack, Title, Text, Group, ThemeIcon } from '@mantine/core';
import { IconUsers, IconFolder, IconPlug, IconSettings } from '@tabler/icons-react';
import UserManagement from '@/components/settings/UserManagement';
import ProjectsManagement from '@/components/settings/ProjectsManagement';
import TenantProviders from '@/components/settings/TenantProviders';
import { useTranslations } from '@/lib/i18n';

export default function TenantSettingsPage() {
  const [activeTab, setActiveTab] = useState<string | null>('users');
  const t = useTranslations('settings');

  return (
    <Stack gap="lg">
      {/* Header */}
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background: 'linear-gradient(135deg, var(--mantine-color-gray-0) 0%, var(--mantine-color-teal-0) 100%)',
          borderColor: 'var(--mantine-color-gray-2)',
        }}>
        <Group gap="md">
          <ThemeIcon
            size={50}
            radius="xl"
            variant="gradient"
            gradient={{ from: 'gray.6', to: 'teal', deg: 135 }}>
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

      <Paper radius="lg" withBorder style={{ overflow: 'hidden' }}>
        <Tabs value={activeTab} onChange={setActiveTab} variant="default">
          <Tabs.List style={{ borderBottom: '1px solid var(--mantine-color-gray-2)', padding: '0 16px' }}>
            <Tabs.Tab 
              value="users" 
              leftSection={<IconUsers size={16} />}
              style={{ padding: '16px 20px' }}>
              {t('tabs.users')}
            </Tabs.Tab>
            <Tabs.Tab 
              value="projects" 
              leftSection={<IconFolder size={16} />}
              style={{ padding: '16px 20px' }}>
              {t('tabs.projects')}
            </Tabs.Tab>
            <Tabs.Tab 
              value="providers" 
              leftSection={<IconPlug size={16} />}
              style={{ padding: '16px 20px' }}>
              {t('tabs.providers')}
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="users" p="lg">
            <UserManagement />
          </Tabs.Panel>

          <Tabs.Panel value="projects" p="lg">
            <ProjectsManagement />
          </Tabs.Panel>

          <Tabs.Panel value="providers" p="lg">
            <TenantProviders />
          </Tabs.Panel>
        </Tabs>
      </Paper>
    </Stack>
  );
}
