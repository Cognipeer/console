'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, Anchor, Badge, Button, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconExternalLink,
  IconInfoCircle,
  IconLock,
  IconShieldPlus,
  IconUser,
  IconX,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { iamApi, isAbortError, type IamLevel, type SimulateReason, type SimulateRequest, type SimulateResponse } from '../api';
import { iamHref, newPolicyHref, policyHref, portalHref } from '../links';
import { useProjects } from '../pickers/lookups';
import type { IamLabels } from '../useIamLabels';
import { hasProjectLimit, parseBuiltInReason, projectLimitFrom, reasonLink, type ReasonLink } from './reasonModel';

interface SimulateResultCardProps {
  request: SimulateRequest;
  result: SimulateResponse;
  labels: IamLabels;
  /** Display names for the sentence. */
  principalLabel: string;
  resourceLabel: string;
  canManage: boolean;
  /** The service the checked action belongs to, and the level it asks for (null for an unknown action). */
  service?: string | null;
  level?: 'read' | 'write' | 'admin' | null;
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

/** Everything a reason needs to be said in plain words. */
interface ReasonContext {
  who: { type: 'user' | 'token'; id: string };
  role: string;
  service: string | null;
  level: 'read' | 'write' | 'admin' | null;
  projectId: string | null;
  projectName: string | null;
  tokenScope: Record<string, string> | null;
  /** The limit the project sets on `service` for this member, once the server has said. */
  projectLimit: { level: IamLevel; projectName: string } | null;
  /** The portal the check is about, when it is one. */
  portalId: string | null;
  /** The answerers the agent was assumed to accept, for a check about a pending request. */
  approvers: 'owner' | 'owner_or_admin' | 'project_members' | null;
}

function ChangeLink({ link }: { link: ReasonLink }) {
  const t = useTranslations('iamCenter');
  return (
    <Anchor component={Link} href={link.href} size="xs" data-testid="reason-link">
      <Group gap={4} wrap="nowrap" component="span">
        {t(`result.change.${link.labelKey}`)}
        <IconExternalLink size={12} />
      </Group>
    </Anchor>
  );
}

function ReasonRow({ reason, labels, ctx }: { reason: SimulateReason; labels: IamLabels; ctx: ReasonContext }) {
  const t = useTranslations('iamCenter');
  const effectBadge = (
    <Badge size="sm" variant="light" color={reason.effect === 'forbid' ? 'red' : 'green'} style={{ flexShrink: 0 }}>
      {reason.effect === 'forbid' ? t('effects.forbid') : t('effects.permit')}
    </Badge>
  );
  const originBadge = (
    <Badge size="xs" variant="default" style={{ flexShrink: 0 }}>
      {reason.managed ? t('result.builtIn') : t('result.custom')}
    </Badge>
  );

  // A custom policy: its name, and a link to it.
  if (!reason.managed) {
    return (
      <Group gap="xs" wrap="wrap" justify="space-between" align="flex-start">
        <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: '1 1 220px' }}>
          {effectBadge}
          {reason.policyId ? (
            <Anchor component={Link} href={policyHref(reason.policyId)} size="sm">
              {reason.name}
            </Anchor>
          ) : (
            <Text size="sm">{reason.name}</Text>
          )}
        </Group>
        {originBadge}
      </Group>
    );
  }

  const built = parseBuiltInReason(reason.cedarId);
  const serviceName = ctx.service ? labels.service(ctx.service) : '';
  const levelWord = (value: string | null) => (value === 'none' ? t('result.noAccess') : value ? labels.level(value) : '');
  const required = levelWord(built.level ?? ctx.level);
  const role = labels.lookup(`iamPrincipals.roles.${ctx.role}`) ?? ctx.role;
  const project = ctx.projectLimit?.projectName || ctx.projectName || '';
  const link = reasonLink(built.kind, ctx.who, ctx.projectId, ctx.portalId);

  let title: string;
  let detail: string | null = null;
  switch (built.kind) {
    case 'role':
      title = t('result.reason.role', { role });
      detail = t('result.reason.roleDetail', { level: required, service: serviceName });
      break;
    case 'tokenOwner':
      title = t('result.reason.tokenOwner', { role });
      detail = t('result.reason.tokenOwnerDetail', { level: required, service: serviceName });
      break;
    case 'projectLimit': {
      const limit = ctx.projectLimit ? levelWord(ctx.projectLimit.level) : '';
      title = limit
        ? t('result.reason.projectLimit', { project, service: serviceName, limit })
        : t('result.reason.projectLimitUnknown', { project, service: serviceName });
      detail = limit
        ? t('result.reason.projectLimitDetail', { project, service: serviceName, limit, required })
        : t('result.reason.projectLimitDetailUnknown', { project, service: serviceName, required });
      break;
    }
    case 'tokenScope': {
      const limit = levelWord(ctx.service ? (ctx.tokenScope?.[ctx.service] ?? 'none') : 'none');
      title = t('result.reason.tokenScope', { service: serviceName, limit });
      detail = t('result.reason.tokenScopeDetail', { service: serviceName, limit, required });
      break;
    }
    case 'portalList':
      title = labels.managedName(reason.cedarId, reason.name);
      detail = t('result.portalReason.list');
      break;
    case 'portalBoundary':
      title = labels.managedName(reason.cedarId, reason.name);
      detail = t('result.portalReason.boundary');
      break;
    case 'approvalRule':
      title = labels.managedName(reason.cedarId, reason.name);
      detail = t('result.approvalReason.rule');
      break;
    default:
      title = labels.managedName(reason.cedarId, reason.name);
  }

  return (
    <Group gap="xs" wrap="wrap" justify="space-between" align="flex-start" data-testid="built-in-reason">
      <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: '1 1 220px' }}>
        {effectBadge}
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Group gap={4} wrap="nowrap" align="flex-start">
            <IconLock size={13} style={{ flexShrink: 0, marginTop: 3 }} />
            <Text size="sm" fw={500}>
              {title}
            </Text>
          </Group>
          {detail ? (
            <Text size="xs" c="dimmed">
              {detail}
            </Text>
          ) : null}
          {link ? <ChangeLink link={link} /> : null}
        </Stack>
      </Group>
      {originBadge}
    </Group>
  );
}

/** The exact limit a project sets, asked once when a project limit took part in the decision. */
function useProjectLimit(
  enabled: boolean,
  who: { type: 'user' | 'token'; id: string },
  projectId: string | null,
  service: string | null,
): ReasonContext['projectLimit'] {
  const [limit, setLimit] = useState<ReasonContext['projectLimit']>(null);
  useEffect(() => {
    setLimit(null);
    if (!enabled || !projectId || !service) return;
    const controller = new AbortController();
    iamApi
      .getPrincipal(who.type, who.id, projectId, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setLimit(projectLimitFrom(detail.effective, service));
      })
      .catch((error: unknown) => {
        // Without the exact level the reason still reads in full ("limits ... to less than ...").
        if (!isAbortError(error)) setLimit(null);
      });
    return () => controller.abort();
  }, [enabled, who.type, who.id, projectId, service]);
  return limit;
}

export default function SimulateResultCard({
  request,
  result,
  labels,
  principalLabel,
  resourceLabel,
  canManage,
  service = null,
  level = null,
}: SimulateResultCardProps) {
  const t = useTranslations('iamCenter');
  const { allowed, reasons, defaultDeny, principalSummary: ps, ownerSafety, errors, enforcedAtGate, portal } = result;
  const { projects } = useProjects();
  const projectName = result.projectId ? (projects.find((p) => p.id === result.projectId)?.name ?? result.projectId) : null;
  const principalType = request.principal.type;
  const who = useMemo(() => ({ type: principalType, id: request.principal.id }), [principalType, request.principal.id]);
  const projectLimit = useProjectLimit(hasProjectLimit(reasons), who, result.projectId, service);

  const ctx: ReasonContext = {
    who,
    role: ps.role,
    service,
    level,
    projectId: result.projectId,
    projectName,
    tokenScope: ps.tokenScope,
    projectLimit,
    portalId: result.portal?.id ?? null,
    approvers: result.session?.approvers ?? null,
  };
  const role = labels.lookup(`iamPrincipals.roles.${ps.role}`) ?? ps.role;
  const noRuleLink = principalType === 'user' ? reasonLink('role', who, result.projectId) : null;

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

        {/* A check about one resource is not what a real request meets: the gates decide whole services. */}
        {!enforcedAtGate ? (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
            {t('result.notEnforcedAtGate')}
          </Alert>
        ) : null}

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
            <Stack gap={8}>
              {reasons.map((r) => (
                <ReasonRow key={r.cedarId} reason={r} labels={labels} ctx={ctx} />
              ))}
            </Stack>
          ) : defaultDeny ? (
            <Alert color="gray" variant="light" data-testid="default-deny">
              <Stack gap={4} align="flex-start">
                <Text size="sm">
                  {request.action === 'agent.approve' && ctx.approvers
                    ? t('result.approvalReason.noRule', { approvers: t(`result.approvers.${ctx.approvers}`) })
                    : service && level
                      ? t(principalType === 'token' ? 'result.noRuleToken' : 'result.noRuleUser', {
                          role,
                          level: labels.level(level),
                          service: labels.service(service),
                        })
                      : t('result.defaultDeny')}
                </Text>
                {noRuleLink && service && level ? <ChangeLink link={noRuleLink} /> : null}
              </Stack>
            </Alert>
          ) : (
            <Text size="sm" c="dimmed">
              {t('result.noReasons')}
            </Text>
          )}
        </Section>

        {portal ? (
          <Section title={t('result.portalTitle')}>
            <Stack gap={4} data-testid="check-portal">
              <Group gap="xs">
                <Text size="sm" fw={600}>
                  {portal.name}
                </Text>
                {portal.status === 'disabled' ? (
                  <Badge size="xs" variant="light" color="orange">
                    {t('result.portalDisabled')}
                  </Badge>
                ) : null}
              </Group>
              <Text size="xs" c="dimmed">
                {portal.mode === 'all'
                  ? t('result.portalOpenAll')
                  : t('result.portalAudience', { users: portal.userCount, groups: portal.groupCount })}
              </Text>
              <ChangeLink link={{ labelKey: 'portal', href: portalHref(portal.id) }} />
            </Stack>
          </Section>
        ) : null}

        <Section title={t('result.principalTitle')}>
          <Stack gap={4}>
            <Group gap="xs">
              <Text size="sm" fw={600}>
                {ps.label || principalLabel}
              </Text>
              <Badge size="xs" variant="default">
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
                  Object.entries(ps.tokenScope).map(([scoped, scopedLevel]) => (
                    <Badge key={scoped} size="sm" variant="default">
                      {labels.service(scoped)} · {labels.level(scopedLevel)}
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
