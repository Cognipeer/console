'use client';

import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import UserManagement from '@/components/settings/UserManagement';
import { useTranslations } from '@/lib/i18n';

export default function MembersPage() {
  const t = useTranslations('navigation');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Configure · Members"
        title={t('members')}
        subtitle={t('membersDescription')}
      />
      <UserManagement />
    </PageContainer>
  );
}
