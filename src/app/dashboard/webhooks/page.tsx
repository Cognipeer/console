'use client';

import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import WebhookManagement from '@/components/settings/WebhookManagement';
import { useTranslations } from '@/lib/i18n';

export default function WebhooksPage() {
  const t = useTranslations('navigation');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Configure · Webhooks"
        title={t('webhooks')}
        subtitle={t('webhooksDescription')}
      />
      <WebhookManagement />
    </PageContainer>
  );
}
