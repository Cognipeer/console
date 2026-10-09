'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { IconAlertCircle, IconChecklist, IconShieldPlus } from '@tabler/icons-react';
import { IamApiError, iamApi, isAbortError, type PrincipalDetail } from '@/components/iam/api';
import { checkHref, newPolicyHref, policyHref } from '@/components/iam/links';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import { useTranslations } from '@/lib/i18n';
import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';

const SERVICE_LABEL = new Map<string, string>(RBAC_SERVICE_DEFINITIONS.map((s) => [s.id, s.label]));

const LEVEL_COLOR: Record<string, string> = { read: 'blue', write: 'orange', admin: 'red' };

/** Rows shown before "Show all": an owner's token reaches every service, which is a wall of identical lines. */
const COLLAPSED_ROWS = 8;

/**
 * What an API token can actually do, as the authorization engine computes it:
 * the effective permission per service with the reasons behind it (owner role,
 * the token's own scope, group grants, project limits, policies), the custom
 * policies that apply to it, and the two shortcuts into the IAM center
 * (simulate a request / write a policy for this token).
 *
 * Needs the `iam` read permission; without it the section says so instead of
 * failing. Everything here is read-only.
 */
export default function TokenAccessSection({ tokenId }: { tokenId: string }) {
  const t = useTranslations('iamTokens');
  const user = useDashboardUser();
  const canWritePolicies = user?.role === 'owner' || user?.role === 'admin';

  const [detail, setDetail] = useState<PrincipalDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    setDetail(null);
    setExpanded(false);
    iamApi
      .getPrincipal('token', tokenId, undefined, controller.signal)
      .then((result) => {
        setDetail(result);
        setState('ready');
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setState(error instanceof IamApiError && (error.status === 403 || error.status === 401) ? 'forbidden' : 'failed');
      });
    return () => controller.abort();
  }, [tokenId]);

  const rows = useMemo(() => {
    if (!detail) return [];
    return detail.effective
      .filter((entry) => entry.level !== 'none')
      .map((entry) => ({ ...entry, label: SERVICE_LABEL.get(entry.service) ?? entry.service }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [detail]);

  const levelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.level, (counts.get(row.level) ?? 0) + 1);
    return ['admin', 'write', 'read'].filter((level) => counts.has(level)).map((level) => ({ level, count: counts.get(level) ?? 0 }));
  }, [rows]);

  if (state === 'loading') {
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          {t('access.loading')}
        </Text>
      </Group>
    );
  }

  if (state === 'forbidden' || state === 'failed') {
    return (
      <Alert color={state === 'forbidden' ? 'gray' : 'red'} variant="light" icon={<IconAlertCircle size={16} />}>
        <Text size="sm">{state === 'forbidden' ? t('access.forbidden') : t('access.failed')}</Text>
      </Alert>
    );
  }

  const policies = detail?.policies ?? [];

  return (
    <Stack gap="md">
      <Stack gap={6}>
        <Text size="sm" fw={600}>
          {t('access.effectiveTitle')}
        </Text>
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('access.noAccess')}
          </Text>
        ) : null}

        {rows.length > 0 ? (
          <Group gap={6}>
            <Text size="xs" c="dimmed">
              {t('access.summary', { count: rows.length })}
            </Text>
            {levelCounts.map(({ level, count }) => (
              <Badge key={level} size="xs" variant="light" color={LEVEL_COLOR[level] ?? 'gray'}>
                {`${t(`levels.${level}`)} · ${count}`}
              </Badge>
            ))}
          </Group>
        ) : null}

        {rows.length > 0 ? (
          <Table.ScrollContainer minWidth={420}>
            <Table verticalSpacing={6} fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('access.service')}</Table.Th>
                  <Table.Th>{t('access.level')}</Table.Th>
                  <Table.Th>{t('access.because')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(expanded ? rows : rows.slice(0, COLLAPSED_ROWS)).map((row) => (
                  <Table.Tr key={row.service}>
                    <Table.Td>{row.label}</Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light" color={LEVEL_COLOR[row.level] ?? 'gray'}>
                        {t(`levels.${row.level}`)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {row.sources.map((source, index) => (
                          <Badge key={`${source.kind}:${source.label}:${index}`} size="xs" variant="outline" color="gray" tt="none">
                            {`${t(`access.sourceKind.${source.kind}`)}: ${source.label}`}
                          </Badge>
                        ))}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : null}

        {rows.length > COLLAPSED_ROWS ? (
          <div>
            <Button size="compact-xs" variant="subtle" onClick={() => setExpanded((open) => !open)}>
              {expanded ? t('access.showFewer') : t('access.showAll', { count: rows.length })}
            </Button>
          </div>
        ) : null}
      </Stack>

      <Stack gap={6}>
        <Text size="sm" fw={600}>
          {t('access.policiesTitle')}
        </Text>
        {policies.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('access.noPolicies')}
          </Text>
        ) : (
          <Stack gap={4}>
            {policies.map((policy) => (
              <Group key={policy.policyId} gap="xs" wrap="nowrap">
                <Link href={policyHref(policy.policyId)} style={{ fontSize: 13 }}>
                  {policy.name}
                </Link>
                <Badge size="xs" variant="light" color={policy.effect === 'forbid' ? 'red' : policy.effect === 'permit' ? 'teal' : 'gray'}>
                  {t(`access.effect.${policy.effect}`)}
                </Badge>
                <Badge size="xs" variant="outline" color="gray">
                  {t(`access.mode.${policy.mode}`)}
                </Badge>
                {!policy.enabled ? (
                  <Badge size="xs" variant="outline" color="gray">
                    {t('access.disabled')}
                  </Badge>
                ) : null}
              </Group>
            ))}
          </Stack>
        )}
      </Stack>

      <Group gap="xs">
        <Button
          component={Link}
          href={checkHref({ principalType: 'token', principalId: tokenId })}
          size="xs"
          variant="default"
          leftSection={<IconChecklist size={14} />}
        >
          {t('access.simulate')}
        </Button>
        {canWritePolicies ? (
          <Button
            component={Link}
            href={newPolicyHref({ principalType: 'token', principalId: tokenId })}
            size="xs"
            variant="default"
            leftSection={<IconShieldPlus size={14} />}
          >
            {t('access.createPolicy')}
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
