'use client';

import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import AuditLogViewer from '@/components/settings/AuditLogViewer';
import { useTranslations } from '@/lib/i18n';

export default function AuditPage() {
  const t = useTranslations('navigation');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Audit"
        title={t('audit')}
        subtitle={t('auditDescription')}
      />
      <AuditLogViewer />
    </PageContainer>
  );
}
