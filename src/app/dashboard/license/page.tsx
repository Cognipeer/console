'use client';

import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import LicenseManagement from '@/components/settings/LicenseManagement';
import { useTranslations } from '@/lib/i18n';

export default function LicensePage() {
  const t = useTranslations('navigation');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Configure · License"
        title={t('license')}
        subtitle={t('licenseDescription')}
      />
      <LicenseManagement />
    </PageContainer>
  );
}
