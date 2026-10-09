'use client';

import { useMemo } from 'react';
import { Badge, Divider, Drawer, Group, Stack, Text } from '@mantine/core';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { PolicyRow } from '../api';
import { useProjects } from '../pickers/lookups';
import { useGroupLabels } from '../pickers/principalLabels';
import { formatDateTime } from '../timeFormat';
import type { IamLabels } from '../useIamLabels';
import CedarView from './CedarView';
import { EffectBadge, ModeBadge } from './PolicyBadges';
import { summarizeSpec } from './specModel';
import { describeSpec } from './specSummary';

interface PolicyDetailDrawerProps {
  policy: PolicyRow | null;
  labels: IamLabels;
  onClose: () => void;
}

function Line({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="sm">{value}</Text>
    </div>
  );
}

/** Read-only view of a policy, for people who can see the IAM center but not change it. */
export default function PolicyDetailDrawer({ policy, labels, onClose }: PolicyDetailDrawerProps) {
  const t = useTranslations('iamCenter');
  const locale = useLocale();
  const groupNames = useGroupLabels(policy?.spec ? summarizeSpec(policy.spec).groupIds.length > 0 : false);
  const { projects } = useProjects();

  const lines = useMemo(
    () =>
      policy?.spec
        ? describeSpec(policy.spec, {
            t,
            labels,
            groupNames,
            projectNames: new Map(projects.map((p) => [p.id, p.name])),
            maxNames: 8,
            formatDate: (iso) => formatDateTime(iso, locale),
          })
        : null,
    [policy, t, labels, groupNames, projects, locale],
  );

  return (
    <Drawer
      opened={!!policy}
      onClose={onClose}
      position="right"
      size="lg"
      title={<Text fw={600}>{policy?.name ?? ''}</Text>}
    >
      {policy ? (
        <Stack gap="md">
          <Group gap="xs">
            <EffectBadge effect={policy.effect} labels={labels} />
            <ModeBadge mode={policy.mode} labels={labels} />
            <Badge variant="light" color={policy.enabled ? 'teal' : 'gray'}>
              {policy.enabled ? t('editor.active') : t('editor.inactive')}
            </Badge>
            {!policy.spec ? (
              <Badge variant="outline" color="gray">
                Cedar
              </Badge>
            ) : null}
          </Group>

          {policy.description ? <Text size="sm">{policy.description}</Text> : null}

          {lines ? (
            <Stack gap="sm">
              <Line label={t('summary.who')} value={lines.who} />
              <Line label={t('summary.what')} value={lines.what} />
              <Line label={t('summary.where')} value={lines.where} />
              <Line label={t('summary.when')} value={lines.when} />
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">
              {t('table.rawCedar', { count: policy.statementCount })}
            </Text>
          )}

          {policy.monitorStats ? (
            <>
              <Divider />
              <Stack gap={4}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  {t('table.colMonitor')}
                </Text>
                <Group gap="xs">
                  <Badge color="green" variant="light">
                    {t('table.wouldAllow', { count: policy.monitorStats.wouldAllow.toLocaleString() })}
                  </Badge>
                  <Badge color="red" variant="light">
                    {t('table.wouldDeny', { count: policy.monitorStats.wouldDeny.toLocaleString() })}
                  </Badge>
                </Group>
                {policy.monitorStats.since ? (
                  <Text size="xs" c="dimmed">
                    {t('table.monitorSince', { date: formatDateTime(policy.monitorStats.since, locale) })}
                  </Text>
                ) : null}
              </Stack>
            </>
          ) : null}

          <Divider />
          <CedarView code={policy.cedar} maxHeight={360} />

          <Text size="xs" c="dimmed">
            {t('drawer.meta', {
              created: formatDateTime(policy.createdAt, locale),
              updated: formatDateTime(policy.updatedAt, locale),
              by: policy.updatedByLabel || policy.updatedBy || '—',
            })}
          </Text>
        </Stack>
      ) : null}
    </Drawer>
  );
}
