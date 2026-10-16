'use client';

/**
 * The membership and token sections of a person's drawer: the groups they are
 * in, the projects they reach (and how), and the API tokens they own. Pure
 * markup over the loaded detail; every change is a callback.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ActionIcon, Badge, Button, Group, Loader, Menu, Stack, Table, Text, Tooltip } from '@mantine/core';
import {
  IconDots,
  IconExternalLink,
  IconLock,
  IconPlus,
  IconShieldCheck,
  IconTrash,
  IconUsersGroup,
  IconX,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import { directoryApi, type PersonActivityView } from './directoryApi';
import {
  iamLinks,
  ownedTokenSummary,
  type AllowedAction,
  type GroupRef,
  type OwnedToken,
  type PrincipalTarget,
  type ProjectRef,
} from './client';
import { Muted } from './detailParts';
import { membershipSource, roleEditable } from './projectGrantModel';
import { providerLabel } from './managed';
import { formatDateTime, formatRelativeTime, translateOr, type Translate } from './format';
import styles from './PrincipalDetail.module.css';
import { badgeVariant, statusColor } from './visuals';

const NS = 'iamPrincipals';
/** More projects than this are folded behind "Show all". */
export const PROJECTS_SHOWN = 8;

// ── groups ────────────────────────────────────────────────────────────────

export function GroupsSection({
  groups,
  manage,
  t,
  onOpen,
  onAdd,
  onRemove,
  reasonText,
}: {
  groups: GroupRef[];
  /** The viewer's `manageGroups` action; undefined = read-only. */
  manage?: AllowedAction;
  t: Translate;
  onOpen: (target: PrincipalTarget) => void;
  onAdd?: () => void;
  onRemove?: (group: GroupRef) => void;
  reasonText: (reason: string | undefined) => string;
}) {
  const td = useTranslations('iamDirectory');
  const canEdit = manage?.allowed === true;
  return (
    <Stack gap="xs">
      {groups.length === 0 ? (
        <Muted>{t('drawer.groups.empty')}</Muted>
      ) : (
        <Group gap="xs" wrap="wrap">
          {groups.map((g) => {
            // A directory group's membership is the directory's; a local one can be left from here.
            const removable = canEdit && onRemove && (g.removable ?? (g.source ?? 'local') === 'local');
            return (
              <Group key={g.id} gap={2} wrap="nowrap" data-testid="group-chip">
                <Button
                  size="compact-sm"
                  variant="light"
                  color="teal"
                  leftSection={<IconUsersGroup size={14} />}
                  rightSection={g.source && g.source !== 'local' ? (
                    <Tooltip label={td('managed.groupHint', { source: providerLabel(td, g.source) })} withArrow>
                      <span style={{ display: 'inline-flex' }} data-testid="group-chip-managed">
                        <IconLock size={11} aria-label={td('managed.groupHint', { source: providerLabel(td, g.source) })} />
                      </span>
                    </Tooltip>
                  ) : undefined}
                  onClick={() => onOpen({ type: 'group', id: g.id })}
                >
                  {g.name}
                </Button>
                {removable ? (
                  <Tooltip label={td('drawer.groups.remove', { name: g.name })} withArrow>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      aria-label={td('drawer.groups.remove', { name: g.name })}
                      onClick={() => onRemove(g)}
                    >
                      <IconX size={13} />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
              </Group>
            );
          })}
        </Group>
      )}
      {manage && onAdd ? (
        <div>
          {canEdit ? (
            <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} onClick={onAdd}>
              {td('drawer.groups.add')}
            </Button>
          ) : (
            <Tooltip label={reasonText(manage.reason)} withArrow multiline w={260}>
              <span style={{ display: 'inline-flex' }}>
                <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} disabled>
                  {td('drawer.groups.add')}
                </Button>
              </span>
            </Tooltip>
          )}
        </div>
      ) : null}
    </Stack>
  );
}

// ── projects ──────────────────────────────────────────────────────────────

export interface ProjectRowHandlers {
  onSetRole: (project: ProjectRef, role: 'member' | 'project_admin') => void;
  onEditAccess: (project: ProjectRef) => void;
  onRemove: (project: ProjectRef) => void;
}

function isDirect(project: ProjectRef): boolean {
  return project.removable ?? (project.via === 'direct' || project.via === 'legacy');
}

function ProjectRow({
  project,
  t,
  handlers,
}: {
  project: ProjectRef;
  t: Translate;
  handlers?: ProjectRowHandlers;
}) {
  const td = useTranslations('iamDirectory');
  const source = membershipSource(project);
  const groupLabel = source.groupName ?? td('drawer.projects.source.groupUnnamed');
  const roleLabel = project.role ? translateOr(t, NS, `drawer.projects.role.${project.role}`, project.role) : null;
  const editable = Boolean(handlers) && isDirect(project);
  return (
    <div className={styles.listRow} data-testid="project-row">
      <div style={{ minWidth: 0 }}>
        <Text size="sm" fw={500} style={{ wordBreak: 'break-word' }}>
          {project.name}
        </Text>
        <Text size="xs" c="dimmed" data-testid="project-source">
          {td('drawer.projects.sourceLabel')}
          {': '}
          {source.kind === 'group' ? (
            source.groupId ? (
              <Link href={iamLinks.principal('group', source.groupId)} style={{ color: 'inherit' }}>
                {td('drawer.projects.source.group', { name: groupLabel })}
              </Link>
            ) : (
              td('drawer.projects.source.group', { name: groupLabel })
            )
          ) : (
            td(`drawer.projects.source.${source.kind}`)
          )}
        </Text>
      </div>
      <Group gap={6} wrap="nowrap">
        {roleLabel ? (
          <Tooltip label={td('drawer.projects.roleManagedInGroup')} withArrow disabled={roleEditable(source)}>
            <Badge size="sm" variant="default" tt="none">
              {roleLabel}
            </Badge>
          </Tooltip>
        ) : null}
        {editable && handlers ? (
          <Menu withinPortal position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label={td('drawer.projects.actions', { name: project.name })}>
                <IconDots size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{td('drawer.projects.roleLabel')}</Menu.Label>
              <Menu.Item
                disabled={project.role === 'member'}
                onClick={() => handlers.onSetRole(project, 'member')}
              >
                {t('drawer.projects.role.member')}
              </Menu.Item>
              <Menu.Item
                disabled={project.role === 'project_admin'}
                onClick={() => handlers.onSetRole(project, 'project_admin')}
              >
                {t('drawer.projects.role.project_admin')}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item leftSection={<IconShieldCheck size={14} />} onClick={() => handlers.onEditAccess(project)}>
                {td('drawer.projects.limits')}
              </Menu.Item>
              <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => handlers.onRemove(project)}>
                {td('drawer.projects.remove')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        ) : null}
      </Group>
    </div>
  );
}

export function ProjectsSection({
  projects,
  manage,
  addable,
  t,
  handlers,
  onAdd,
  reasonText,
  external = false,
}: {
  /** An external account never joins a project (its access is the token's project and policies). */
  external?: boolean;
  projects: ProjectRef[];
  /** The viewer's `manageProjects` action; undefined = read-only. */
  manage?: AllowedAction;
  /** Owners and admins reach every project: nothing to add. */
  addable: boolean;
  t: Translate;
  handlers?: ProjectRowHandlers;
  onAdd?: () => void;
  reasonText: (reason: string | undefined) => string;
}) {
  const td = useTranslations('iamDirectory');
  const [all, setAll] = useState(false);
  const shown = all ? projects : projects.slice(0, PROJECTS_SHOWN);
  const canEdit = manage?.allowed === true;
  return (
    <Stack gap="xs" align="stretch">
      {projects.length === 0 ? (
        <Muted>{t('drawer.projects.empty')}</Muted>
      ) : (
        <>
          <div className={styles.bordered}>
            {shown.map((p) => (
              <ProjectRow key={p.id} project={p} t={t} handlers={canEdit ? handlers : undefined} />
            ))}
          </div>
          {projects.length > PROJECTS_SHOWN ? (
            <Button size="compact-xs" variant="subtle" style={{ alignSelf: 'flex-start' }} onClick={() => setAll((v) => !v)}>
              {all ? t('drawer.projects.showFewer') : t('drawer.projects.showAll', { count: projects.length })}
            </Button>
          ) : null}
        </>
      )}
      {external ? (
        <Muted>{td('drawer.projects.externalNote')}</Muted>
      ) : manage && onAdd && addable ? (
        <div>
          {canEdit ? (
            <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} onClick={onAdd}>
              {td('drawer.projects.add')}
            </Button>
          ) : (
            <Tooltip label={reasonText(manage.reason)} withArrow multiline w={260}>
              <span style={{ display: 'inline-flex' }}>
                <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} disabled>
                  {td('drawer.projects.add')}
                </Button>
              </span>
            </Tooltip>
          )}
        </div>
      ) : null}
    </Stack>
  );
}

// ── tokens of a person ────────────────────────────────────────────────────

export function UserTokensSection({
  ownerId,
  tokens,
  hidden,
  truncated,
  total,
  mint,
  revoke,
  locale,
  t,
  onOpen,
  onNew,
  onRevoke,
  reasonText,
}: {
  ownerId: string;
  tokens: OwnedToken[];
  /** The viewer may not see this person's tokens. */
  hidden: boolean;
  truncated: boolean;
  total: number | null;
  /** The viewer's `mintToken` / `revokeTokens` actions; undefined = read-only. */
  mint?: AllowedAction;
  revoke?: AllowedAction;
  locale: string;
  t: Translate;
  onOpen: (target: PrincipalTarget) => void;
  onNew?: () => void;
  onRevoke?: (token: OwnedToken) => void;
  reasonText: (reason: string | undefined) => string;
}) {
  const td = useTranslations('iamDirectory');
  if (hidden) {
    return (
      <Group gap="xs" wrap="nowrap" align="flex-start" data-testid="tokens-hidden">
        <IconLock size={16} aria-hidden />
        <Muted>{td('drawer.tokens.hidden')}</Muted>
      </Group>
    );
  }
  const canRevoke = revoke?.allowed === true;
  return (
    <Stack gap="xs">
      {tokens.length === 0 ? (
        <Muted>{t('drawer.tokens.empty')}</Muted>
      ) : (
        <div className={styles.bordered}>
          {tokens.map((token) => (
            <div key={token.id} className={styles.listRow} data-testid="owned-token">
              <button
                type="button"
                className={styles.listRowButton}
                style={{ flex: 1, minWidth: 0, textAlign: 'left', padding: 0, background: 'transparent', border: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' }}
                onClick={() => onOpen({ type: 'token', id: token.id, summary: ownedTokenSummary(token) })}
              >
                <Text size="sm" fw={500} style={{ wordBreak: 'break-word' }}>
                  {token.label}
                </Text>
                {token.prefix ? (
                  <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>
                    {token.prefix}…
                  </Text>
                ) : null}
                <Text size="xs" c="dimmed">
                  {token.lastUsedAt
                    ? t('drawer.meta.lastUsed', { when: formatRelativeTime(token.lastUsedAt, { locale }) })
                    : t('drawer.meta.neverUsed')}
                  {token.expiresAt ? ` · ${t('drawer.meta.expires', { date: formatDateTime(token.expiresAt, locale) })}` : ''}
                </Text>
              </button>
              <Group gap={6} wrap="nowrap" align="flex-start">
                {token.status ? (
                  <Badge size="sm" variant={badgeVariant(statusColor(token.status))} color={statusColor(token.status)}>
                    {translateOr(t, NS, `statuses.${token.status}`, token.status)}
                  </Badge>
                ) : null}
                <Badge size="sm" variant={token.scoped ? 'light' : 'default'} color="orange" tt="none">
                  {token.scoped ? t('drawer.meta.scoped') : t('drawer.meta.unscoped')}
                </Badge>
                {canRevoke && onRevoke ? (
                  <Tooltip label={td('drawer.tokens.revoke')} withArrow>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      aria-label={td('drawer.tokens.revokeNamed', { label: token.label })}
                      onClick={() => onRevoke(token)}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
              </Group>
            </div>
          ))}
        </div>
      )}
      {truncated ? (
        <Group gap={6}>
          <Text size="xs" c="dimmed">
            {total !== null
              ? td('drawer.tokens.truncatedOf', { shown: tokens.length, total })
              : td('drawer.tokens.truncated', { shown: tokens.length })}
          </Text>
          <Button
            component={Link}
            href={iamLinks.tokensOf(ownerId)}
            size="compact-xs"
            variant="subtle"
            rightSection={<IconExternalLink size={12} />}
          >
            {td('drawer.tokens.seeAll')}
          </Button>
        </Group>
      ) : null}
      {mint && onNew ? (
        <div>
          {mint.allowed ? (
            <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} onClick={onNew}>
              {td('drawer.tokens.new')}
            </Button>
          ) : (
            <Tooltip label={reasonText(mint.reason)} withArrow multiline w={260}>
              <span style={{ display: 'inline-flex' }}>
                <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} disabled>
                  {td('drawer.tokens.new')}
                </Button>
              </span>
            </Tooltip>
          )}
        </div>
      ) : null}
    </Stack>
  );
}

// ── activity of a person ──────────────────────────────────────────────────

const SERVICE_LABEL = new Map<string, string>(RBAC_SERVICE_DEFINITIONS.map((definition) => [definition.id, definition.label]));
const OUTCOME_COLOR: Record<string, string> = { success: 'teal', failure: 'orange', denied: 'red' };

/**
 * What a person did lately: the calls they made (or an application made for them) by service over the last days, and the
 * audit rows they are the subject of. Loaded when the drawer opens; read-only.
 */
export function ActivitySection({ userId, locale }: { userId: string; locale: string }) {
  const td = useTranslations('iamDirectory');
  const [state, setState] = useState<{ status: 'loading' } | { status: 'failed' } | { status: 'ready'; activity: PersonActivityView }>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    directoryApi
      .activity(userId, { signal: controller.signal })
      .then((activity) => setState({ status: 'ready', activity }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      });
    return () => controller.abort();
  }, [userId]);

  if (state.status === 'loading') {
    return (
      <Group gap="xs" data-testid="activity-loading">
        <Loader size="xs" />
        <Muted>{td('drawer.activity.loading')}</Muted>
      </Group>
    );
  }
  if (state.status === 'failed') return <Muted>{td('drawer.activity.failed')}</Muted>;

  const { activity } = state;
  return (
    <Stack gap="md" data-testid="activity-body">
      <Stack gap={6}>
        <Text size="sm" fw={600}>{td('drawer.activity.usageTitle', { days: activity.windowDays })}</Text>
        {activity.usage.length === 0 ? (
          <Muted>{td('drawer.activity.noUsage')}</Muted>
        ) : (
          <Table.ScrollContainer minWidth={460}>
            <Table verticalSpacing={6} fz="xs" data-testid="activity-usage">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{td('drawer.activity.service')}</Table.Th>
                  <Table.Th ta="right">{td('drawer.activity.requests')}</Table.Th>
                  <Table.Th ta="right">{td('drawer.activity.errors')}</Table.Th>
                  <Table.Th ta="right">{td('drawer.activity.tokens')}</Table.Th>
                  <Table.Th>{td('drawer.activity.last')}</Table.Th>
                  <Table.Th>{td('drawer.activity.through')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {activity.usage.map((row) => (
                  <Table.Tr key={row.service}>
                    <Table.Td>{SERVICE_LABEL.get(row.service) ?? row.service}</Table.Td>
                    <Table.Td ta="right">{row.requests.toLocaleString(locale)}</Table.Td>
                    <Table.Td ta="right">{row.errors.toLocaleString(locale)}</Table.Td>
                    <Table.Td ta="right">{row.totalTokens.toLocaleString(locale)}</Table.Td>
                    <Table.Td>{row.lastDay}</Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {row.viaTokens.length === 0 ? <Muted>—</Muted> : null}
                        {row.viaTokens.map((via) => (
                          <Badge key={via.id} size="xs" variant="default" tt="none">{`${via.label} · ${via.requests.toLocaleString(locale)}`}</Badge>
                        ))}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        {activity.usageTruncated ? <Muted>{td('drawer.activity.usageTruncated')}</Muted> : null}
      </Stack>

      <Stack gap={6}>
        <Text size="sm" fw={600}>{td('drawer.activity.eventsTitle')}</Text>
        {activity.events.length === 0 ? (
          <Muted>{td('drawer.activity.noEvents')}</Muted>
        ) : (
          <div className={styles.bordered} data-testid="activity-events">
            {activity.events.map((event) => (
              <div key={event.id} className={styles.listRow}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" ff="monospace" style={{ wordBreak: 'break-all' }}>
                    {event.method && event.path ? `${event.method} ${event.path}` : event.event}
                  </Text>
                  <Group gap={6} mt={2}>
                    <Text size="xs" c="dimmed">{formatDateTime(event.at, locale)}</Text>
                    <Badge size="xs" variant="light" color={OUTCOME_COLOR[event.outcome] ?? 'gray'}>
                      {translateOr(td, 'iamDirectory', `drawer.activity.outcomes.${event.outcome}`, event.outcome)}
                    </Badge>
                    {event.viaToken ? (
                      <Tooltip label={event.issuer ? td('drawer.activity.viaIssuer', { issuer: event.issuer }) : td('drawer.activity.viaToken')} withArrow>
                        <Badge size="xs" variant="default" tt="none">{td('drawer.activity.via', { label: event.viaToken.label })}</Badge>
                      </Tooltip>
                    ) : null}
                  </Group>
                </div>
              </div>
            ))}
          </div>
        )}
        {activity.hasMoreEvents ? <Muted>{td('drawer.activity.moreEvents')}</Muted> : null}
      </Stack>
    </Stack>
  );
}
