'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Badge, Button, Collapse, Select, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconShieldCheck,
  IconTrash,
  IconUserPlus,
  IconUserShield,
  IconUsersGroup,
} from '@tabler/icons-react';
import ConfirmModal from '@/components/common/ui/ConfirmModal';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { isAbortError } from '@/components/iam/principals/client';
import { directoryApi } from '@/components/iam/principals/directoryApi';
import { principalHref } from '@/components/iam/links';
import { useTranslations } from '@/lib/i18n';
import { RBAC_SERVICE_DEFINITIONS, type UserServicePermissions } from '@/lib/security/rbac';
import AddProjectMembersShell from '../AddProjectMembersShell';
import ProjectPermissionsEditor from '../ProjectPermissionsEditor';
import { summarizeStored } from '../projectPermissionsModel';
import {
  buildRows,
  bulkRemoveBody,
  bulkRoleBody,
  filterCounts,
  filterRows,
  NO_CAPABILITIES,
  parseBulkResult,
  parseMembers,
  rowSource,
  SOURCE_FILTERS,
  splitSelection,
  type BulkRequestBody,
  type GridRow,
  type MemberRow,
  type ProjectMembersData,
  type ProjectRoleValue,
  type SourceFilter,
} from './membersModel';

type Pending =
  | { kind: 'remove'; userIds: string[]; groupIds: string[] }
  | { kind: 'role'; userIds: string[]; role: ProjectRoleValue; skippedGroups: number };

const EMPTY: ProjectMembersData = { members: [], groups: [], tenantAdmins: [], capabilities: NO_CAPABILITIES };

function messageOf(body: unknown, fallback: string): string {
  const message = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
  return typeof message === 'string' && message ? message : fallback;
}

/**
 * Project Members: people and groups with where their access comes from, filter
 * chips by source, bulk role change and removal, "Add people" in one full-screen
 * form, and the owners and admins whose access is implicit in a collapsed section.
 */
export default function MembersTab({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const t = useTranslations('projectTabs.members');
  const tm = useTranslations('projectMembers');
  const root = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const openMemberId = searchParams?.get('member') ?? null;

  const [data, setData] = useState<ProjectMembersData>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [adminsOpen, setAdminsOpen] = useState(false);
  const [editing, setEditing] = useState<MemberRow | null>(null);
  const deepLinkHandled = useRef<string | null>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const notify = useCallback(
    (message: string, color: 'green' | 'red' | 'yellow') =>
      notifications.show({ title: tm('notificationTitle'), message, color }),
    [tm],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, { cache: 'no-store', signal: controller.signal })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) throw new Error(messageOf(body, tm('errors.load')));
        if (controller.signal.aborted) return;
        setData(parseMembers(body));
        setLoaded(true);
        setSelected(new Set());
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || controller.signal.aborted) return;
        notify(err instanceof Error ? err.message : tm('errors.load'), 'red');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, reloadKey, notify, tm]);

  const caps = data.capabilities;
  const canManage = caps.canAssignMembers || caps.canManageRoles || caps.canRemoveMembers || caps.canManagePermissions;

  const rows = useMemo(() => buildRows(data), [data]);
  const counts = useMemo(() => filterCounts(rows), [rows]);
  const visible = useMemo(() => filterRows(rows, filter, query), [rows, filter, query]);

  const existing = useMemo(
    () => ({
      userIds: new Set(data.members.filter((m) => !m.implicit).map((m) => m.userId)),
      groupIds: new Set(data.groups.map((g) => g.groupId)),
      adminIds: new Set(data.tenantAdmins.map((a) => a.userId)),
    }),
    [data],
  );

  // Deep link (?member=<userId>): open that member's service permissions once.
  useEffect(() => {
    if (!openMemberId || loading || deepLinkHandled.current === openMemberId) return;
    const member = data.members.find((m) => m.userId === openMemberId);
    if (!member) return;
    deepLinkHandled.current = openMemberId;
    if (caps.canManagePermissions && !member.implicit) setEditing(member);
  }, [openMemberId, loading, data.members, caps.canManagePermissions]);

  const postBulk = async (body: BulkRequestBody) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(messageOf(json, tm('errors.role')));
    return parseBulkResult(json);
  };

  const runPending = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const warnings: string[] = [];
      if (pending.kind === 'role') {
        const result = await postBulk(bulkRoleBody(pending.userIds, pending.role));
        warnings.push(...result.warnings);
        notify(t('done.role', { count: result.updated }), 'green');
      } else {
        let removed = 0;
        if (pending.userIds.length > 0) {
          const result = await postBulk(bulkRemoveBody(pending.userIds));
          removed += result.removed;
          warnings.push(...result.warnings);
        }
        for (const groupId of pending.groupIds) {
          try {
            await directoryApi.removeGroupProject(groupId, projectId);
            removed += 1;
          } catch (err) {
            warnings.push(err instanceof Error ? err.message : tm('errors.remove'));
          }
        }
        notify(t('done.removed', { count: removed }), 'green');
      }
      if (warnings.length > 0) notify(warnings.join('\n'), 'yellow');
      setPending(null);
      reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : tm('errors.role'), 'red');
    } finally {
      setBusy(false);
    }
  };

  const savePermissions = async (permissions: UserServicePermissions) => {
    if (!editing || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members/permissions`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ servicePermissions: permissions, userId: editing.userId }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(messageOf(body, tm('errors.permissions')));
      notify(tm('done.permissions'), 'green');
      setEditing(null);
      reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : tm('errors.permissions'), 'red');
    } finally {
      setBusy(false);
    }
  };

  const serviceName = useCallback(
    (id: string) => {
      const key = `iamApi.services.${id}`;
      const text = root(key);
      return text === key ? (RBAC_SERVICE_DEFINITIONS.find((s) => s.id === id)?.label ?? id) : text;
    },
    [root],
  );

  const accessCell = (member: MemberRow) => {
    const summary = summarizeStored(member.servicePermissions, member.ignoredServices);
    if (summary.kind === 'inherits') return <Text size="sm" c="dimmed">{tm('access.inherits')}</Text>;
    if (summary.kind === 'one') {
      return (
        <Text size="sm">
          {tm('access.one', { service: serviceName(summary.service), level: tm(`editor.levels.${summary.level}`) })}
        </Text>
      );
    }
    return (
      <Tooltip
        multiline
        w={280}
        label={summary.entries.map((e) => `${serviceName(e.service)}: ${tm(`editor.levels.${e.level}`)}`).join(', ')}
      >
        <Text size="sm">{tm('access.many', { count: summary.count })}</Text>
      </Tooltip>
    );
  };

  const roleOptions = [
    { value: 'member', label: tm('roles.member') },
    { value: 'project_admin', label: tm('roles.project_admin') },
  ];

  const askRole = (member: MemberRow, role: ProjectRoleValue) => {
    if (role === member.projectRole) return;
    setPending({ kind: 'role', userIds: [member.userId], role, skippedGroups: 0 });
  };

  const columns: DataGridColumn<GridRow>[] = [
    {
      key: 'name',
      label: t('columns.name'),
      render: (row) =>
        row.kind === 'group' ? (
          <div className="ds-row" style={{ gap: 8 }}>
            <IconUsersGroup size={16} stroke={1.6} aria-hidden />
            <div className="ds-col" style={{ gap: 2 }}>
              <Link
                href={principalHref('group', row.group.groupId)}
                style={{ fontSize: 13, fontWeight: 500, color: 'inherit' }}
              >
                {row.group.name}
              </Link>
              <span className="ds-faint" style={{ fontSize: 11 }}>
                {t('group.people', { count: row.group.memberCount })}
                {row.group.directorySynced ? ` · ${t('group.synced')}` : ''}
              </span>
            </div>
          </div>
        ) : (
          <div className="ds-col" style={{ gap: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{row.member.name || row.member.email}</span>
            <span className="ds-faint" style={{ fontSize: 11 }}>{row.member.email}</span>
          </div>
        ),
    },
    {
      key: 'source',
      label: t('columns.source'),
      width: 150,
      render: (row) => {
        const source = rowSource(row);
        return (
          <Badge size="sm" variant={source === 'direct' ? 'default' : 'light'} color={source === 'group' ? 'grape' : 'teal'}>
            {t(`source.${source}`)}
          </Badge>
        );
      },
    },
    {
      key: 'role',
      label: tm('columns.projectRole'),
      width: 190,
      render: (row) => {
        if (row.kind === 'group') {
          return (
            <Tooltip label={t('group.roleManaged')}>
              <Badge size="sm" variant={row.group.role === 'project_admin' ? 'light' : 'default'} color="teal">
                {tm(`roles.${row.group.role}`)}
              </Badge>
            </Tooltip>
          );
        }
        const member = row.member;
        return caps.canManageRoles ? (
          <Select
            size="xs"
            aria-label={t('roleOf', { name: member.name || member.email })}
            allowDeselect={false}
            data={roleOptions}
            value={member.projectRole}
            onChange={(v) => v && askRole(member, v as ProjectRoleValue)}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <Badge size="sm" variant={member.projectRole === 'project_admin' ? 'light' : 'default'} color="teal">
            {tm(`roles.${member.projectRole}`)}
          </Badge>
        );
      },
    },
    {
      key: 'access',
      label: tm('columns.access'),
      render: (row) =>
        row.kind === 'group' ? (
          <Text size="sm" c="dimmed">{t('group.accessOnGroup')}</Text>
        ) : (
          accessCell(row.member)
        ),
    },
  ];

  const canRemoveGroups = caps.isTenantAdmin;

  const bulkActions = canManage
    ? [
        ...(caps.canManageRoles
          ? [
              {
                label: t('bulk.makeAdmin'),
                icon: <IconUserShield size={13} />,
                color: 'teal' as const,
                onClick: (picked: GridRow[]) => startRole(picked, 'project_admin'),
              },
              {
                label: t('bulk.makeMember'),
                color: 'gray' as const,
                onClick: (picked: GridRow[]) => startRole(picked, 'member'),
              },
            ]
          : []),
        ...(caps.canRemoveMembers
          ? [
              {
                label: t('bulk.remove'),
                icon: <IconTrash size={13} />,
                color: 'red' as const,
                onClick: (picked: GridRow[]) => startRemove(picked),
              },
            ]
          : []),
      ]
    : [];

  function startRole(picked: GridRow[], role: ProjectRoleValue) {
    const split = splitSelection(picked, new Set(picked.map((r) => r.key)));
    if (split.userIds.length === 0) {
      notify(t('bulk.groupsNoRole'), 'yellow');
      return;
    }
    setPending({ kind: 'role', userIds: split.userIds, role, skippedGroups: split.groupIds.length });
  }

  function startRemove(picked: GridRow[]) {
    const split = splitSelection(picked, new Set(picked.map((r) => r.key)));
    const groupIds = canRemoveGroups ? split.groupIds : [];
    if (split.userIds.length + groupIds.length === 0) {
      notify(t('bulk.groupsNoRemove'), 'yellow');
      return;
    }
    setPending({ kind: 'remove', userIds: split.userIds, groupIds });
  }

  const pendingMessage = (() => {
    if (!pending) return '';
    if (pending.kind === 'role') {
      return t('confirm.roleMessage', {
        count: pending.userIds.length,
        role: tm(`roles.${pending.role}`),
      }) + (pending.skippedGroups > 0 ? ` ${t('confirm.groupsSkipped', { count: pending.skippedGroups })}` : '');
    }
    return t('confirm.removeMessage', { people: pending.userIds.length, groups: pending.groupIds.length });
  })();

  const grid = (
    <DataGrid<GridRow>
      records={visible}
      loading={loading && !loaded}
      rowKey={(row) => row.key}
      columns={columns}
      tabs={SOURCE_FILTERS.map((id) => ({ id, label: t(`filters.${id}`), count: counts[id] }))}
      activeTab={filter}
      onTabChange={(id) => setFilter(id as SourceFilter)}
      search={{ value: query, onChange: setQuery, placeholder: t('search') }}
      onRefresh={reload}
      refreshing={loading}
      selectable={canManage}
      selected={selected}
      onSelectionChange={setSelected}
      bulkActions={bulkActions}
      toolbarRight={
        caps.canAssignMembers ? (
          <Button
            color="teal"
            size="xs"
            leftSection={<IconUserPlus size={13} stroke={1.7} />}
            onClick={() => setAddOpen(true)}
          >
            {t('add')}
          </Button>
        ) : undefined
      }
      empty={{
        title: t('empty.title'),
        description: caps.canAssignMembers ? t('empty.manage') : t('empty.readOnly'),
        primaryAction: caps.canAssignMembers
          ? { label: t('add'), icon: <IconUserPlus size={14} stroke={1.7} />, onClick: () => setAddOpen(true) }
          : undefined,
      }}
      footerLeft={t('showing', { shown: visible.length, total: rows.length })}
      rowActions={(row) => {
        if (row.kind === 'group') {
          return [
            {
              id: 'open',
              label: t('actions.openGroup'),
              icon: <IconExternalLink size={14} />,
              onClick: () => router.push(principalHref('group', row.group.groupId)),
            },
            {
              id: 'remove',
              label: t('actions.removeGroup'),
              icon: <IconTrash size={14} />,
              color: 'red' as const,
              hidden: !canRemoveGroups,
              onClick: () => setPending({ kind: 'remove', userIds: [], groupIds: [row.group.groupId] }),
            },
          ];
        }
        return [
          {
            id: 'permissions',
            label: tm('actions.permissions'),
            icon: <IconShieldCheck size={14} />,
            hidden: !caps.canManagePermissions,
            onClick: () => setEditing(row.member),
          },
          {
            id: 'remove',
            label: tm('actions.remove'),
            icon: <IconTrash size={14} />,
            color: 'red' as const,
            hidden: !caps.canRemoveMembers,
            onClick: () => setPending({ kind: 'remove', userIds: [row.member.userId], groupIds: [] }),
          },
        ];
      }}
    />
  );

  return (
    <div className="ds-col" style={{ gap: 16 }}>
      {grid}

      <div className="ds-card" style={{ padding: 0 }}>
        <button
          type="button"
          className="ds-row-between"
          aria-expanded={adminsOpen}
          onClick={() => setAdminsOpen((v) => !v)}
          style={{ width: '100%', padding: '12px 16px', background: 'none', border: 0, cursor: 'pointer', color: 'inherit' }}
        >
          <span className="ds-row" style={{ gap: 8, fontSize: 13, fontWeight: 600 }}>
            {adminsOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            {t('admins.title')}
            <Badge size="xs" variant="default">{data.tenantAdmins.length}</Badge>
          </span>
        </button>
        <Collapse in={adminsOpen}>
          <div style={{ padding: '0 16px 14px' }}>
            <Text size="xs" c="dimmed" mb="sm">{t('admins.explain')}</Text>
            {data.tenantAdmins.length === 0 ? (
              <Text size="sm" c="dimmed">{t('admins.empty')}</Text>
            ) : (
              data.tenantAdmins.map((admin) => (
                <div key={admin.userId} className="ds-row-between" style={{ padding: '6px 0', gap: 12 }}>
                  <span className="ds-col" style={{ gap: 1, minWidth: 0 }}>
                    <Link
                      href={principalHref('user', admin.userId)}
                      style={{ fontSize: 13, fontWeight: 500, color: 'inherit' }}
                    >
                      {admin.name || admin.email}
                    </Link>
                    <span className="ds-faint" style={{ fontSize: 11 }}>{admin.email}</span>
                  </span>
                  <Tooltip label={t('admins.cannotRemove')}>
                    <Badge size="sm" variant="light" color={admin.role === 'owner' ? 'blue' : 'grape'}>
                      {tm(`tenantRoles.${admin.role}`)}
                    </Badge>
                  </Tooltip>
                </div>
              ))
            )}
          </div>
        </Collapse>
      </div>

      <AddProjectMembersShell
        open={addOpen}
        projectId={projectId}
        projectName={projectName}
        existing={existing}
        canAddGroups={caps.isTenantAdmin}
        onClose={() => setAddOpen(false)}
        onDone={reload}
      />

      <ConfirmModal
        opened={pending !== null}
        title={pending?.kind === 'role' ? t('confirm.roleTitle') : t('confirm.removeTitle')}
        message={pendingMessage}
        confirmLabel={pending?.kind === 'role' ? t('confirm.roleConfirm') : t('confirm.removeConfirm')}
        cancelLabel={t('cancel')}
        confirmColor={pending?.kind === 'role' ? 'teal' : 'red'}
        loading={busy}
        onConfirm={() => void runPending()}
        onClose={() => {
          if (!busy) setPending(null);
        }}
      />

      {editing ? (
        <ProjectPermissionsEditor
          key={editing.userId}
          member={editing}
          projectId={projectId}
          saving={busy}
          onClose={() => setEditing(null)}
          onSave={(permissions) => void savePermissions(permissions)}
        />
      ) : null}
    </div>
  );
}
