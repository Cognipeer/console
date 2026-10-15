'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconShieldCheck, IconTrash, IconUserPlus } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useConfirm } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { RBAC_SERVICE_DEFINITIONS, type UserServicePermissions } from '@/lib/security/rbac';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import ProjectPermissionsEditor from './ProjectPermissionsEditor';
import { summarizeStored } from './projectPermissionsModel';

type TenantRole = 'owner' | 'admin' | 'project_admin' | 'user' | 'portal_user';
type ProjectRole = 'member' | 'project_admin';

type ProjectMember = {
  userId: string;
  email: string;
  implicit: boolean;
  name: string;
  projectRole: ProjectRole | null;
  role: TenantRole;
  /** The project levels stored for this member (explicit entries only). */
  servicePermissions?: UserServicePermissions | null;
  /**
   * Services whose stored "no access" the engine reads as not set (it was saved
   * before project levels were enforced). They show as Inherit, and a save drops them.
   */
  ignoredServices?: string[];
};

type MemberCapabilities = {
  canAssignMembers: boolean;
  canInviteMembers: boolean;
  canManagePermissions: boolean;
  canManageRoles: boolean;
  canRemoveMembers: boolean;
  isProjectAdmin: boolean;
  isTenantAdmin: boolean;
};

type LegacyMember = {
  _id: string;
  email: string;
  name: string;
  role: TenantRole;
  servicePermissions?: UserServicePermissions | null;
};

const DEFAULT_CAPABILITIES: MemberCapabilities = {
  canAssignMembers: false,
  canInviteMembers: false,
  canManagePermissions: false,
  canManageRoles: false,
  canRemoveMembers: false,
  isProjectAdmin: false,
  isTenantAdmin: false,
};

function normalizeLegacyMember(member: LegacyMember): ProjectMember {
  const implicit = member.role === 'owner' || member.role === 'admin';

  return {
    email: member.email,
    implicit,
    name: member.name,
    projectRole: implicit ? null : member.role === 'project_admin' ? 'project_admin' : 'member',
    role: member.role,
    servicePermissions: member.servicePermissions ?? null,
    userId: member._id,
  };
}

function getTenantRoleColor(role: TenantRole) {
  switch (role) {
    case 'owner':
      return 'blue';
    case 'admin':
      return 'grape';
    case 'project_admin':
      return 'cyan';
    default:
      return 'gray';
  }
}

function getProjectRoleColor(role: ProjectRole | null, implicit: boolean) {
  if (implicit) return 'dark';
  return role === 'project_admin' ? 'teal' : 'gray';
}

export default function ProjectMembersManager(
  {
    projectId,
    readOnly,
    openMemberId,
  }: {
    projectId: string;
    readOnly?: boolean;
    /** Open the project permission editor of this member as soon as the list has loaded (a deep link). */
    openMemberId?: string | null;
  },
) {
  const { confirmAction } = useConfirm();
  const t = useTranslations('projectMembers');
  const root = useTranslations();
  const tq = useTranslations('common.confirm.qos');
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [capabilities, setCapabilities] = useState<MemberCapabilities>(DEFAULT_CAPABILITIES);
  const [loading, setLoading] = useState(true);
  const [assignEmail, setAssignEmail] = useState('');
  const [assignRole, setAssignRole] = useState<ProjectRole>('member');
  const [assignSuggestions, setAssignSuggestions] = useState<string[]>([]);
  const [assignSuggestionsLoading, setAssignSuggestionsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [inviteOpened, setInviteOpened] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'project_admin' | 'admin'>('member');
  const [memberToEditPermissions, setMemberToEditPermissions] = useState<ProjectMember | null>(null);
  const [query, setQuery] = useState('');
  const deepLinkHandled = useRef<string | null>(null);

  const notify = useCallback(
    (message: string, color: 'green' | 'red') => notifications.show({ title: t('notificationTitle'), message, color }),
    [t],
  );

  const fetchMembers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || t('errors.load'));
      }

      const data = (await res.json()) as {
        capabilities?: Partial<MemberCapabilities>;
        members?: ProjectMember[];
        users?: LegacyMember[];
      };

      const nextMembers = data.members ?? (data.users ?? []).map(normalizeLegacyMember);
      setMembers(nextMembers);
      setCapabilities({
        ...DEFAULT_CAPABILITIES,
        ...(data.capabilities ?? {}),
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : t('errors.load'), 'red');
    } finally {
      setLoading(false);
    }
  }, [notify, projectId, t]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  const effectiveReadOnly = readOnly ?? !(
    capabilities.canAssignMembers
    || capabilities.canInviteMembers
    || capabilities.canManagePermissions
    || capabilities.canManageRoles
    || capabilities.canRemoveMembers
  );

  useEffect(() => {
    let cancelled = false;

    if (effectiveReadOnly || !capabilities.canAssignMembers) {
      setAssignSuggestions([]);
      setAssignSuggestionsLoading(false);
      return;
    }

    const q = assignEmail.trim();
    if (q.length < 2) {
      setAssignSuggestions([]);
      return;
    }

    setAssignSuggestionsLoading(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/member-candidates?q=${encodeURIComponent(q)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          if (!cancelled) setAssignSuggestions([]);
          return;
        }

        const data = (await res.json()) as { users?: Array<{ email?: string }> };
        const emails = (data.users ?? [])
          .map((user) => (user.email ?? '').trim())
          .filter(Boolean);

        if (!cancelled) {
          setAssignSuggestions(emails);
        }
      } catch {
        if (!cancelled) {
          setAssignSuggestions([]);
        }
      } finally {
        if (!cancelled) {
          setAssignSuggestionsLoading(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [assignEmail, capabilities.canAssignMembers, effectiveReadOnly, projectId]);

  const filteredMembers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) =>
      [m.name, m.email, m.role]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [members, query]);

  const handleAssignExisting = async () => {
    if (!assignEmail.trim() || submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        body: JSON.stringify({ email: assignEmail.trim(), role: assignRole }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || t('errors.assign'));
      }

      notify(t('done.assigned'), 'green');
      setAssignEmail('');
      setAssignRole('member');
      await fetchMembers();
    } catch (error) {
      notify(error instanceof Error ? error.message : t('errors.assign'), 'red');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (member: ProjectMember) => {
    if (submitting) return;

    const done = await confirmAction({
      title: tq('removeTitle', { noun: tq('nouns.user') }),
      message: tq('removeProjectMember', { name: member.name || member.email || member.userId }),
      tone: 'warning',
      confirmLabel: tq('remove'),
      action: async () => {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
          body: JSON.stringify({ userId: member.userId }),
          headers: { 'content-type': 'application/json' },
          method: 'DELETE',
        });
        const body = await res.json().catch(() => null);

        if (!res.ok) {
          throw new Error(body?.error || t('errors.remove'));
        }
      },
    });
    if (!done) return;

    notify(t('done.removed'), 'green');
    await fetchMembers();
  };

  const handleRoleChange = async (member: ProjectMember, role: ProjectRole) => {
    if (submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        body: JSON.stringify({ role, userId: member.userId }),
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || t('errors.role'));
      }

      notify(t('done.role'), 'green');
      await fetchMembers();
    } catch (error) {
      notify(error instanceof Error ? error.message : t('errors.role'), 'red');
    } finally {
      setSubmitting(false);
    }
  };

  const savePermissions = async (permissions: UserServicePermissions) => {
    if (!memberToEditPermissions || submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members/permissions`, {
        body: JSON.stringify({
          // Only explicit choices: a service left on Inherit is simply not in the map.
          servicePermissions: permissions,
          userId: memberToEditPermissions.userId,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || t('errors.permissions'));
      }

      notify(t('done.permissions'), 'green');
      setMemberToEditPermissions(null);
      await fetchMembers();
    } catch (error) {
      notify(error instanceof Error ? error.message : t('errors.permissions'), 'red');
    } finally {
      setSubmitting(false);
    }
  };

  const handleInvite = async () => {
    if (!inviteName.trim() || !inviteEmail.trim() || submitting) return;

    setSubmitting(true);
    try {
      const apiRole = inviteRole === 'member' ? 'user' : inviteRole;
      const res = await fetch('/api/users/invite', {
        body: JSON.stringify({
          email: inviteEmail.trim(),
          name: inviteName.trim(),
          projectId,
          role: apiRole,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || t('errors.invite'));
      }

      notify(t('done.invited'), 'green');
      setInviteOpened(false);
      setInviteName('');
      setInviteEmail('');
      setInviteRole('member');
      await fetchMembers();
    } catch (error) {
      notify(error instanceof Error ? error.message : t('errors.invite'), 'red');
    } finally {
      setSubmitting(false);
    }
  };

  const canEditMemberRole = (member: ProjectMember) =>
    !effectiveReadOnly
    && capabilities.canManageRoles
    && !member.implicit
    && member.role !== 'owner'
    && member.role !== 'admin';

  const canEditMemberPermissions = (member: ProjectMember) =>
    !effectiveReadOnly
    && capabilities.canManagePermissions
    && !member.implicit
    && member.role !== 'owner'
    && member.role !== 'admin';

  const canRemoveMember = (member: ProjectMember) =>
    !effectiveReadOnly
    && capabilities.canRemoveMembers
    && !member.implicit
    && member.role !== 'owner'
    && member.role !== 'admin';

  // Deep link (?member=<userId> on the project page): open that member's permission editor once.
  useEffect(() => {
    if (!openMemberId || loading || deepLinkHandled.current === openMemberId) return;
    const member = members.find((m) => m.userId === openMemberId);
    if (!member) return;
    deepLinkHandled.current = openMemberId;
    if (canEditMemberPermissions(member)) setMemberToEditPermissions(member);
    // The editability rules read `capabilities`/`effectiveReadOnly`, which are part of this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMemberId, loading, members, capabilities, effectiveReadOnly]);

  const serviceName = useCallback(
    (id: string) => {
      const key = `iamApi.services.${id}`;
      const text = root(key);
      return text === key ? (RBAC_SERVICE_DEFINITIONS.find((s) => s.id === id)?.label ?? id) : text;
    },
    [root],
  );

  const accessCell = (member: ProjectMember) => {
    if (member.implicit) {
      return (
        <Text size="sm" c="dimmed">
          {t('access.implicit')}
        </Text>
      );
    }
    const summary = summarizeStored(member.servicePermissions, member.ignoredServices ?? []);
    if (summary.kind === 'inherits') {
      return (
        <Text size="sm" c="dimmed">
          {t('access.inherits')}
        </Text>
      );
    }
    if (summary.kind === 'one') {
      return (
        <Text size="sm">
          {t('access.one', { service: serviceName(summary.service), level: t(`editor.levels.${summary.level}`) })}
        </Text>
      );
    }
    return (
      <Tooltip
        multiline
        w={280}
        label={summary.entries
          .map((entry) => `${serviceName(entry.service)}: ${t(`editor.levels.${entry.level}`)}`)
          .join(', ')}
      >
        <Text size="sm">{t('access.many', { count: summary.count })}</Text>
      </Tooltip>
    );
  };

  const columns: DataGridColumn<ProjectMember>[] = [
    {
      key: 'name',
      label: t('columns.member'),
      render: (member) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{member.name}</span>
          <span className="ds-faint" style={{ fontSize: 11 }}>{member.email}</span>
        </div>
      ),
    },
    {
      key: 'tenantRole',
      label: t('columns.workspaceRole'),
      width: 170,
      render: (member) => (
        <Badge color={getTenantRoleColor(member.role)} variant="light">
          {t(`tenantRoles.${member.role}`)}
        </Badge>
      ),
    },
    {
      key: 'projectRole',
      label: t('columns.projectRole'),
      width: 180,
      render: (member) =>
        canEditMemberRole(member) ? (
          <Select
            size="xs"
            value={member.projectRole ?? 'member'}
            data={[
              { value: 'member', label: t('roles.member') },
              { value: 'project_admin', label: t('roles.project_admin') },
            ]}
            onChange={(value) => {
              if (!value) return;
              void handleRoleChange(member, value as ProjectRole);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <Badge color={getProjectRoleColor(member.projectRole, member.implicit)} variant="light">
            {member.implicit ? t('roles.implicit') : t(`roles.${member.projectRole ?? 'member'}`)}
          </Badge>
        ),
    },
    {
      key: 'permissions',
      label: t('columns.access'),
      render: (member) => accessCell(member),
    },
  ];

  return (
    <>
      {effectiveReadOnly || !capabilities.canAssignMembers ? null : (
        <div className="ds-card" style={{ padding: 16, marginBottom: 12 }}>
          <Group align="flex-end" gap="sm">
            <Select
              label={t('assign.emailLabel')}
              placeholder={t('assign.emailPlaceholder')}
              searchable
              clearable
              data={assignSuggestions}
              value={assignEmail}
              onChange={(value) => setAssignEmail(value ?? '')}
              onSearchChange={setAssignEmail}
              nothingFoundMessage={assignEmail.trim().length >= 2 ? t('assign.noMatches') : t('assign.typeToSearch')}
              rightSection={assignSuggestionsLoading ? <Loader size="xs" /> : undefined}
              rightSectionPointerEvents="none"
              style={{ flex: 1 }}
            />
            <Select
              label={t('assign.roleLabel')}
              value={assignRole}
              onChange={(value) => setAssignRole((value as ProjectRole) ?? 'member')}
              data={[
                { value: 'member', label: t('roles.member') },
                { value: 'project_admin', label: t('roles.project_admin') },
              ]}
              w={180}
            />
            <Button onClick={handleAssignExisting} loading={submitting}>
              {t('assign.submit')}
            </Button>
          </Group>
        </div>
      )}

      <DataGrid<ProjectMember>
        records={filteredMembers}
        loading={loading}
        rowKey={(m) => String(m.userId)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: t('search'),
        }}
        onRefresh={() => void fetchMembers()}
        refreshing={loading}
        toolbarRight={
          effectiveReadOnly || !capabilities.canInviteMembers ? undefined : (
            <Button
              color="teal"
              size="xs"
              leftSection={<IconUserPlus size={13} stroke={1.7} />}
              onClick={() => setInviteOpened(true)}
            >
              {t('invite.button')}
            </Button>
          )
        }
        empty={{
          title: t('empty.title'),
          description: effectiveReadOnly ? t('empty.readOnly') : t('empty.manage'),
          primaryAction:
            !effectiveReadOnly && capabilities.canInviteMembers
              ? {
                  label: t('invite.button'),
                  icon: <IconUserPlus size={14} stroke={1.7} />,
                  onClick: () => setInviteOpened(true),
                }
              : undefined,
        }}
        footerLeft={t('showing', { shown: filteredMembers.length, total: members.length })}
        rowActions={(member) => {
          const actions = [] as Array<{
            id: string;
            label: string;
            icon: React.ReactNode;
            color?: 'red' | 'teal' | 'gray' | 'blue' | 'orange';
            onClick: () => void;
            disabled?: boolean;
          }>;
          if (canEditMemberPermissions(member)) {
            actions.push({
              id: 'permissions',
              label: t('actions.permissions'),
              icon: <IconShieldCheck size={14} />,
              onClick: () => setMemberToEditPermissions(member),
            });
          }
          if (canRemoveMember(member)) {
            actions.push({
              id: 'remove',
              label: t('actions.remove'),
              icon: <IconTrash size={14} />,
              color: 'red',
              onClick: () => void handleRemove(member),
              disabled: submitting,
            });
          }
          return actions;
        }}
      />

      {capabilities.canInviteMembers && !effectiveReadOnly ? (
        <Modal
          opened={inviteOpened}
          onClose={() => {
            if (submitting) return;
            setInviteOpened(false);
          }}
          title={t('invite.title')}
          size="md"
          centered
        >
          <Stack gap="sm">
            <TextInput
              label={t('invite.name')}
              value={inviteName}
              onChange={(event) => setInviteName(event.currentTarget.value)}
              required
            />
            <TextInput
              label={t('invite.email')}
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.currentTarget.value)}
              required
            />
            <Select
              label={t('invite.role')}
              value={inviteRole}
              onChange={(value) => setInviteRole((value as 'member' | 'project_admin' | 'admin') ?? 'member')}
              data={[
                { value: 'member', label: t('invite.roleMember') },
                { value: 'project_admin', label: t('invite.roleProjectAdmin') },
                { value: 'admin', label: t('invite.roleWorkspaceAdmin') },
              ]}
            />
            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => setInviteOpened(false)} disabled={submitting}>
                {t('invite.cancel')}
              </Button>
              <Button onClick={handleInvite} loading={submitting}>
                {t('invite.submit')}
              </Button>
            </Group>
          </Stack>
        </Modal>
      ) : null}

      {memberToEditPermissions ? (
        <ProjectPermissionsEditor
          key={memberToEditPermissions.userId}
          member={memberToEditPermissions}
          projectId={projectId}
          saving={submitting}
          onClose={() => setMemberToEditPermissions(null)}
          onSave={(permissions) => void savePermissions(permissions)}
        />
      ) : null}
    </>
  );
}
