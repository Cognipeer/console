'use client';

import { Paper, Stack } from '@mantine/core';
import { IconKey } from '@tabler/icons-react';
import TokenManagement from '@/components/settings/TokenManagement';
import PageHeader from '@/components/layout/PageHeader';
import { useTranslations } from '@/lib/i18n';

export default function TokensPage() {
  const t = useTranslations('navigation');

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconKey size={18} />}
        title={t('tokens')}
        subtitle={t('tokensDescription')}
      />

      <Paper radius="lg" withBorder p={0} style={{ overflow: 'hidden' }}>
        <TokenManagement />
      </Paper>
    </Stack>
  );
}
