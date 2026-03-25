'use client';

import { Paper, Stack } from '@mantine/core';
import { IconPlug } from '@tabler/icons-react';
import TenantProviders from '@/components/settings/TenantProviders';
import PageHeader from '@/components/layout/PageHeader';
import { useTranslations } from '@/lib/i18n';

export default function ProvidersPage() {
  const t = useTranslations('navigation');

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconPlug size={18} />}
        title={t('providers')}
        subtitle={t('providersDescription')}
      />

      <Paper radius="lg" withBorder p={0} style={{ overflow: 'hidden' }}>
        <TenantProviders />
      </Paper>
    </Stack>
  );
}
