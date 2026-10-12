'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  CopyButton,
  Drawer,
  Group,
  Select,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheck,
  IconCopy,
  IconHistory,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconShieldCheck,
  IconShieldHalf,
  IconTrash,
  IconUserCheck,
  IconUserEdit,
  IconUserOff,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import TokenDetailModal from '@/components/iam/tokens/TokenDetailModal';
import type { ApiTokenRow } from '@/components/iam/tokens/tokenModel';
import ProjectPermissionsEditor, { type PermissionsEditorMember } from '@/components/projects/ProjectPermissionsEditor';
import { useLocale, useTranslations } from '@/lib/i18n';
import AddToProjectShell, { type ProjectMembershipSubject } from './AddToProjectShell';
import AttachedPolicies from './AttachedPolicies';
import ChangeRoleShell from './ChangeRoleShell';
import {
  iamLinks,
  IamApiError,
  isAbortError,
  isSimulatable,
  type AllowedAction,
  type GroupRef,
  type OwnedToken,
  type PrincipalDetail,
  type PrincipalExtras,
  type PrincipalSummary,
  type PrincipalTarget,
  type ProjectRef,
} from './client';
import { ActionButton, IdentityBadges, IdentityFacts, Muted, PersonFacts, reasonKey, Section } from './detailParts';
import { directoryApi } from './directoryApi';
import { notifyError } from './errors';
import EditAccessShell from './EditAccessShell';
import EditProfileShell from './EditProfileShell';
import EffectivePermissions from './EffectivePermissions';
import GroupMembersSection from './GroupMembersSection';
import GroupShell from './GroupShell';
import { ManagedBanner } from './managed';
import MembershipShell from './MembershipShell';
import { ActivitySection, GroupsSection, ProjectsSection, UserTokensSection, type ProjectRowHandlers } from './PersonSections';
import { MATRIX_SERVICES } from './permissionModel';
import { useServiceLabels } from './serviceLabels';
import type { EditKind } from './listState';
import type { PeopleActions } from './usePeopleActions';
import { PrincipalAvatar } from './visuals';
import styles from './PrincipalDetail.module.css';
import type { Translate } from './format';

export type { PrincipalTarget } from './client';

const NS = 'iamPrincipals';

// ── the detail view (pure: data in, markup out) ───────────────────────────

/** What the signed-in person is, as far as the drawer's actions need to know. */
export interface DetailViewer {
  /** The signed-in person: nobody changes their own role or disables themself. */
  userId: string | null;
}

/** The things a drawer can ask for; the container wires them to forms and confirmations. */
export interface DetailHandlers {
  // a person
  editProfile: () => void;
  changeRole: () => void;
  editAccess: () => void;
  disable: () => void;
  enable: () => void;
  remove: () => void;
  copyInvitationLink: () => void;
  addToGroups: () => void;
  removeFromGroup: (group: GroupRef) => void;
  addToProject: () => void;
  project: ProjectRowHandlers;
  newToken: () => void;
  revokeOwnedToken: (token: OwnedToken) => void;
  // a group
  editGroup: () => void;
  deleteGroup: () => void;
  assignGroupProject: () => void;
  removeGroupProject: (project: ProjectRef) => void;
  // a token
  editToken: () => void;
  revokeToken: () => void;
}

export interface PrincipalDetailViewProps {
  summary: PrincipalSummary;
  /** null while the first load is in flight. */
  detail: PrincipalDetail | null;
  loading: boolean;
  error: string | null;
  projectId: string;
  canManage: boolean;
  locale: string;
  labelOf: (service: string) => string;
  t: Translate;
  onProjectChange: (projectId: string) => void;
  onRetry: () => void;
  onOpen: (target: PrincipalTarget) => void;
  onBack?: () => void;
  /** Wires the drawer's write actions; without it the drawer is read-only. */
  handlers?: DetailHandlers;
  viewer?: DetailViewer;
  /** The members of a group (stateful, owned by the container). */
  membersSlot?: ReactNode;
}

const NO_EXTRAS: PrincipalExtras = {
  ownerId: null,
  ownerLabel: null,
  expiresAt: null,
  lastUsedAt: null,
  scoped: null,
  authProvider: null,
  canLogin: null,
  kind: null,
  source: null,
  tenantRole: null,
  email: null,
  createdAt: null,
  invitedAt: null,
  inviteAcceptedAt: null,
  pendingInvite: null,
  disabledAt: null,
  disabledBy: null,
  disabledReason: null,
  managed: null,
  servicePermissions: null,
  projectId: null,
  projectName: null,
  createdBy: null,
};

/** The grants of a group, one chip per service. */
function GrantsSummary({
  grants,
  labelOf,
  td,
}: {
  grants: Record<string, string>;
  labelOf: (service: string) => string;
  /** Translator of the `iamDirectory` namespace. */
  td: Translate;
}) {
  const known = new Set(MATRIX_SERVICES.map((s) => s.id as string));
  const entries = Object.entries(grants).filter(([service, level]) => level && known.has(service));
  if (entries.length === 0) return <Muted>{td('drawer.group.noGrants')}</Muted>;
  return (
    <Group gap={6} wrap="wrap" data-testid="group-grants">
      {entries.map(([service, level]) => (
        <Badge key={service} variant="light" color={level === 'none' ? 'gray' : 'blue'} radius="sm" tt="none">
          {labelOf(service)}: {td(`matrix.levels.${level}`)}
        </Badge>
      ))}
    </Group>
  );
}

export function PrincipalDetailView({
  summary,
  detail,
  loading,
  error,
  projectId,
  canManage,
  locale,
  labelOf,
  t,
  onProjectChange,
  onRetry,
  onOpen,
  onBack,
  handlers,
  viewer,
  membersSlot,
}: PrincipalDetailViewProps) {
  const td = useTranslations('iamDirectory');
  const { type, id } = summary;
  const extras = detail?.extras ?? NO_EXTRAS;
  const projects = detail?.projects ?? [];
  const groups = detail?.groups ?? [];
  const tokens = detail?.tokens ?? null;
  const detailPolicies = detail?.policies;
  const policies = useMemo(() => detailPolicies ?? [], [detailPolicies]);
  const policyNames = useMemo(() => new Map(policies.map((p) => [p.policyId, p.name])), [policies]);
  const actions = detail?.allowedActions ?? null;
  const reasonText = useCallback(
    (reason: string | undefined) => td(`reasons.${reasonKey(reason)}`),
    [td],
  );
  const isSelf = Boolean(viewer?.userId) && viewer?.userId === id && type === 'user';
  const disabledAccount = summary.status === 'disabled';
  const personRole = summary.role ?? '';
  const joinsProjects = personRole !== 'owner' && personRole !== 'admin';
  const managedBy = extras.managed?.directory ? (extras.managed.provider ?? extras.authProvider) : null;

  const action = (name: string): AllowedAction | undefined => actions?.[name];
  const wired = Boolean(handlers);

  return (
    <Stack gap="md">
      {/* identity */}
      <Group wrap="nowrap" align="flex-start" gap="sm">
        {onBack ? (
          <ActionIcon variant="subtle" color="gray" onClick={onBack} aria-label={t('drawer.back')} mt={4}>
            <IconArrowLeft size={18} />
          </ActionIcon>
        ) : null}
        <PrincipalAvatar type={type} label={summary.label} size={44} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text fw={700} size="lg" lh={1.25} style={{ wordBreak: 'break-word' }}>
            {summary.label}
          </Text>
          {summary.sublabel ? (
            <Text size="sm" c="dimmed" style={{ wordBreak: 'break-word' }}>
              {summary.sublabel}
            </Text>
          ) : null}
          <IdentityBadges summary={summary} extras={extras} t={t} />
          <IdentityFacts summary={summary} extras={extras} locale={locale} t={t} onOpen={onOpen} />
          <Group gap={4} mt={6} wrap="nowrap">
            <Text size="xs" c="dimmed">
              {t('drawer.id')}
            </Text>
            <Text size="xs" ff="monospace" truncate style={{ minWidth: 0 }}>
              {id}
            </Text>
            <CopyButton value={id} timeout={1500}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? t('drawer.copied') : t('drawer.copyId')} withArrow>
                  <ActionIcon variant="subtle" color="gray" size="sm" onClick={copy} aria-label={t('drawer.copyId')}>
                    {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </Group>
        </div>
      </Group>

      {/* write actions, driven by what the server says this viewer may do */}
      {wired && handlers && actions ? (
        <Group gap="xs" wrap="wrap" data-testid="manage-actions">
          {type === 'user' ? (
            <>
              <ActionButton action={action('editProfile')} label={td('actions.editProfile')} icon={<IconUserEdit size={14} />} onClick={handlers.editProfile} reasonText={reasonText} testId="act-edit-profile" />
              <ActionButton action={action('changeRole')} label={td('actions.changeRole')} icon={<IconShieldHalf size={14} />} onClick={handlers.changeRole} reasonText={reasonText} testId="act-change-role" />
              {extras.servicePermissions !== null ? (
                <ActionButton action={action('editPermissions')} label={td('actions.editAccess')} icon={<IconShieldCheck size={14} />} onClick={handlers.editAccess} reasonText={reasonText} testId="act-edit-access" />
              ) : null}
              {action('copyInvitationLink')?.allowed || extras.pendingInvite ? (
                <ActionButton action={action('copyInvitationLink')} label={td('actions.copyInvitationLink')} icon={<IconCopy size={14} />} onClick={handlers.copyInvitationLink} reasonText={reasonText} testId="act-copy-link" />
              ) : null}
              {disabledAccount ? (
                <ActionButton action={action('enable')} label={td('actions.enable')} icon={<IconUserCheck size={14} />} onClick={handlers.enable} reasonText={reasonText} testId="act-enable" />
              ) : (
                <ActionButton action={action('disable')} label={td('actions.disable')} icon={<IconUserOff size={14} />} onClick={handlers.disable} reasonText={reasonText} testId="act-disable" />
              )}
              <ActionButton action={action('delete')} label={td('actions.delete')} icon={<IconTrash size={14} />} onClick={handlers.remove} color="red" reasonText={reasonText} testId="act-delete" />
            </>
          ) : null}
          {type === 'group' ? (
            <>
              <ActionButton action={action('edit')} label={td('actions.editGroup')} icon={<IconUserEdit size={14} />} onClick={handlers.editGroup} reasonText={reasonText} testId="act-edit-group" />
              <ActionButton action={action('delete')} label={td('actions.deleteGroup')} icon={<IconTrash size={14} />} onClick={handlers.deleteGroup} color="red" reasonText={reasonText} testId="act-delete-group" />
            </>
          ) : null}
          {type === 'token' ? (
            <>
              <ActionButton action={action('edit')} label={td('actions.editToken')} icon={<IconUserEdit size={14} />} onClick={handlers.editToken} reasonText={reasonText} testId="act-edit-token" />
              <ActionButton action={action('revoke')} label={td('actions.revokeToken')} icon={<IconTrash size={14} />} onClick={handlers.revokeToken} color="red" reasonText={reasonText} testId="act-revoke-token" />
            </>
          ) : null}
        </Group>
      ) : null}

      {/* exploring actions: always links */}
      <Group gap="xs" wrap="wrap">
        {isSimulatable(type) ? (
          <Button
            component={Link}
            href={iamLinks.simulate(type, id)}
            size="xs"
            variant="default"
            leftSection={<IconPlayerPlay size={14} />}
          >
            {t('drawer.actions.simulate')}
          </Button>
        ) : null}
        {canManage ? (
          <Button component={Link} href={iamLinks.createPolicy(type, id)} size="xs" leftSection={<IconPlus size={14} />}>
            {t('drawer.actions.createPolicy')}
          </Button>
        ) : null}
        <Button
          component={Link}
          href={iamLinks.audit(type, id)}
          size="xs"
          variant="default"
          leftSection={<IconHistory size={14} />}
        >
          {t('drawer.actions.audit')}
        </Button>
      </Group>

      {managedBy ? <ManagedBanner provider={managedBy} fields={td(extras.managed?.roleFromDirectory ? 'managed.personFieldsRole' : 'managed.personFields')} /> : null}

      {error ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('errors.detailFailed')}>
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{error}</Text>
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={onRetry}>
              {t('errors.retry')}
            </Button>
          </Stack>
        </Alert>
      ) : null}

      {!detail && loading ? (
        <Stack gap="md" aria-busy="true">
          <Skeleton height={190} radius="md" />
          <Skeleton height={80} radius="md" />
          <Skeleton height={110} radius="md" />
        </Stack>
      ) : null}

      {detail ? (
        <>
          {type === 'user' && wired ? (
            <Section title={td('drawer.facts.title')} testId="section-profile">
              <PersonFacts extras={extras} summary={summary} locale={locale} />
            </Section>
          ) : null}

          {type === 'group' && wired ? (
            <Section title={td('drawer.group.overview')} hint={td('drawer.group.overviewHint')} testId="section-overview">
              {summary.sublabel ? (
                <Text size="sm" style={{ wordBreak: 'break-word' }}>
                  {summary.sublabel}
                </Text>
              ) : null}
              <GrantsSummary grants={extras.servicePermissions ?? {}} labelOf={labelOf} td={td} />
            </Section>
          ) : null}

          <Section
            title={t('drawer.effective.title')}
            hint={t('drawer.effective.hint')}
            right={
              projects.length > 0 ? (
                <Select
                  size="xs"
                  w={{ base: '100%', xs: 230 }}
                  clearable
                  searchable={projects.length > 8}
                  value={projectId || null}
                  data={projects.map((p) => ({ value: p.id, label: p.name }))}
                  placeholder={t('drawer.effective.projectPlaceholder')}
                  aria-label={t('drawer.effective.project')}
                  onChange={(v) => onProjectChange(v ?? '')}
                  comboboxProps={{ withinPortal: true }}
                />
              ) : undefined
            }
          >
            <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity 150ms' }} aria-busy={loading}>
              {projectId ? (
                <Text size="xs" c="dimmed" mb="xs">
                  {t('drawer.effective.projectHint')}
                </Text>
              ) : null}
              {detail.effectiveSkipped && detail.effective.length === 0 ? (
                <Skeleton height={140} radius="md" />
              ) : (
                <EffectivePermissions rows={detail.effective} labelOf={labelOf} policyNames={policyNames} t={t} />
              )}
            </div>
          </Section>

          {type === 'group' && membersSlot ? (
            <Section title={td('drawer.members.title')} hint={td('drawer.members.hint')} testId="section-members">
              {membersSlot}
            </Section>
          ) : null}

          {type !== 'group' || groups.length > 0 ? (
            <Section title={t('drawer.groups.title')} hint={t('drawer.groups.hint')}>
              <GroupsSection
                groups={groups}
                manage={wired ? action('manageGroups') : undefined}
                t={t}
                onOpen={onOpen}
                onAdd={handlers?.addToGroups}
                onRemove={handlers?.removeFromGroup}
                reasonText={reasonText}
              />
            </Section>
          ) : null}

          <Section
            title={t('drawer.projects.title')}
            right={
              type === 'group' && wired && action('manageProjects')?.allowed ? (
                <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={handlers?.assignGroupProject}>
                  {td('drawer.projects.assign')}
                </Button>
              ) : undefined
            }
          >
            {type === 'group' && wired ? (
              <GroupProjects projects={projects} t={t} canManage={action('manageProjects')?.allowed === true} onRemove={handlers?.removeGroupProject} />
            ) : (
              <ProjectsSection
                projects={projects}
                manage={type === 'user' && wired ? action('manageProjects') : undefined}
                addable={joinsProjects}
                t={t}
                handlers={type === 'user' && wired ? handlers?.project : undefined}
                onAdd={handlers?.addToProject}
                reasonText={reasonText}
              />
            )}
          </Section>

          <Section title={t('drawer.policies.title')} hint={t('drawer.policies.hint')}>
            <AttachedPolicies
              policies={policies}
              principal={{ type, id }}
              groups={groups}
              ownerId={extras.ownerId}
              t={t}
            />
          </Section>

          {type === 'user' && tokens ? (
            <Section title={t('drawer.tokens.title')} hint={t('drawer.tokens.hint')} testId="section-tokens">
              <UserTokensSection
                ownerId={id}
                tokens={tokens}
                hidden={detail.tokensHidden}
                truncated={detail.tokensTruncated}
                total={detail.tokensTotal}
                mint={wired ? action('mintToken') : undefined}
                revoke={wired ? action('revokeTokens') : undefined}
                locale={locale}
                t={t}
                onOpen={onOpen}
                onNew={handlers?.newToken}
                onRevoke={handlers?.revokeOwnedToken}
                reasonText={reasonText}
              />
            </Section>
          ) : null}
          {type === 'user' ? (
            <Section title={td('drawer.activity.title')} hint={td('drawer.activity.hint')} testId="section-activity">
              <ActivitySection userId={id} locale={locale} />
            </Section>
          ) : null}
          {type === 'user' && !tokens && detail.tokensHidden ? (
            <Section title={t('drawer.tokens.title')} hint={t('drawer.tokens.hint')} testId="section-tokens">
              <UserTokensSection
                ownerId={id}
                tokens={[]}
                hidden
                truncated={false}
                total={null}
                locale={locale}
                t={t}
                onOpen={onOpen}
                reasonText={reasonText}
              />
            </Section>
          ) : null}
        </>
      ) : null}
      {isSelf && wired ? (
        <Text size="xs" c="dimmed" data-testid="self-note">
          {td('drawer.selfNote')}
        </Text>
      ) : null}
    </Stack>
  );
}

/** The projects a group is assigned to, with a remove button each. */
function GroupProjects({
  projects,
  t,
  canManage,
  onRemove,
}: {
  projects: ProjectRef[];
  t: Translate;
  canManage: boolean;
  onRemove?: (project: ProjectRef) => void;
}) {
  const td = useTranslations('iamDirectory');
  if (projects.length === 0) return <Muted>{t('drawer.projects.empty')}</Muted>;
  return (
    <div className={styles.bordered}>
      {projects.map((p) => (
        <div key={p.id} className={styles.listRow} data-testid="group-project">
          <div style={{ minWidth: 0 }}>
            <Text size="sm" fw={500} style={{ wordBreak: 'break-word' }}>
              {p.name}
            </Text>
          </div>
          <Group gap={6} wrap="nowrap">
            {p.role ? (
              <Badge size="sm" variant="default" tt="none">
                {t(`drawer.projects.role.${p.role === 'project_admin' ? 'project_admin' : 'member'}`)}
              </Badge>
            ) : null}
            {canManage && onRemove ? (
              <Tooltip label={td('drawer.projects.removeGroup')} withArrow>
                <ActionIcon size="sm" variant="subtle" color="red" aria-label={td('drawer.projects.removeGroupNamed', { name: p.name })} onClick={() => onRemove(p)}>
                  <IconTrash size={14} />
                </ActionIcon>
              </Tooltip>
            ) : null}
          </Group>
        </div>
      ))}
    </div>
  );
}

// ── container: fetches the detail of one principal ────────────────────────

function describeLoadError(err: unknown, t: Translate): string {
  if (err instanceof IamApiError) {
    if (err.status === 403) return t('errors.forbidden');
    if (err.status === 404) return t('errors.notFound');
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface DrawerContext {
  /** The signed-in person. */
  me: { userId: string; role: string } | null;
  /** The roles the signed-in person may hand out. */
  assignableRoles: readonly string[];
  /** May the signed-in person mint tokens for other people? */
  canMintForOthers: boolean;
  actions: PeopleActions;
  /** The open full-screen form of the drawer's principal (mirrored into the address bar). */
  edit: EditKind | null;
  onEdit: (kind: EditKind | null) => void;
  /** A person was created or changed: refresh the list behind the drawer. */
  onChanged: () => void;
  /** A forms is open: Escape belongs to it. */
  onOverlayChange?: (open: boolean) => void;
  /** Start minting a token for this person (opens the token form of the list). */
  onNewToken: (owner: { id: string; label: string }) => void;
  /** The principal is gone (deleted): close the drawer. */
  onGone: () => void;
}

interface ContentProps {
  target: PrincipalTarget;
  canManage: boolean;
  context: DrawerContext;
  onOpen: (target: PrincipalTarget) => void;
  onBack?: () => void;
}

interface LoadState {
  detail: PrincipalDetail | null;
  loading: boolean;
  error: string | null;
}

function PrincipalDetailContent({ target, canManage, context, onOpen, onBack }: ContentProps) {
  const t = useTranslations(NS);
  const td = useTranslations('iamDirectory');
  const tNotifications = useTranslations('notifications');
  const locale = useLocale();
  const { labelOf } = useServiceLabels();
  const [projectId, setProjectId] = useState('');
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<LoadState>({ detail: null, loading: true, error: null });
  const detailRef = useRef<PrincipalDetail | null>(null);
  detailRef.current = state.detail;

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      try {
        // First open: the profile without the (expensive) effective table, then the table. Later loads
        // (another project, a reload after a change) keep what is shown and fetch the whole thing.
        if (!detailRef.current) {
          const lite = await directoryApi.detail(target.type, target.id, {
            projectId: projectId || null,
            effective: false,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setState({ detail: lite, loading: lite.effectiveSkipped, error: null });
          if (!lite.effectiveSkipped) return;
        }
        const full = await directoryApi.detail(target.type, target.id, { projectId: projectId || null, signal: controller.signal });
        if (!controller.signal.aborted) setState({ detail: full, loading: false, error: null });
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) return;
        setState((s) => ({ ...s, loading: false, error: describeLoadError(err, t) }));
      }
    })();
    return () => controller.abort();
  }, [target.type, target.id, projectId, reload, t]);

  const fallback = useMemo<PrincipalSummary>(
    () =>
      target.summary ?? {
        type: target.type,
        id: target.id,
        label: target.id,
        sublabel: null,
        role: null,
        status: null,
        memberCount: null,
        policyCount: 0,
      },
    [target],
  );
  const detail = state.detail;
  const summary = detail?.principal ?? fallback;
  const extras = detail?.extras;

  const refresh = useCallback(() => {
    setReload((n) => n + 1);
    context.onChanged();
  }, [context]);

  // ── forms of this principal ───────────────────────────────────────────
  const { edit, onEdit } = context;
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [projectEditor, setProjectEditor] = useState<{ project: ProjectRef; member: PermissionsEditorMember } | null>(null);
  const [savingProject, setSavingProject] = useState(false);

  const overlayOpen = edit !== null || projectEditor !== null || addProjectOpen;
  const onOverlayChange = context.onOverlayChange;
  useEffect(() => {
    onOverlayChange?.(overlayOpen);
    return () => onOverlayChange?.(false);
  }, [overlayOpen, onOverlayChange]);

  const isUser = summary.type === 'user';
  const personName = summary.label;
  const personEmail = extras?.email ?? summary.email ?? summary.sublabel ?? '';
  const provider = extras?.managed?.provider ?? (extras?.authProvider && extras.authProvider !== 'local' ? extras.authProvider : null);
  const personRef = { id: summary.id, name: personName, email: personEmail };
  const isSelf = context.me?.userId === summary.id;
  const assignable = detail?.assignableRoles ?? context.assignableRoles;
  const groupLite = { id: summary.id, name: summary.label, policyCount: summary.policyCount };

  const handlers = useMemo<DetailHandlers>(
    () => ({
      editProfile: () => onEdit('profile'),
      changeRole: () => onEdit('role'),
      editAccess: () => onEdit('access'),
      disable: () => void context.actions.disable(personRef).then((ok) => ok && refresh()),
      enable: () => void context.actions.enable(personRef).then((ok) => ok && refresh()),
      remove: () =>
        void context.actions.remove(personRef).then((ok) => {
          if (!ok) return;
          context.onChanged();
          context.onGone();
        }),
      copyInvitationLink: () => void context.actions.copyInvitationLink(personRef),
      addToGroups: () => onEdit('memberships'),
      removeFromGroup: (group) =>
        void context.actions.removeFromGroup(personRef, { id: group.id, name: group.name }).then((ok) => ok && refresh()),
      addToProject: () => setAddProjectOpen(true),
      project: {
        onSetRole: (project, role) => {
          directoryApi
            .setProjectMemberRole(project.id, { userId: summary.id, role })
            .then(() => {
              notifications.show({ message: td('toast.projectRoleChanged', { project: project.name }), color: 'green' });
              refresh();
            })
            .catch((error: unknown) => notifyError(error, td, tNotifications('errorTitle')));
        },
        onEditAccess: (project) => {
          directoryApi
            .projectMember(project.id, summary.id)
            .then((row) => {
              setProjectEditor({
                project,
                member: {
                  userId: summary.id,
                  name: personName,
                  email: personEmail,
                  role: summary.role ?? 'user',
                  servicePermissions: row?.servicePermissions ?? null,
                  ignoredServices: row?.ignoredServices,
                },
              });
            })
            .catch((error: unknown) => notifyError(error, td, tNotifications('errorTitle')));
        },
        onRemove: (project) =>
          void context.actions.removeProjectMember(personRef, { id: project.id, name: project.name }).then((ok) => ok && refresh()),
      },
      newToken: () => context.onNewToken({ id: summary.id, label: personName }),
      revokeOwnedToken: (token) => void context.actions.revokeToken({ id: token.id, label: token.label }).then((ok) => ok && refresh()),
      editGroup: () => onEdit('group'),
      deleteGroup: () =>
        void context.actions.deleteGroup(groupLite).then((ok) => {
          if (!ok) return;
          context.onChanged();
          context.onGone();
        }),
      assignGroupProject: () => setAddProjectOpen(true),
      removeGroupProject: (project) =>
        void context.actions
          .removeGroupProject(groupLite, { id: project.id, name: project.name })
          .then((ok) => ok && refresh()),
      editToken: () => onEdit('token'),
      revokeToken: () =>
        void context.actions.revokeToken({ id: summary.id, label: summary.label }).then((ok) => {
          if (!ok) return;
          context.onChanged();
          context.onGone();
        }),
    }),
    // personRef / groupLite are derived from `summary` and `personEmail`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context, onEdit, refresh, summary.id, summary.label, summary.role, summary.policyCount, personName, personEmail, td, tNotifications],
  );

  // A stable key per target so the members section starts at page 1.
  const membersSlot =
    summary.type === 'group' ? (
      <GroupMembersSection
        group={{ id: summary.id, name: summary.label, source: extras?.source ?? summary.source ?? 'local' }}
        canManage={detail?.allowedActions?.manageMembers?.allowed === true}
        actions={context.actions}
        t={t}
        onOpenMember={(userId, label) => onOpen({ type: 'user', id: userId, summary: { type: 'user', id: userId, label, sublabel: null, role: null, status: null, memberCount: null, policyCount: 0 } })}
        onChanged={refresh}
        reloadKey={reload}
      />
    ) : undefined;

  const tokenRow: ApiTokenRow | null = detail?.tokenRow ?? null;
  const subject: ProjectMembershipSubject | null = summary
    ? {
        kind: summary.type === 'group' ? 'group' : 'user',
        id: summary.id,
        name: summary.label,
        projectIds: (detail?.projects ?? []).filter((p) => (summary.type === 'group' ? true : p.via === 'direct' || p.via === 'legacy')).map((p) => p.id),
      }
    : null;

  return (
    <>
      <PrincipalDetailView
        summary={summary}
        detail={detail}
        loading={state.loading}
        error={state.error}
        projectId={projectId}
        canManage={canManage}
        locale={locale}
        labelOf={labelOf}
        t={t}
        onProjectChange={setProjectId}
        onRetry={() => setReload((n) => n + 1)}
        onOpen={onOpen}
        onBack={onBack}
        handlers={handlers}
        viewer={{ userId: context.me?.userId ?? null }}
        membersSlot={membersSlot}
      />

      {isUser && detail ? (
        <>
          <EditProfileShell
            open={edit === 'profile'}
            person={{
              id: summary.id,
              name: personName,
              email: personEmail,
              canLogin: extras?.canLogin !== false,
              managed: extras?.managed?.directory === true,
              provider,
            }}
            onClose={() => onEdit(null)}
            onSaved={refresh}
          />
          <ChangeRoleShell
            open={edit === 'role'}
            person={{ id: summary.id, name: personName, email: personEmail, role: summary.role ?? 'user', isSelf }}
            assignableRoles={assignable}
            onClose={() => onEdit(null)}
            onSaved={refresh}
          />
          <EditAccessShell
            open={edit === 'access'}
            person={
              extras?.servicePermissions
                ? { id: summary.id, name: personName, email: personEmail, role: summary.role ?? 'user', servicePermissions: extras.servicePermissions }
                : null
            }
            onClose={() => onEdit(null)}
            onSaved={refresh}
          />
          <MembershipShell
            mode="person"
            open={edit === 'memberships'}
            person={{ id: summary.id, name: personName, email: personEmail, groupIds: detail.groups.map((g) => g.id) }}
            onClose={() => onEdit(null)}
            onDone={refresh}
          />
        </>
      ) : null}

      {summary.type === 'group' && detail ? (
        <GroupShell
          open={edit === 'group'}
          group={{
            id: summary.id,
            name: summary.label,
            description: summary.sublabel ?? '',
            tenantRole: extras?.tenantRole ?? '',
            servicePermissions: extras?.servicePermissions ?? null,
            source: extras?.source ?? summary.source ?? 'local',
            memberCount: summary.memberCount,
          }}
          onClose={() => onEdit(null)}
          onSaved={refresh}
        />
      ) : null}

      <AddToProjectShell
        open={addProjectOpen}
        subject={subject}
        onClose={() => setAddProjectOpen(false)}
        onDone={refresh}
      />

      {projectEditor ? (
        <ProjectPermissionsEditor
          member={projectEditor.member}
          projectId={projectEditor.project.id}
          saving={savingProject}
          onClose={() => setProjectEditor(null)}
          onSave={(permissions) => {
            setSavingProject(true);
            directoryApi
              .saveProjectPermissions(projectEditor.project.id, summary.id, permissions)
              .then(() => {
                notifications.show({ message: td('toast.projectAccessSaved', { project: projectEditor.project.name }), color: 'green' });
                setProjectEditor(null);
                refresh();
              })
              .catch((error: unknown) => notifyError(error, td, tNotifications('errorTitle')))
              .finally(() => setSavingProject(false));
          }}
        />
      ) : null}

      {summary.type === 'token' ? (
        <TokenDetailModal
          token={edit === 'token' ? tokenRow : null}
          onClose={() => onEdit(null)}
          onSaved={() => refresh()}
          updateUrl={(tokenId) =>
            `/api/tokens/${encodeURIComponent(tokenId)}${extras?.projectId ? `?projectId=${encodeURIComponent(extras.projectId)}` : ''}`
          }
        />
      ) : null}

    </>
  );
}

// ── the drawer ────────────────────────────────────────────────────────────

interface DrawerProps {
  opened: boolean;
  target: PrincipalTarget | null;
  canManage: boolean;
  canGoBack: boolean;
  onBack: () => void;
  onClose: () => void;
  onOpen: (target: PrincipalTarget) => void;
  context: DrawerContext;
  /** False while a form or a confirmation is open: Escape belongs to it. */
  closeOnEscape?: boolean;
}

/** Side drawer with the access details of one principal; groups, tokens and owners opened from it can go back. */
export default function PrincipalDetailDrawer({
  opened,
  target,
  canManage,
  canGoBack,
  onBack,
  onClose,
  onOpen,
  context,
  closeOnEscape = true,
}: DrawerProps) {
  const t = useTranslations(NS);
  // Keep showing the last principal while the drawer slides out.
  const [shown, setShown] = useState<PrincipalTarget | null>(target);
  if (target && target !== shown) setShown(target);

  const handleBack = useCallback(() => onBack(), [onBack]);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="xl"
      title={t('drawer.title')}
      closeOnEscape={closeOnEscape}
      closeButtonProps={{ 'aria-label': t('drawer.close') }}
    >
      {shown ? (
        <PrincipalDetailContent
          key={`${shown.type}:${shown.id}`}
          target={shown}
          canManage={canManage}
          context={context}
          onOpen={onOpen}
          onBack={canGoBack ? handleBack : undefined}
        />
      ) : null}
    </Drawer>
  );
}
