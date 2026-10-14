'use client';

import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import ResourceExplorer from '@/components/resources/ResourceExplorer';
import { useTranslations } from '@/lib/i18n';

export default function ResourcesPage() {
  const t = useTranslations('resources');

  return (
    <PageContainer>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} subtitle={t('subtitle')} />
      <ResourceExplorer />
    </PageContainer>
  );
}
