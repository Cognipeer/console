'use client';

import { useState } from 'react';
import { Tabs, Paper, Stack, Title, Text, Group } from '@mantine/core';
import { IconUsers, IconKey } from '@tabler/icons-react';
import UserManagement from '@/components/settings/UserManagement';
import TokenManagement from '@/components/settings/TokenManagement';
import { useTranslations } from '@/lib/i18n';

export default function SettingsPage() {
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
            <Tabs.Tab value="tokens" leftSection={<IconKey size={16} />}>
              {t('tabs.tokens')}
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="users" pt="md">
            <UserManagement />
          </Tabs.Panel>

          <Tabs.Panel value="tokens" pt="md">
            <TokenManagement />
          </Tabs.Panel>
        </Tabs>
      </Paper>
    </Stack>
  );
}
