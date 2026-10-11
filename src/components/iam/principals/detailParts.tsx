'use client';

/**
 * Small presentational pieces of the principal drawer: the section frame, the
 * badges under a name, the profile facts and the action button that explains
 * itself when it is disabled. Pure of data fetching.
 */

import type { ReactNode } from 'react';
import { Anchor, Badge, Button, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { AllowedAction, PrincipalExtras, PrincipalSummary } from './client';
import { formatDateTime, formatRelativeTime, translateOr, type Translate } from './format';
import { providerLabel } from './managed';
import { badgeVariant, principalColor, roleColor, statusColor } from './visuals';

const NS = 'iamPrincipals';

export function Section({
  title,
  hint,
  right,
  children,
  testId,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Paper withBorder p="md" radius="md" data-testid={testId}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
          <div style={{ minWidth: 0, flex: '1 1 200px' }}>
            <Text fw={600} size="sm">
              {title}
            </Text>
            {hint ? (
              <Text size="xs" c="dimmed">
                {hint}
              </Text>
            ) : null}
          </div>
          {right}
        </Group>
        {children}
      </Stack>
    </Paper>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return (
    <Text size="sm" c="dimmed">
      {children}
    </Text>
  );
}

/** A badge under a mantine-style min-width, so it never collapses to an ellipsis in a narrow cell. */
export const NO_SHRINK = { minWidth: 'max-content' } as const;

// ── identity ──────────────────────────────────────────────────────────────

/** The badges under the name: what kind of principal it is and what state it is in. */
export function IdentityBadges({
  summary,
  extras,
  t,
}: {
  summary: PrincipalSummary;
  extras: PrincipalExtras;
  t: Translate;
}) {
  const td = useTranslations('iamDirectory');
  const { type } = summary;
  const roleText = summary.role ? translateOr(t, NS, `roles.${summary.role}`, summary.role) : null;
  const statusText = summary.status ? translateOr(t, NS, `statuses.${summary.status}`, summary.status) : null;
  const provider = extras.authProvider && extras.authProvider !== 'local' ? extras.authProvider : null;
  const external = extras.kind === 'external' || summary.kind === 'external';
  const serviceAccount = !external && (extras.canLogin === false || summary.kind === 'service');
  const directoryUser = type === 'user' && (extras.managed?.directory === true || summary.managed === true);

  return (
    <Group gap={6} mt={6} wrap="wrap">
      {type !== 'user' ? (
        <Badge variant="light" color={principalColor(type)} radius="sm">
          {t(`types.${type}`)}
        </Badge>
      ) : null}
      {roleText && summary.role ? (
        <Badge variant={badgeVariant(roleColor(summary.role))} color={roleColor(summary.role)} radius="sm">
          {roleText}
        </Badge>
      ) : null}
      {statusText && summary.status ? (
        <Badge variant={badgeVariant(statusColor(summary.status))} color={statusColor(summary.status)} radius="sm">
          {statusText}
        </Badge>
      ) : null}
      {provider ? (
        <Badge
          variant="default"
          radius="sm"
          tt="none"
          leftSection={directoryUser ? <IconLock size={11} aria-hidden /> : undefined}
        >
          {translateOr(t, NS, `drawer.meta.authProvider.${provider}`, provider)}
        </Badge>
      ) : null}
      {external ? (
        <Tooltip label={td('badges.externalHint')} withArrow multiline w={280}>
          <Badge variant="light" color="grape" radius="sm" tt="none" data-testid="external-badge">
            {td('badges.kinds.external')}
          </Badge>
        </Tooltip>
      ) : null}
      {serviceAccount ? (
        <Tooltip label={t('drawer.meta.noLoginHint')} withArrow multiline w={260}>
          <Badge variant="default" radius="sm" tt="none">
            {t('drawer.meta.noLogin')}
          </Badge>
        </Tooltip>
      ) : null}
      {type === 'group' && extras.source && extras.source !== 'local' ? (
        <Badge variant="default" radius="sm" tt="none">
          {t('drawer.meta.directoryGroup')}
        </Badge>
      ) : null}
      {summary.memberCount !== null ? (
        <Badge variant="default" radius="sm" tt="none">
          {t('membersCount', { count: summary.memberCount.toLocaleString() })}
        </Badge>
      ) : null}
      {type === 'token' && extras.scoped !== null ? (
        <Tooltip
          label={extras.scoped ? t('drawer.meta.scopedHint') : t('drawer.meta.unscopedHint')}
          withArrow
          multiline
          w={260}
        >
          <Badge variant={extras.scoped ? 'light' : 'default'} color="orange" radius="sm" tt="none">
            {extras.scoped ? t('drawer.meta.scoped') : t('drawer.meta.unscoped')}
          </Badge>
        </Tooltip>
      ) : null}
      {type === 'token' && summary.ownerKind === 'service' ? (
        <Badge variant="default" radius="sm" tt="none">
          {td('badges.kinds.service')}
        </Badge>
      ) : null}
    </Group>
  );
}

/** Token facts and group grants, under the badges. */
export function IdentityFacts({
  summary,
  extras,
  locale,
  t,
  onOpen,
}: {
  summary: PrincipalSummary;
  extras: PrincipalExtras;
  locale: string;
  t: Translate;
  onOpen: (target: { type: 'user' | 'group' | 'token'; id: string }) => void;
}) {
  const td = useTranslations('iamDirectory');
  if (summary.type === 'token') {
    return (
      <Stack gap={2} mt={6}>
        {extras.ownerId ? (
          <Group gap={4} wrap="wrap">
            <Text size="xs" c="dimmed">
              {t('drawer.meta.owner')}
            </Text>
            <Anchor
              component="button"
              type="button"
              size="xs"
              onClick={() => onOpen({ type: 'user', id: extras.ownerId ?? '' })}
            >
              {extras.ownerLabel ?? extras.ownerId}
            </Anchor>
          </Group>
        ) : summary.ownerMissing ? (
          <Text size="xs" c="dimmed">
            {td('badges.ownerGone')}
          </Text>
        ) : null}
        {extras.projectName || extras.projectId ? (
          <Group gap={4} wrap="wrap">
            <Text size="xs" c="dimmed">
              {td('drawer.token.project')}
            </Text>
            <Text size="xs">{extras.projectName ?? extras.projectId}</Text>
          </Group>
        ) : null}
        <Text size="xs" c="dimmed">
          {extras.expiresAt
            ? t('drawer.meta.expires', { date: formatDateTime(extras.expiresAt, locale) })
            : t('drawer.meta.noExpiry')}
          {' · '}
          {extras.lastUsedAt
            ? t('drawer.meta.lastUsed', { when: formatRelativeTime(extras.lastUsedAt, { locale }) })
            : t('drawer.meta.neverUsed')}
        </Text>
      </Stack>
    );
  }
  if (summary.type === 'group' && extras.tenantRole) {
    return (
      <Text size="xs" c="dimmed" mt={6}>
        {t('drawer.meta.memberRole', { role: translateOr(t, NS, `roles.${extras.tenantRole}`, extras.tenantRole) })}
      </Text>
    );
  }
  return null;
}

/** The profile facts of a person: when they joined, how, and why they are disabled. */
export function PersonFacts({ extras, summary, locale }: { extras: PrincipalExtras; summary: PrincipalSummary; locale: string }) {
  const td = useTranslations('iamDirectory');
  const email = extras.email ?? summary.email ?? null;
  const rows: Array<[string, ReactNode]> = [];
  rows.push([td('drawer.facts.email'), email ?? td('drawer.facts.noEmail')]);
  const kind = extras.kind === 'external' || summary.kind === 'external' ? 'external' : extras.canLogin === false || summary.kind === 'service' ? 'service' : 'person';
  rows.push([td('drawer.facts.type'), td(`badges.kinds.${kind}`)]);
  rows.push([td('drawer.facts.source'), providerLabel(td, extras.authProvider ?? summary.authProvider ?? 'local')]);
  const created = extras.createdAt ?? summary.createdAt;
  if (created) rows.push([td('drawer.facts.created'), formatDateTime(created, locale)]);
  if (extras.invitedAt) rows.push([td('drawer.facts.invited'), formatDateTime(extras.invitedAt, locale)]);
  if (extras.inviteAcceptedAt) rows.push([td('drawer.facts.accepted'), formatDateTime(extras.inviteAcceptedAt, locale)]);
  else if (extras.pendingInvite) rows.push([td('drawer.facts.accepted'), td('drawer.facts.pending')]);
  if (extras.disabledAt) rows.push([td('drawer.facts.disabled'), formatDateTime(extras.disabledAt, locale)]);
  if (extras.disabledReason) rows.push([td('drawer.facts.disabledReason'), extras.disabledReason]);

  return (
    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px' }} data-testid="person-facts">
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>
            <Text size="xs" c="dimmed">
              {label}
            </Text>
          </dt>
          <dd style={{ margin: 0, minWidth: 0, wordBreak: 'break-word' }}>
            <Text size="sm" component="span">
              {value}
            </Text>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── actions ───────────────────────────────────────────────────────────────

/** Why an action can be unavailable (`iamDirectory.reasons.<reason>`); anything else reads as "forbidden". */
export const ACTION_DENIAL_REASONS = [
  'forbidden',
  'self',
  'owner_immutable',
  'higher_privileges',
  'directory_managed',
  'no_pending_invite',
  'account_disabled',
  'external_user',
] as const;

export function reasonKey(reason: string | undefined): string {
  return (ACTION_DENIAL_REASONS as readonly string[]).includes(reason ?? '') ? (reason as string) : 'forbidden';
}

interface ActionButtonProps {
  /** What the server said the viewer may do; `undefined` = no word from the server: the button is not shown. */
  action: AllowedAction | undefined;
  label: ReactNode;
  icon?: ReactNode;
  onClick: () => void;
  color?: string;
  variant?: 'default' | 'light' | 'filled' | 'subtle';
  /** Shown instead of nothing when the action is denied (`reasons.<code>`). */
  reasonText: (reason: string | undefined) => string;
  testId?: string;
}

/**
 * A button driven by the server's `allowedActions`: not shown when the server did
 * not say, disabled with the reason as a tooltip when the viewer may not.
 */
export function ActionButton({ action, label, icon, onClick, color, variant = 'default', reasonText, testId }: ActionButtonProps) {
  if (!action) return null;
  const button = (
    <Button
      size="xs"
      variant={variant}
      color={color}
      leftSection={icon}
      onClick={onClick}
      disabled={!action.allowed}
      data-testid={testId}
    >
      {label}
    </Button>
  );
  if (action.allowed) return button;
  return (
    <Tooltip label={reasonText(action.reason)} withArrow multiline w={260}>
      <span style={{ display: 'inline-flex' }}>{button}</span>
    </Tooltip>
  );
}
