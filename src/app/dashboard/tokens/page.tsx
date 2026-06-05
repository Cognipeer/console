'use client';

import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import TokenManagement from '@/components/settings/TokenManagement';
import { useTranslations } from '@/lib/i18n';

export default function TokensPage() {
  const t = useTranslations('navigation');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Configure · API Tokens"
        title={t('tokens')}
        subtitle={t('tokensDescription')}
      />
      <TokenManagement />
    </PageContainer>
  );
}
