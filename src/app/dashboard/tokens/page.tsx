'use client';

import Link from 'next/link';
import { Alert, Button, Group, Text } from '@mantine/core';
import { IconInfoCircle, IconUsers } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { iamHref } from '@/components/iam/links';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import TokenManagement from '@/components/settings/TokenManagement';
import { useTranslations } from '@/lib/i18n';

/**
 * Personal API tokens: everyone, whatever their role, sees and manages only their
 * own tokens of the active project here. Other people's tokens are managed in the
 * IAM center (Principals, API tokens), where an administrator finds them within
 * what their role may touch.
 */
export default function TokensPage() {
  const t = useTranslations('navigation');
  const td = useTranslations('iamDirectory');
  const role = useDashboardUser()?.role;
  const canManageOthers = role === 'owner' || role === 'admin';

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Configure · API Tokens"
        title={t('tokens')}
        subtitle={t('tokensDescription')}
      />
      <Alert
        color="blue"
        variant="light"
        icon={<IconInfoCircle size={16} />}
        mb="md"
        data-testid="tokens-page-note"
        title={td('tokensPage.title')}
      >
        <Group justify="space-between" align="center" gap="md" wrap="wrap">
          <Text size="sm" style={{ flex: '1 1 320px', minWidth: 0 }}>
            {td('tokensPage.body')}
          </Text>
          {canManageOthers ? (
            <Button
              component={Link}
              href={iamHref('principals', { principalType: 'token' })}
              size="xs"
              variant="light"
              leftSection={<IconUsers size={14} />}
            >
              {td('tokensPage.manageAll')}
            </Button>
          ) : null}
        </Group>
      </Alert>
      <TokenManagement />
    </PageContainer>
  );
}
