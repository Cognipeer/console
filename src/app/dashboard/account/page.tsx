'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Button, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconKey } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { requestJson } from '@/components/account/accountApi';
import { parseMe, type AccountMe } from '@/components/account/accountModel';
import EnterpriseAccountSections from '@/components/account/EnterpriseAccountSections';
import PasswordCard from '@/components/account/PasswordCard';
import ProfileCard from '@/components/account/ProfileCard';
import { TOKENS_HREF } from '@/components/iam/links';
import { useTranslations } from '@/lib/i18n';

/**
 * "My account": every signed-in person's own page, outside the IAM center -
 * their profile, their password (local accounts) and a way to their personal API
 * tokens. Reached from the account menu in the top bar.
 */
export default function AccountPage() {
  const t = useTranslations('accountPage');
  const router = useRouter();
  const [me, setMe] = useState<AccountMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setFailed(false);
    try {
      const parsed = parseMe(await requestJson('GET', '/api/auth/me', undefined, signal));
      if (signal?.aborted) return;
      setMe(parsed);
      setFailed(parsed === null);
    } catch {
      if (!signal?.aborted) setFailed(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <PageContainer>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} subtitle={t('subtitle')} />
      {loading && !me ? (
        <Group justify="center" py="xl" role="status" aria-label={t('loading')}>
          <Loader size="sm" />
        </Group>
      ) : failed || !me ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('loadFailed')}>
          <Button size="xs" variant="light" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </Alert>
      ) : (
        <Stack gap="md" maw={760}>
          <ProfileCard
            me={me}
            onSaved={() => {
              void load();
              // the name in the top bar comes from the server layout
              router.refresh();
            }}
          />
          <PasswordCard me={me} />
          <Paper withBorder p="lg" radius="md" data-testid="tokens-card">
            <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
              <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                <Text fw={600}>{t('tokens.title')}</Text>
                <Text size="sm" c="dimmed">
                  {t('tokens.body')}
                </Text>
              </div>
              <Button component={Link} href={TOKENS_HREF} variant="light" leftSection={<IconKey size={14} />}>
                {t('tokens.open')}
              </Button>
            </Group>
          </Paper>
          <EnterpriseAccountSections />
        </Stack>
      )}
    </PageContainer>
  );
}
