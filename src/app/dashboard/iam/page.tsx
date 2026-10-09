'use client';

import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import AuthorizationEngine from '@/components/settings/AuthorizationEngine';
import { useTranslations } from '@/lib/i18n';

export default function IamPage() {
  const t = useTranslations('navigation');
  const ti = useTranslations('iam');

  return (
    <PageContainer>
      <PageHeader eyebrow={ti('eyebrow')} title={t('iam')} subtitle={t('iamDescription')} />
      <AuthorizationEngine />
    </PageContainer>
  );
}
