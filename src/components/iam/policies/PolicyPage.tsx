'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Anchor, Button, Group, Loader, Stack } from '@mantine/core';
import { IconArrowLeft, IconPencil } from '@tabler/icons-react';
import PageContainer from '@/components/common/ui/PageContainer';
import { useTranslations } from '@/lib/i18n';
import { iamApi, IamApiError, type PolicyRow } from '../api';
import { iamHref, policyHref } from '../links';
import { useErrorText } from '../useErrorText';
import { useIamCapabilities } from '../useIamCapabilities';
import { useIamCatalog } from '../useIamCatalog';
import { useIamLabels } from '../useIamLabels';
import PolicyDetail from './PolicyDetail';

/** One policy on a page of its own (`/dashboard/iam/policies/<id>`); people who may change it get a link into the editor. */
export default function PolicyPage({ policyId }: { policyId: string }) {
  const t = useTranslations('iamCenter');
  const errorText = useErrorText();
  const { catalog } = useIamCatalog();
  const labels = useIamLabels(catalog);
  const { canManage } = useIamCapabilities();
  const [policy, setPolicy] = useState<PolicyRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setPolicy(null);
    setError(null);
    iamApi
      .getPolicy(policyId, controller.signal)
      .then((row) => {
        if (!controller.signal.aborted) setPolicy(row);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof IamApiError && err.status === 404
            ? t('policyPage.notFound')
            : errorText(err, t('policyPage.loadFailed')),
        );
      });
    return () => controller.abort();
  }, [policyId, t, errorText]);

  return (
    <PageContainer>
      <Stack gap="md" maw={900}>
        <Group justify="space-between" wrap="nowrap">
          <Anchor component={Link} href={iamHref('policies')} size="sm" data-testid="policy-back-to-list">
            <Group gap={4} wrap="nowrap">
              <IconArrowLeft size={14} />
              {t('policyPage.back')}
            </Group>
          </Anchor>
          {policy && canManage ? (
            <Button component={Link} href={policyHref(policy.policyId)} size="xs" leftSection={<IconPencil size={14} />}>
              {t('policyPage.edit')}
            </Button>
          ) : null}
        </Group>
        {error ? (
          <Alert color="red">{error}</Alert>
        ) : policy ? (
          <PolicyDetail policy={policy} labels={labels} />
        ) : (
          <Group justify="center" py="xl">
            <Loader size="sm" />
          </Group>
        )}
      </Stack>
    </PageContainer>
  );
}
