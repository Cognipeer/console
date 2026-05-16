'use client';

import { Paper, Stack } from '@mantine/core';
import { IconClipboardList } from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import AuditLogViewer from '@/components/settings/AuditLogViewer';
import { useTranslations } from '@/lib/i18n';

export default function AuditPage() {
  const t = useTranslations('navigation');

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconClipboardList size={18} />}
        title={t('audit')}
        subtitle={t('auditDescription')}
      />

      <Paper radius="lg" withBorder p={0} style={{ overflow: 'hidden' }}>
        <AuditLogViewer />
      </Paper>
    </Stack>
  );
}
