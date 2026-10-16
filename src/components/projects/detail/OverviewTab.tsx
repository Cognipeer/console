'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button, Stack, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconFolder,
  IconKey,
  IconPlug,
  IconRefresh,
  IconRobot,
  IconUsers,
} from '@tabler/icons-react';
import { DetailCard, DetailTwoCol } from '@/components/common/ui/DetailShell';
import StatTile from '@/components/common/ui/StatTile';
import { CardSkeleton, StatGridSkeleton } from '@/components/common/ui/Skeletons';
import { principalHref, iamHref } from '@/components/iam/links';
import { formatDateTime, formatRelative } from '@/components/iam/timeFormat';
import { isAbortError } from '@/components/iam/principals/client';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import { useLocale, useTranslations } from '@/lib/i18n';
import { DOMAIN_LABELS } from '@/lib/services/serviceCatalog';
import type { ProviderDomain } from '@/lib/database';
import {
  buildReadinessItems,
  directorySettingsHref,
  hasDirectoryContent,
  isDirectoryGroup,
  isTranslatableAction,
  parseOverview,
  projectTabHref,
  readinessFixHref,
  readinessSummary,
  type OverviewAdmin,
  type OverviewRule,
  type ProjectOverviewData,
  type ReadinessItem,
} from './overviewModel';

const ADMINS_SHOWN = 8;

function domainLabel(domain: string): string {
  return DOMAIN_LABELS[domain as ProviderDomain] ?? domain;
}

function DetailRow({ label, children, mono = false }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="ds-row-between" style={{ padding: '6px 0', fontSize: 12.5, gap: 12 }}>
      <span className="ds-muted">{label}</span>
      <span className={mono ? 'ds-mono' : undefined} style={{ textAlign: 'right', minWidth: 0, wordBreak: 'break-word' }}>
        {children}
      </span>
    </div>
  );
}

/**
 * Project Overview: counts, what the project still needs before it can be used
 * (each gap with a one-click fix), recent activity, details, the directory
 * sign-in rules that reach it and who administers it.
 */
export default function OverviewTab({ projectId }: { projectId: string }) {
  const t = useTranslations('projectTabs.overview');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const user = useDashboardUser();
  const isTenantAdmin = user?.role === 'owner' || user?.role === 'admin';

  const [data, setData] = useState<ProjectOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/projects/${encodeURIComponent(projectId)}/overview`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const message = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
          throw new Error(typeof message === 'string' && message ? message : t('errors.load'));
        }
        const parsed = parseOverview(body);
        if (!parsed) throw new Error(t('errors.load'));
        if (!controller.signal.aborted) setData(parsed);
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : t('errors.load'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, reloadKey, t]);

  const readinessItems = useMemo(
    () => (data ? buildReadinessItems(data.readiness, data.stats) : []),
    [data],
  );

  if (loading && !data) {
    return (
      <Stack gap="md">
        <StatGridSkeleton count={4} delta label={tCommon('loading')} />
        <CardSkeleton lines={5} />
      </Stack>
    );
  }

  if (!data) {
    return (
      <div className="ds-card ds-empty" style={{ padding: 40 }}>
        <Text size="sm" c="dimmed" mb="sm">
          {error ?? t('errors.load')}
        </Text>
        <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={reload}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  const { project, stats, admins, rules, groups, activity } = data;
  const domainSummary = Object.entries(stats.providersByDomain)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([domain, count]) => `${domainLabel(domain).toLowerCase()} ${count}`)
    .join(' · ');
  const summary = readinessSummary(readinessItems);

  const canFix = (item: ReadinessItem): boolean => {
    if (!item.fix) return false;
    // Providers and limits are workspace-level settings; members the tab itself gates by project role.
    if (item.fix === 'providers' || item.fix === 'limits') return isTenantAdmin;
    return true;
  };

  const readinessLabel = (item: ReadinessItem): { title: string; detail?: string } => {
    if (item.id === 'model') {
      return {
        title: t('readiness.model'),
        detail: item.ok ? t('readiness.providerCount', { count: item.count ?? 0 }) : t('readiness.modelMissing'),
      };
    }
    if (item.id === 'admin') {
      const names = admins.filter((a) => a.kind === 'project_admin').map((a) => a.name || a.email);
      return {
        title: t('readiness.admin'),
        detail: item.ok
          ? names.length > 0
            ? names.slice(0, 2).join(', ')
            : t('readiness.adminViaGroup')
          : t('readiness.adminMissing'),
      };
    }
    if (item.id === 'limits') {
      return { title: t('readiness.limits'), detail: item.ok ? t('readiness.limitsSet') : t('readiness.limitsMissing') };
    }
    const domain = item.domain ?? '';
    return {
      title: t('readiness.domain', { domain: domainLabel(domain) }),
      detail: item.ok
        ? t('readiness.providerCount', { count: item.count ?? 0 })
        : t('readiness.domainMissing', { domain: domainLabel(domain).toLowerCase() }),
    };
  };

  const fixLabel = (item: ReadinessItem): string => {
    if (item.fix === 'members') return t('readiness.fixMembers');
    if (item.fix === 'limits') return t('readiness.fixLimits');
    return t('readiness.fixProviders');
  };

  const activityText = (entry: { action: string; summary: string }): string =>
    isTranslatableAction(entry.action) ? t(`activity.actions.${entry.action.replace('.', '_')}`) : entry.summary;

  const adminKindLabel = (admin: OverviewAdmin): string => t(`admins.kinds.${admin.kind}`);

  const ruleLine = (rule: OverviewRule): string => {
    const role = t(`roles.${rule.projects[0]?.role ?? 'member'}`);
    return t(`directory.${rule.mode}`, {
      role,
      when: t(`directory.${rule.applyOn}`),
    });
  };

  const syncedGroups = groups.filter(isDirectoryGroup);
  const shownAdmins = admins.slice(0, ADMINS_SHOWN);

  return (
    <Stack gap="md">
      <div className="ds-stat-grid">
        <StatTile
          label={t('stats.people')}
          icon={<IconUsers size={14} stroke={1.7} />}
          value={stats.people}
          delta={t('stats.peopleDetail', { direct: stats.members, groups: stats.groups })}
        />
        <StatTile
          label={t('stats.providers')}
          icon={<IconPlug size={14} stroke={1.7} />}
          value={stats.providers}
          delta={domainSummary || undefined}
        />
        <StatTile label={t('stats.agents')} icon={<IconRobot size={14} stroke={1.7} />} value={stats.agents} />
        <StatTile label={t('stats.tokens')} icon={<IconKey size={14} stroke={1.7} />} value={stats.tokens} />
      </div>

      <DetailTwoCol narrowAside>
        <Stack gap="md">
          <DetailCard
            title={t('readiness.title')}
            description={t('readiness.description')}
            actions={
              <span className={`ds-badge ${summary.done === summary.total ? 'ds-badge-ok' : 'ds-badge-warn'}`}>
                {t('readiness.progress', { done: summary.done, total: summary.total })}
              </span>
            }
          >
            <div role="list" aria-label={t('readiness.title')}>
              {readinessItems.map((item) => {
                const { title, detail } = readinessLabel(item);
                return (
                  <div
                    key={item.id}
                    role="listitem"
                    className="ds-row-between"
                    style={{ padding: '9px 0', borderTop: '1px solid var(--ds-border-soft)', gap: 12 }}
                  >
                    <div className="ds-row" style={{ gap: 10, minWidth: 0 }}>
                      {item.ok ? (
                        <IconCircleCheck size={18} stroke={1.8} color="var(--ds-ok)" aria-label={t('readiness.done')} />
                      ) : (
                        <IconAlertTriangle size={18} stroke={1.8} color="var(--ds-warn)" aria-label={t('readiness.todo')} />
                      )}
                      <div className="ds-col" style={{ gap: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{title}</span>
                        {detail ? (
                          <span className="ds-faint" style={{ fontSize: 12 }}>
                            {detail}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {item.fix && canFix(item) ? (
                      <Button
                        component={Link}
                        href={readinessFixHref(item.fix, project.id)}
                        size="xs"
                        variant="light"
                        color="teal"
                      >
                        {fixLabel(item)}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </DetailCard>

          <DetailCard
            title={t('activity.title')}
            actions={
              isTenantAdmin ? (
                <Button component={Link} href={iamHref('audit')} size="xs" variant="subtle">
                  {t('activity.openAudit')}
                </Button>
              ) : undefined
            }
          >
            {activity.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t('activity.empty')}
              </Text>
            ) : (
              <div role="list" aria-label={t('activity.title')}>
                {activity.map((entry, index) => (
                  <div
                    key={`${entry.at}-${entry.action}-${index}`}
                    role="listitem"
                    className="ds-row-between"
                    style={{
                      padding: '8px 0',
                      borderTop: index === 0 ? undefined : '1px solid var(--ds-border-soft)',
                      gap: 12,
                      fontSize: 13,
                    }}
                  >
                    <div className="ds-col" style={{ gap: 1, minWidth: 0 }}>
                      <span>{activityText(entry)}</span>
                      {entry.actor ? (
                        <span className="ds-faint" style={{ fontSize: 12 }}>
                          {t('activity.by', { name: entry.actor.name })}
                        </span>
                      ) : null}
                    </div>
                    <time
                      className="ds-faint"
                      style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                      dateTime={entry.at}
                      title={formatDateTime(entry.at, locale)}
                    >
                      {formatRelative(entry.at, locale)}
                    </time>
                  </div>
                ))}
              </div>
            )}
          </DetailCard>
        </Stack>

        <Stack gap="md">
          <DetailCard title={t('details.title')}>
            <DetailRow label={t('details.name')}>
              <span className="ds-row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <IconFolder size={13} stroke={1.7} />
                {project.name}
              </span>
            </DetailRow>
            <DetailRow label={t('details.key')} mono>
              {project.key || '—'}
            </DetailRow>
            <DetailRow label={t('details.id')} mono>
              {project.id.length > 12 ? `${project.id.slice(0, 4)}…${project.id.slice(-4)}` : project.id}
            </DetailRow>
            <DetailRow label={t('details.description')}>{project.description || '—'}</DetailRow>
            <DetailRow label={t('details.created')}>{formatDateTime(project.createdAt, locale)}</DetailRow>
          </DetailCard>

          {hasDirectoryContent(data) ? (
            <DetailCard title={t('directory.title')} description={t('directory.description')}>
              <Stack gap="xs">
                {rules.map((rule) => (
                  <div key={`${rule.source}-${rule.label ?? ''}`} className="ds-col" style={{ gap: 2, fontSize: 13 }}>
                    <span className="ds-row" style={{ gap: 6 }}>
                      <span className="ds-badge ds-badge-info">{t(`directory.sources.${rule.source}`)}</span>
                      {rule.label ? <span style={{ fontWeight: 500 }}>{rule.label}</span> : null}
                    </span>
                    <span className="ds-faint" style={{ fontSize: 12 }}>
                      {ruleLine(rule)}
                    </span>
                  </div>
                ))}
                {syncedGroups.length > 0 ? (
                  <div className="ds-col" style={{ gap: 4, marginTop: rules.length > 0 ? 6 : 0 }}>
                    <span className="ds-eyebrow">{t('directory.groups')}</span>
                    {syncedGroups.map((group) => (
                      <div key={group.groupId} className="ds-row-between" style={{ fontSize: 13, gap: 8 }}>
                        <Link
                          href={isTenantAdmin ? principalHref('group', group.groupId) : projectTabHref(project.id, 'members')}
                          style={{ color: 'var(--ds-text)' }}
                        >
                          {group.name}
                        </Link>
                        <span className="ds-faint" style={{ fontSize: 12 }}>
                          {t(`roles.${group.role}`)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {isTenantAdmin && rules.length > 0 ? (
                  <div className="ds-row" style={{ gap: 4, flexWrap: 'wrap' }}>
                    {[...new Set(rules.map((rule) => rule.source))].map((source) => (
                      <Button
                        key={source}
                        component={Link}
                        href={directorySettingsHref(source)}
                        size="xs"
                        variant="subtle"
                        style={{ paddingLeft: 0 }}
                      >
                        {t(`directory.edit.${source}`)}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </Stack>
            </DetailCard>
          ) : null}

          <DetailCard
            title={t('admins.title')}
            actions={
              <Button component={Link} href={projectTabHref(project.id, 'members')} size="xs" variant="subtle">
                {t('admins.manage')}
              </Button>
            }
          >
            {admins.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t('admins.empty')}
              </Text>
            ) : (
              <div role="list" aria-label={t('admins.title')}>
                {shownAdmins.map((admin) => (
                  <div key={admin.userId} role="listitem" className="ds-row-between" style={{ padding: '6px 0', gap: 8 }}>
                    <div className="ds-col" style={{ gap: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{admin.name || admin.email}</span>
                      {admin.name && admin.email ? (
                        <span className="ds-faint" style={{ fontSize: 11 }}>
                          {admin.email}
                        </span>
                      ) : null}
                    </div>
                    <span className={`ds-badge ${admin.kind === 'project_admin' ? 'ds-badge-teal' : ''}`}>
                      {adminKindLabel(admin)}
                    </span>
                  </div>
                ))}
                {admins.length > shownAdmins.length ? (
                  <Text size="xs" c="dimmed" mt={4}>
                    {t('admins.more', { count: admins.length - shownAdmins.length })}
                  </Text>
                ) : null}
              </div>
            )}
          </DetailCard>
        </Stack>
      </DetailTwoCol>
    </Stack>
  );
}
