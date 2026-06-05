'use client';

import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import ProjectsManagement from '@/components/settings/ProjectsManagement';
import { useTranslations } from '@/lib/i18n';

export default function ProjectsPage() {
  const t = useTranslations('navigation');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Configure · Projects"
        title={t('projects')}
        subtitle={t('projectsDescription')}
      />
      <ProjectsManagement />
    </PageContainer>
  );
}
