'use client';

import { Alert, Badge, Button, Group, Loader, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle, IconArrowDown, IconArrowUp, IconEye } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { PreviewResponse } from '../api';
import type { IamLabels } from '../useIamLabels';
import classes from './policyEditor.module.css';

/** "Checked 24 of 3,000 people": the preview samples big audiences, and says so. */
export function coverageKind(principals: PreviewResponse['principals']): 'all' | 'sample' | 'everyone' | 'none' {
  if (principals.evaluated === 0) return 'none';
  if (principals.targeted === null) return 'everyone';
  return principals.evaluated < principals.targeted ? 'sample' : 'all';
}

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; data: PreviewResponse; stale: boolean }
  | { status: 'error'; message: string };

interface ImpactPanelProps {
  state: PreviewState;
  labels: IamLabels;
  canRun: boolean;
  onRun: () => void;
}

const MAX_ROWS = 50;

function Verdict({ allowed }: { allowed: boolean | null }) {
  const t = useTranslations('iamCenter');
  if (allowed === null) {
    return (
      <Badge variant="light" color="gray">
        {t('result.unknown')}
      </Badge>
    );
  }
  return (
    <Badge variant="light" color={allowed ? 'green' : 'red'}>
      {allowed ? t('result.allowed') : t('result.denied')}
    </Badge>
  );
}

/** "What would this policy change?": the flips between the current set and the set with the draft. */
export default function ImpactPanel({ state, labels, canRun, onRun }: ImpactPanelProps) {
  const t = useTranslations('iamCenter');

  return (
    <Stack gap="sm">
      <Group gap="sm">
        <Button
          variant="default"
          size="xs"
          leftSection={state.status === 'loading' ? <Loader size={12} /> : <IconEye size={14} />}
          disabled={!canRun || state.status === 'loading'}
          onClick={onRun}
        >
          {state.status === 'done' ? t('impact.rerun') : t('impact.run')}
        </Button>
        {!canRun ? (
          <Text size="xs" c="dimmed">
            {t('impact.completeFirst')}
          </Text>
        ) : null}
      </Group>

      {state.status === 'error' ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('impact.failed')}>
          {state.message}
        </Alert>
      ) : null}

      {state.status === 'done' ? (
        <Stack gap="sm">
          {state.stale ? (
            <Alert color="yellow" variant="light">
              {t('impact.stale')}
            </Alert>
          ) : null}
          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
            <div className="ds-card ds-card-pad-sm">
              <Group gap={6} wrap="nowrap">
                <IconArrowDown size={16} className={classes.flipDown} />
                <Text fw={700} size="lg">
                  {state.data.flips.allowToDeny.toLocaleString()}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                {t('impact.allowToDeny')}
              </Text>
            </div>
            <div className="ds-card ds-card-pad-sm">
              <Group gap={6} wrap="nowrap">
                <IconArrowUp size={16} className={classes.flipUp} />
                <Text fw={700} size="lg">
                  {state.data.flips.denyToAllow.toLocaleString()}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                {t('impact.denyToAllow')}
              </Text>
            </div>
          </SimpleGrid>

          <Text size="xs" c="dimmed">
            {t('impact.evaluated', { count: state.data.evaluated.toLocaleString() })}
            {state.data.truncated ? ` ${t('impact.truncated')}` : ''}
          </Text>
          {coverageKind(state.data.principals) !== 'none' ? (
            <Alert color={coverageKind(state.data.principals) === 'all' ? 'gray' : 'yellow'} variant="light" p="xs">
              <Text size="xs" data-testid="impact-coverage">
                {t(`impact.coverage.${coverageKind(state.data.principals)}`, {
                  evaluated: state.data.principals.evaluated.toLocaleString(),
                  targeted: (state.data.principals.targeted ?? 0).toLocaleString(),
                })}
              </Text>
            </Alert>
          ) : null}

          {state.data.flips.allowToDeny === 0 && state.data.flips.denyToAllow === 0 ? (
            <Alert color="green" variant="light">
              {t('impact.noChange')}
            </Alert>
          ) : null}

          {state.data.samples.length > 0 ? (
            <Table.ScrollContainer minWidth={520}>
              <Table verticalSpacing="xs" fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('impact.colWho')}</Table.Th>
                    <Table.Th>{t('impact.colAction')}</Table.Th>
                    <Table.Th>{t('impact.colResource')}</Table.Th>
                    <Table.Th>{t('impact.colBefore')}</Table.Th>
                    <Table.Th>{t('impact.colAfter')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {state.data.samples.slice(0, MAX_ROWS).map((sample, i) => {
                    const flipped = sample.before !== sample.after;
                    return (
                      <Table.Tr key={i} style={flipped ? { background: 'var(--ds-surface-1)' } : undefined}>
                        <Table.Td>
                          <Text size="xs" fw={500} truncate maw={180}>
                            {sample.principal.label || sample.principal.id}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {sample.principal.type === 'token' ? t('check.typeToken') : t('check.typeUser')}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">{labels.action(sample.action)}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" truncate maw={200}>
                            {labels.resource(sample.resource)}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Verdict allowed={sample.before} />
                        </Table.Td>
                        <Table.Td>
                          <Verdict allowed={sample.after} />
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          ) : null}
          {state.data.samples.length > MAX_ROWS ? (
            <Text size="xs" c="dimmed">
              {t('impact.showingFirst', { shown: MAX_ROWS, total: state.data.samples.length })}
            </Text>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
