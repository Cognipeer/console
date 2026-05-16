'use client';

import { Paper, Stack } from '@mantine/core';
import { IconCertificate } from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import LicenseManagement from '@/components/settings/LicenseManagement';
import { useTranslations } from '@/lib/i18n';

export default function LicensePage() {
  const t = useTranslations('navigation');

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconCertificate size={18} />}
        title={t('license')}
        subtitle={t('licenseDescription')}
      />

      <Paper radius="lg" withBorder p={0} style={{ overflow: 'hidden' }}>
        <LicenseManagement />
      </Paper>
    </Stack>
  );
}
