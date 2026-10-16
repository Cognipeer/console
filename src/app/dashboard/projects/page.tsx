'use client';

import { Suspense } from 'react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import ProjectsList from '@/components/projects/ProjectsList';
import { useTranslations } from '@/lib/i18n';

export default function ProjectsPage() {
  const t = useTranslations('navigation');
  const tList = useTranslations('projectsAccess.list');

  return (
    <PageContainer>
      <PageHeader eyebrow={tList('eyebrow')} title={t('projects')} subtitle={tList('subtitle')} />
      <Suspense fallback={null}>
        <ProjectsList />
      </Suspense>
    </PageContainer>
  );
}
