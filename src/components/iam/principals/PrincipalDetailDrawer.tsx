'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  CopyButton,
  Drawer,
  Group,
  Paper,
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
  IconExternalLink,
  IconHistory,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconUsersGroup,
} from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import AttachedPolicies from './AttachedPolicies';
import {
  fetchPrincipalDetail,
  iamLinks,
  IamApiError,
  isAbortError,
  isSimulatable,
  ownedTokenSummary,
  type OwnedToken,
  type PrincipalDetail,
  type PrincipalExtras,
  type PrincipalSummary,
  type PrincipalType,
  type ProjectRef,
} from './client';
import EffectivePermissions from './EffectivePermissions';
import { formatDateTime, formatRelativeTime, translateOr, type Translate } from './format';
import styles from './PrincipalDetail.module.css';
import { useServiceLabels } from './serviceLabels';
import { badgeVariant, PrincipalAvatar, principalColor, roleColor, statusColor } from './visuals';

const NS = 'iamPrincipals';
/** More projects than this are folded behind "Show all". */
const PROJECTS_SHOWN = 8;

/** The principal the drawer shows; `summary` is the list row it was opened from. */
export interface PrincipalTarget {
  type: PrincipalType;
  id: string;
  summary?: PrincipalSummary | null;
}

function Section({
  title,
  hint,
  right,
  children,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Paper withBorder p="md" radius="md">
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

function Muted({ children }: { children: ReactNode }) {
  return (
    <Text size="sm" c="dimmed">
      {children}
    </Text>
  );
}

// ── identity ──────────────────────────────────────────────────────────────

/** The badges under the name: what kind of principal it is and what state it is in. */
function IdentityBadges({
  summary,
  extras,
  t,
}: {
  summary: PrincipalSummary;
  extras: PrincipalExtras;
  t: Translate;
}) {
  const { type } = summary;
  const roleText = summary.role ? translateOr(t, NS, `roles.${summary.role}`, summary.role) : null;
  const statusText = summary.status ? translateOr(t, NS, `statuses.${summary.status}`, summary.status) : null;
  const provider = extras.authProvider && extras.authProvider !== 'local' ? extras.authProvider : null;

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
        <Badge variant="default" radius="sm" tt="none">
          {translateOr(t, NS, `drawer.meta.authProvider.${provider}`, provider)}
        </Badge>
      ) : null}
      {extras.canLogin === false ? (
        <Tooltip label={t('drawer.meta.noLoginHint')} withArrow multiline w={240}>
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
    </Group>
  );
}

/** Token facts and group grants, under the badges. */
function IdentityFacts({
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
  onOpen: (target: PrincipalTarget) => void;
}) {
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

// ── projects and tokens ───────────────────────────────────────────────────

function ProjectRow({ project, t }: { project: ProjectRef; t: Translate }) {
  const via =
    project.via === 'group'
      ? project.groupName
        ? t('drawer.projects.via.group', { name: project.groupName })
        : t('drawer.projects.via.groupUnnamed')
      : project.via
        ? translateOr(t, NS, `drawer.projects.via.${project.via}`, '')
        : '';
  return (
    <div className={styles.listRow}>
      <div style={{ minWidth: 0 }}>
        <Text size="sm" fw={500} style={{ wordBreak: 'break-word' }}>
          {project.name}
        </Text>
        {via ? (
          <Text size="xs" c="dimmed">
            {via}
          </Text>
        ) : null}
      </div>
      {project.role ? (
        <Badge size="sm" variant="default" tt="none">
          {translateOr(t, NS, `drawer.projects.role.${project.role}`, project.role)}
        </Badge>
      ) : null}
    </div>
  );
}

function ProjectsList({ projects, t }: { projects: ProjectRef[]; t: Translate }) {
  const [all, setAll] = useState(false);
  const shown = all ? projects : projects.slice(0, PROJECTS_SHOWN);
  return (
    <Stack gap="xs" align="stretch">
      <div className={styles.bordered}>
        {shown.map((p) => (
          <ProjectRow key={p.id} project={p} t={t} />
        ))}
      </div>
      {projects.length > PROJECTS_SHOWN ? (
        <Button size="compact-xs" variant="subtle" style={{ alignSelf: 'flex-start' }} onClick={() => setAll((v) => !v)}>
          {all ? t('drawer.projects.showFewer') : t('drawer.projects.showAll', { count: projects.length })}
        </Button>
      ) : null}
    </Stack>
  );
}

function OwnedTokens({
  tokens,
  locale,
  t,
  onOpen,
}: {
  tokens: OwnedToken[];
  locale: string;
  t: Translate;
  onOpen: (target: PrincipalTarget) => void;
}) {
  return (
    <div className={styles.bordered}>
      {tokens.map((token) => (
        <button
          key={token.id}
          type="button"
          className={`${styles.listRow} ${styles.listRowButton}`}
          onClick={() => onOpen({ type: 'token', id: token.id, summary: ownedTokenSummary(token) })}
        >
          <div style={{ minWidth: 0 }}>
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
          </div>
          <Group gap={6} wrap="nowrap" align="flex-start">
            {token.status ? (
              <Badge size="sm" variant={badgeVariant(statusColor(token.status))} color={statusColor(token.status)}>
                {translateOr(t, NS, `statuses.${token.status}`, token.status)}
              </Badge>
            ) : null}
            <Badge size="sm" variant={token.scoped ? 'light' : 'default'} color="orange" tt="none">
              {token.scoped ? t('drawer.meta.scoped') : t('drawer.meta.unscoped')}
            </Badge>
          </Group>
        </button>
      ))}
    </div>
  );
}

// ── the detail view (pure: data in, markup out) ───────────────────────────

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
}

const NO_EXTRAS: PrincipalExtras = {
  ownerId: null,
  ownerLabel: null,
  expiresAt: null,
  lastUsedAt: null,
  scoped: null,
  authProvider: null,
  canLogin: null,
  source: null,
  tenantRole: null,
};

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
}: PrincipalDetailViewProps) {
  const { type, id } = summary;
  const extras = detail?.extras ?? NO_EXTRAS;
  const projects = detail?.projects ?? [];
  const groups = detail?.groups ?? [];
  const tokens = detail?.tokens ?? null;
  const detailPolicies = detail?.policies;
  const policies = useMemo(() => detailPolicies ?? [], [detailPolicies]);
  const policyNames = useMemo(() => new Map(policies.map((p) => [p.policyId, p.name])), [policies]);

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

      {/* actions */}
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
        {type === 'user' ? (
          <Button
            component={Link}
            href={iamLinks.member(id)}
            size="xs"
            variant="subtle"
            rightSection={<IconExternalLink size={12} />}
          >
            {t('drawer.actions.openMember')}
          </Button>
        ) : null}
      </Group>

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
              <EffectivePermissions rows={detail.effective} labelOf={labelOf} policyNames={policyNames} t={t} />
            </div>
          </Section>

          {type !== 'group' || groups.length > 0 ? (
            <Section title={t('drawer.groups.title')} hint={t('drawer.groups.hint')}>
              {groups.length === 0 ? (
                <Muted>{t('drawer.groups.empty')}</Muted>
              ) : (
                <Group gap="xs" wrap="wrap">
                  {groups.map((g) => (
                    <Button
                      key={g.id}
                      size="compact-sm"
                      variant="light"
                      color="teal"
                      leftSection={<IconUsersGroup size={14} />}
                      onClick={() => onOpen({ type: 'group', id: g.id })}
                    >
                      {g.name}
                    </Button>
                  ))}
                </Group>
              )}
            </Section>
          ) : null}

          <Section title={t('drawer.projects.title')}>
            {projects.length === 0 ? <Muted>{t('drawer.projects.empty')}</Muted> : <ProjectsList projects={projects} t={t} />}
          </Section>

          <Section title={t('drawer.policies.title')} hint={t('drawer.policies.hint')}>
            <AttachedPolicies
              policies={policies}
              principal={{ type, id }}
              groups={groups}
              ownerId={extras.ownerId}
              locale={locale}
              t={t}
            />
          </Section>

          {type === 'user' && tokens ? (
            <Section title={t('drawer.tokens.title')} hint={t('drawer.tokens.hint')}>
              {tokens.length === 0 ? (
                <Muted>{t('drawer.tokens.empty')}</Muted>
              ) : (
                <OwnedTokens tokens={tokens} locale={locale} t={t} onOpen={onOpen} />
              )}
            </Section>
          ) : null}
        </>
      ) : null}
    </Stack>
  );
}

// ── container: fetches the detail of one principal ────────────────────────

function describeError(err: unknown, t: Translate): string {
  if (err instanceof IamApiError) {
    if (err.status === 403) return t('errors.forbidden');
    if (err.status === 404) return t('errors.notFound');
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

interface ContentProps {
  target: PrincipalTarget;
  canManage: boolean;
  onOpen: (target: PrincipalTarget) => void;
  onBack?: () => void;
}

function PrincipalDetailContent({ target, canManage, onOpen, onBack }: ContentProps) {
  const t = useTranslations(NS);
  const locale = useLocale();
  const { labelOf } = useServiceLabels();
  const [projectId, setProjectId] = useState('');
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ detail: PrincipalDetail | null; loading: boolean; error: string | null }>({
    detail: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchPrincipalDetail(target.type, target.id, projectId || null, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setState({ detail, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setState((s) => ({ ...s, loading: false, error: describeError(err, t) }));
      });
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

  return (
    <PrincipalDetailView
      summary={state.detail?.principal ?? fallback}
      detail={state.detail}
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
    />
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
      closeButtonProps={{ 'aria-label': t('drawer.close') }}
    >
      {shown ? (
        <PrincipalDetailContent
          key={`${shown.type}:${shown.id}`}
          target={shown}
          canManage={canManage}
          onOpen={onOpen}
          onBack={canGoBack ? handleBack : undefined}
        />
      ) : null}
    </Drawer>
  );
}
