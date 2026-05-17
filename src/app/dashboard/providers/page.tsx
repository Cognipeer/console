'use client';

import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import TenantProviders from '@/components/settings/TenantProviders';
import { useTranslations } from '@/lib/i18n';

export default function ProvidersPage() {
  const t = useTranslations('navigation');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Configure · Providers"
        title={t('providers')}
        subtitle={t('providersDescription')}
      />

      <TenantProviders />
    </PageContainer>
  );
}
