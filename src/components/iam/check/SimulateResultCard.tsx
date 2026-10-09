'use client';

import Link from 'next/link';
import { Alert, Anchor, Badge, Button, Group, Paper, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconInfoCircle,
  IconLock,
  IconShieldPlus,
  IconUser,
  IconX,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { SimulateReason, SimulateRequest, SimulateResponse } from '../api';
import { iamHref, newPolicyHref, policyHref } from '../links';
import { useProjects } from '../pickers/lookups';
import type { IamLabels } from '../useIamLabels';

interface SimulateResultCardProps {
  request: SimulateRequest;
  result: SimulateResponse;
  labels: IamLabels;
  /** Display names for the sentence. */
  principalLabel: string;
  resourceLabel: string;
  canManage: boolean;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack gap={6}>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">
        {title}
      </Text>
      {children}
    </Stack>
  );
}

function VerdictBadge({ allowed }: { allowed: boolean }) {
  const t = useTranslations('iamCenter');
  return (
    <Badge variant="light" color={allowed ? 'green' : 'red'}>
      {allowed ? t('result.allowed') : t('result.denied')}
    </Badge>
  );
}

function ReasonRow({ reason, labels }: { reason: SimulateReason; labels: IamLabels }) {
  const t = useTranslations('iamCenter');
  const name = reason.managed ? labels.managedName(reason.cedarId, reason.name) : reason.name;
  return (
    <Group gap="xs" wrap="wrap" justify="space-between" align="flex-start">
      <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: '1 1 220px' }}>
        <Badge size="sm" variant="light" color={reason.effect === 'forbid' ? 'red' : 'green'} style={{ flexShrink: 0 }}>
          {reason.effect === 'forbid' ? t('effects.forbid') : t('effects.permit')}
        </Badge>
        {reason.managed ? (
          <Tooltip label={reason.cedarId}>
            <Group gap={4} wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
              <IconLock size={13} style={{ flexShrink: 0, marginTop: 3 }} />
              <Text size="sm">{name}</Text>
            </Group>
          </Tooltip>
        ) : reason.policyId ? (
          <Anchor component={Link} href={policyHref(reason.policyId)} size="sm">
            {name}
          </Anchor>
        ) : (
          <Text size="sm">{name}</Text>
        )}
      </Group>
      <Badge size="xs" variant="outline" color="gray" style={{ flexShrink: 0 }}>
        {reason.managed ? t('result.builtIn') : t('result.custom')}
      </Badge>
    </Group>
  );
}

export default function SimulateResultCard({
  request,
  result,
  labels,
  principalLabel,
  resourceLabel,
  canManage,
}: SimulateResultCardProps) {
  const t = useTranslations('iamCenter');
  const { allowed, reasons, defaultDeny, monitor, legacy, principalSummary: ps, mode, ownerSafety, errors, enforcedAtGate } = result;
  const { projects } = useProjects();
  const projectName = result.projectId ? (projects.find((p) => p.id === result.projectId)?.name ?? result.projectId) : null;
  const principalType = request.principal.type;

  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="md">
        <Group gap="md" wrap="nowrap" align="flex-start">
          <ThemeIcon size={46} radius="xl" variant="light" color={allowed ? 'green' : 'red'}>
            {allowed ? <IconCheck size={26} /> : <IconX size={26} />}
          </ThemeIcon>
          <div style={{ minWidth: 0 }}>
            <Text fw={700} size="xl" c={allowed ? 'green' : 'red'}>
              {allowed ? t('result.allowed') : t('result.denied')}
            </Text>
            <Text size="sm" c="dimmed">
              {t('result.sentence', {
                principal: principalLabel,
                action: labels.action(request.action),
                resource: resourceLabel,
              })}
            </Text>
          </div>
        </Group>

        <Alert
          color={mode === 'enforce' && enforcedAtGate ? 'blue' : 'yellow'}
          variant="light"
          icon={<IconInfoCircle size={16} />}
          title={t('result.engineMode', { mode: labels.authzMode(mode) })}
        >
          {/* A check about one resource is not what a real request meets: the gates decide whole services. */}
          {enforcedAtGate ? t(`result.modeNote.${mode}`) : t('result.notEnforcedAtGate')}
        </Alert>

        <Text size="xs" c="dimmed" data-testid="check-project">
          {projectName ? t('result.projectApplied', { project: projectName }) : t('result.noProject')}
        </Text>

        {ownerSafety ? (
          <Alert color="teal" variant="light" icon={<IconLock size={16} />}>
            {t('result.ownerSafety')}
          </Alert>
        ) : null}

        <Section title={t('result.decidedBy')}>
          {reasons.length > 0 ? (
            <Stack gap={6}>
              {reasons.map((r) => (
                <ReasonRow key={r.cedarId} reason={r} labels={labels} />
              ))}
            </Stack>
          ) : defaultDeny ? (
            <Alert color="gray" variant="light">
              {t('result.defaultDeny')}
            </Alert>
          ) : (
            <Text size="sm" c="dimmed">
              {t('result.noReasons')}
            </Text>
          )}
        </Section>

        {monitor ? (
          <Section title={t('result.monitorTitle')}>
            {monitor.differs ? (
              <Alert color="yellow" variant="light">
                <Stack gap={6}>
                  <Group gap="xs">
                    <Text size="sm">{t('result.monitorDiffers')}</Text>
                    <VerdictBadge allowed={monitor.allowed} />
                  </Group>
                  {monitor.reasons.map((r) => (
                    <ReasonRow key={r.cedarId} reason={r} labels={labels} />
                  ))}
                </Stack>
              </Alert>
            ) : (
              <Text size="sm" c="dimmed">
                {t('result.monitorSame')}
              </Text>
            )}
          </Section>
        ) : null}

        {legacy ? (
          <Section title={t('result.legacyTitle')}>
            <Group gap="xs">
              <VerdictBadge allowed={legacy.allowed} />
              <Text size="sm" c="dimmed">
                {t('result.legacyRequires', {
                  level: labels.level(legacy.required),
                  service: labels.service(legacy.service),
                })}
              </Text>
            </Group>
            {legacy.allowed !== allowed ? (
              <Alert color="orange" variant="light">
                {t('result.legacyDiffers')}
              </Alert>
            ) : null}
          </Section>
        ) : null}

        <Section title={t('result.principalTitle')}>
          <Stack gap={4}>
            <Group gap="xs">
              <Text size="sm" fw={600}>
                {ps.label || principalLabel}
              </Text>
              <Badge size="xs" variant="outline" color="gray">
                {principalType === 'token' ? t('result.typeToken') : t('result.typeUser')}
              </Badge>
              {ps.role && !(principalType === 'user' && ps.role === 'user') ? (
                <Badge size="xs" variant="light" color="gray">
                  {ps.role}
                </Badge>
              ) : null}
              {ps.status === 'disabled' ? (
                <Badge size="xs" variant="light" color="orange">
                  {t('result.disabledAccount')}
                </Badge>
              ) : null}
            </Group>
            <Group gap={6}>
              <Text size="xs" c="dimmed">
                {t('result.groups')}:
              </Text>
              {ps.groups.length > 0 ? (
                ps.groups.map((g) => (
                  <Badge key={g.id} size="sm" variant="light">
                    {g.name}
                  </Badge>
                ))
              ) : (
                <Text size="xs" c="dimmed">
                  {t('result.noGroups')}
                </Text>
              )}
            </Group>
            {principalType === 'token' ? (
              <Group gap={6}>
                <Text size="xs" c="dimmed">
                  {t('result.tokenScope')}:
                </Text>
                {ps.tokenScope === null ? (
                  <Text size="xs" c="dimmed">
                    {t('result.tokenUnscoped')}
                  </Text>
                ) : Object.keys(ps.tokenScope).length === 0 ? (
                  <Text size="xs" c="dimmed">
                    {t('result.tokenEmptyScope')}
                  </Text>
                ) : (
                  Object.entries(ps.tokenScope).map(([service, level]) => (
                    <Badge key={service} size="sm" variant="outline">
                      {labels.service(service)} · {labels.level(level)}
                    </Badge>
                  ))
                )}
              </Group>
            ) : null}
          </Stack>
        </Section>

        {errors.length > 0 ? (
          <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} title={t('result.engineErrors')}>
            <Stack gap={2}>
              {errors.map((message, i) => (
                <Text key={i} size="xs" ff="monospace">
                  {message}
                </Text>
              ))}
            </Stack>
          </Alert>
        ) : null}

        <Group gap="xs">
          <Button
            component={Link}
            href={iamHref('principals', { principalType, principalId: request.principal.id })}
            size="xs"
            variant="default"
            leftSection={<IconUser size={14} />}
            rightSection={<IconArrowRight size={12} />}
          >
            {t('result.viewPrincipal')}
          </Button>
          {canManage ? (
            <Button
              component={Link}
              href={newPolicyHref({ principalType, principalId: request.principal.id })}
              size="xs"
              variant="default"
              leftSection={<IconShieldPlus size={14} />}
            >
              {t('result.createPolicy')}
            </Button>
          ) : null}
        </Group>
      </Stack>
    </Paper>
  );
}
