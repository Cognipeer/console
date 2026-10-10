'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconChecklist,
  IconFolderShare,
  IconGauge,
  IconHistory,
  IconKey,
  IconPlus,
  IconRefresh,
  IconShieldLock,
} from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  iamApi,
  type EngineStats,
  type EngineStatus,
  type PoliciesResponse,
} from '../api';
import { emptyAuditFilters, fetchAudit, type AuditPage } from '../audit/client';
import { formatAuditText } from '../audit/summaryText';
import { checkHref, iamHref, newPolicyHref, policyHref } from '../links';
import { fetchPrincipals, isAbortError, type PrincipalPage, type PrincipalType } from '../principals/client';
import { formatRelativeTime, shortId } from '../principals/format';
import { PrincipalAvatar } from '../principals/visuals';
import {
  countLabel,
  countPolicies,
  formatMicros,
  formatRate,
  skippedPolicies,
} from './overviewModel';

/** A directory count is read from one page of this size: exact up to it, "N+" beyond. */
const COUNT_PAGE = 100;
const RECENT_DENIALS = 5;
const PROJECTS_HREF = '/dashboard/projects';

type Loaded<T> = { status: 'loading' } | { status: 'ok'; value: T } | { status: 'error'; error: unknown };

const LOADING: Loaded<never> = { status: 'loading' };

async function settle<T>(work: Promise<T>): Promise<Loaded<T>> {
  try {
    return { status: 'ok', value: await work };
  } catch (error) {
    return { status: 'error', error };
  }
}

interface OverviewData {
  policies: Loaded<PoliciesResponse>;
  stats: Loaded<EngineStats>;
  denials: Loaded<AuditPage>;
  users: Loaded<PrincipalPage>;
  groups: Loaded<PrincipalPage>;
  tokens: Loaded<PrincipalPage>;
}

const INITIAL: OverviewData = {
  policies: LOADING,
  stats: LOADING,
  denials: LOADING,
  users: LOADING,
  groups: LOADING,
  tokens: LOADING,
};

const STATUS_COLOR: Record<EngineStatus, string> = { ok: 'green', degraded: 'yellow', down: 'red' };

function Card({ title, hint, children, right }: { title: string; hint?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <div style={{ minWidth: 0 }}>
            <Text fw={600}>{title}</Text>
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

function Figure({ label, value, color, testId }: { label: string; value: ReactNode; color?: string; testId?: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="lg" c={color} data-testid={testId}>
        {value}
      </Text>
    </div>
  );
}

function Skeletons({ rows = 3 }: { rows?: number }) {
  return (
    <Stack gap="xs" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={18} radius="sm" />
      ))}
    </Stack>
  );
}

export default function OverviewTab({ canManage }: { canManage: boolean }) {
  const t = useTranslations('iamOverview');
  const tAudit = useTranslations('iamAudit');
  const tCenter = useTranslations('iamCenter');
  const locale = useLocale();

  const [data, setData] = useState<OverviewData>(INITIAL);
  const [refreshing, setRefreshing] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setRefreshing(true);
    const page = (type: PrincipalType) => settle(fetchPrincipals({ type, limit: COUNT_PAGE }, signal));
    void Promise.all([
      settle(iamApi.listPolicies(signal)),
      settle(iamApi.getEngineStats(signal)),
      settle(fetchAudit(emptyAuditFilters('denials'), { limit: RECENT_DENIALS }, signal)),
      page('user'),
      page('group'),
      page('token'),
    ]).then(([policies, stats, denials, users, groups, tokens]) => {
      if (signal.aborted) return;
      setData({ policies, stats, denials, users, groups, tokens });
      setRefreshing(false);
    });
    return () => controller.abort();
  }, [reload]);

  const describe = useCallback(
    (error: unknown): string => {
      if (isAbortError(error)) return '';
      // The center's two clients throw their own error classes; both carry the HTTP status.
      const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
      if (status === 403) return t('errors.forbidden');
      return error instanceof Error && error.message ? error.message : t('errors.failed');
    },
    [t],
  );

  const failure = (state: Loaded<unknown>): ReactNode =>
    state.status === 'error' ? (
      <Text size="sm" c="dimmed">
        {describe(state.error)}
      </Text>
    ) : null;

  const policies = data.policies.status === 'ok' ? data.policies.value : null;
  const counts = useMemo(() => (policies ? countPolicies(policies.custom) : null), [policies]);
  const stats = data.stats.status === 'ok' ? data.stats.value : null;
  const skipped = useMemo(
    () => (stats?.policySet && policies ? skippedPolicies(stats.policySet.skipped, policies.custom) : []),
    [stats, policies],
  );

  const everythingFailed = Object.values(data).every((section) => section.status === 'error');

  const countOf = (state: Loaded<PrincipalPage>): ReactNode => {
    if (state.status === 'loading') return <Loader size="xs" />;
    if (state.status === 'error') return '—';
    return countLabel(state.value.items.length, state.value.nextCursor !== null, locale);
  };

  // ── alerts: what needs somebody's attention ───────────────────────────────

  const alerts: ReactNode[] = [];
  if (stats && stats.health.status !== 'ok') {
    alerts.push(
      <Alert
        key="health"
        color={stats.health.status === 'down' ? 'red' : 'yellow'}
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        title={t(`alerts.health.${stats.health.status}.title`)}
        data-testid="overview-health-alert"
      >
        <Text size="sm">{stats.health.message ?? t(`alerts.health.${stats.health.status}.body`)}</Text>
      </Alert>,
    );
  }
  if (skipped.length > 0 || (stats?.policySet?.skipped.length ?? 0) > 0) {
    const count = stats?.policySet?.skipped.length ?? skipped.length;
    alerts.push(
      <Alert
        key="skipped"
        color="orange"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        title={t('alerts.skipped.title', { count })}
        data-testid="overview-skipped-alert"
      >
        <Stack gap={4}>
          <Text size="sm">{t('alerts.skipped.body')}</Text>
          {skipped.length > 0 ? (
            <Group gap="xs">
              {skipped.map((p) => (
                <Anchor key={p.policyId} component={Link} href={policyHref(p.policyId)} size="sm">
                  {p.name}
                </Anchor>
              ))}
            </Group>
          ) : null}
        </Stack>
      </Alert>,
    );
  }
  if (stats && stats.undeclaredRoutes.count > 0) {
    alerts.push(
      <Alert
        key="undeclared"
        color="orange"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        title={t('alerts.undeclared.title', { count: stats.undeclaredRoutes.count })}
        data-testid="overview-undeclared-alert"
      >
        <Stack gap={4}>
          <Text size="sm">{t('alerts.undeclared.body')}</Text>
          {stats.undeclaredRoutes.sample.slice(0, 5).map((route) => (
            <Text key={`${route.method} ${route.url}`} size="xs" ff="monospace">
              {route.method} {route.url}
            </Text>
          ))}
        </Stack>
      </Alert>,
    );
  }
  if (stats && stats.unavailable > 0) {
    alerts.push(
      <Alert
        key="unavailable"
        color="yellow"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        title={t('alerts.unavailable.title', { count: stats.unavailable.toLocaleString(locale) })}
        data-testid="overview-unavailable-alert"
      >
        <Stack gap={4} align="flex-start">
          <Text size="sm">
            {t('alerts.unavailable.body', {
              when: stats.lastUnavailableAt ? formatRelativeTime(stats.lastUnavailableAt, { locale }) : '—',
              reason: stats.lastUnavailableReason ? t(`unavailableReason.${stats.lastUnavailableReason}`) : '—',
            })}
          </Text>
          <Anchor component={Link} href={iamHref('audit')} size="sm">
            {t('denials.viewAll')}
          </Anchor>
        </Stack>
      </Alert>,
    );
  }

  // ── cards ──────────────────────────────────────────────────────────────────

  const denials = data.denials.status === 'ok' ? data.denials.value.items : null;

  const shortcuts: Array<{ href: string; icon: ReactNode; title: string; text: string; id: string }> = [
    { id: 'check', href: checkHref({}), icon: <IconChecklist size={18} />, title: t('links.check.title'), text: t('links.check.text') },
    { id: 'audit', href: iamHref('audit'), icon: <IconHistory size={18} />, title: t('links.audit.title'), text: t('links.audit.text') },
    { id: 'limits', href: iamHref('limits'), icon: <IconGauge size={18} />, title: t('links.limits.title'), text: t('links.limits.text') },
    { id: 'tokens', href: iamHref('settings'), icon: <IconKey size={18} />, title: t('links.tokens.title'), text: t('links.tokens.text') },
    { id: 'projects', href: PROJECTS_HREF, icon: <IconFolderShare size={18} />, title: t('links.projects.title'), text: t('links.projects.text') },
  ];

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <div style={{ flex: 1, minWidth: 240 }}>
          <Text fw={600}>{t('title')}</Text>
          <Text size="sm" c="dimmed" maw={760}>
            {t('description')}
          </Text>
        </div>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconRefresh size={14} />}
          loading={refreshing}
          onClick={() => setReload((n) => n + 1)}
        >
          {t('refresh')}
        </Button>
      </Group>

      {everythingFailed ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('errors.loadFailed')}>
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{describe(data.policies.status === 'error' ? data.policies.error : null)}</Text>
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => setReload((n) => n + 1)}>
              {t('retry')}
            </Button>
          </Stack>
        </Alert>
      ) : null}

      {alerts.length > 0 ? <Stack gap="sm">{alerts}</Stack> : null}

      <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md">
        {/* Engine */}
        <Card
          title={t('engine.title')}
          hint={t('engine.hint')}
          right={
            stats ? (
              <Badge color={STATUS_COLOR[stats.health.status]} variant="light" data-testid="overview-engine-status">
                {t(`engine.status.${stats.health.status}`)}
              </Badge>
            ) : undefined
          }
        >
          {data.stats.status === 'loading' ? <Skeletons /> : null}
          {data.stats.status === 'error' ? <Text size="sm" c="dimmed">{t('engine.unavailable')}</Text> : null}
          {stats ? (
            <Stack gap="sm">
              <SimpleGrid cols={3} spacing="sm">
                <Figure label={t('engine.decisions')} value={stats.decisions.toLocaleString(locale)} testId="overview-decisions" />
                <Figure label={t('engine.allowed')} value={stats.allows.toLocaleString(locale)} />
                <Figure
                  label={t('engine.denied')}
                  value={stats.denies.toLocaleString(locale)}
                  color={stats.denies > 0 ? 'red' : undefined}
                />
              </SimpleGrid>
              {stats.statsScope === 'process' ? (
                <SimpleGrid cols={3} spacing="sm">
                  <Figure label={t('engine.median')} value={formatMicros(stats.p50Us)} />
                  <Figure label={t('engine.p99')} value={formatMicros(stats.p99Us)} />
                  <Figure label={t('engine.cache')} value={formatRate(stats.cacheHitRate)} />
                </SimpleGrid>
              ) : null}
              <Text size="xs" c="dimmed">
                {stats.statsScope === 'process' ? t('engine.sinceProcess') : t('engine.sinceTenant')}
              </Text>
            </Stack>
          ) : null}
        </Card>

        {/* Policies */}
        <Card title={t('policies.title')} hint={t('policies.hint')}>
          {data.policies.status === 'loading' ? <Skeletons /> : null}
          {failure(data.policies)}
          {counts && policies ? (
            <Stack gap="sm">
              <SimpleGrid cols={3} spacing="sm">
                <Figure label={t('policies.enabled')} value={counts.enabled.toLocaleString(locale)} color="teal" testId="overview-policies-enabled" />
                <Figure label={t('policies.disabled')} value={counts.disabled.toLocaleString(locale)} testId="overview-policies-disabled" />
                <Figure label={t('policies.builtIn')} value={policies.managed.length.toLocaleString(locale)} />
              </SimpleGrid>
              {counts.total === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('policies.none')}
                </Text>
              ) : (
                <Group gap="xs">
                  <Badge variant="light" color="green">
                    {t('policies.allowRules', { count: counts.allowRules })}
                  </Badge>
                  <Badge variant="light" color="red">
                    {t('policies.denyRules', { count: counts.denyRules })}
                  </Badge>
                </Group>
              )}
              <Group gap="xs">
                <Button component={Link} href={iamHref('policies')} size="xs" variant="default">
                  {t('policies.manage')}
                </Button>
                {canManage ? (
                  <Button component={Link} href={newPolicyHref()} size="xs" leftSection={<IconPlus size={14} />}>
                    {t('policies.create')}
                  </Button>
                ) : null}
              </Group>
            </Stack>
          ) : null}
        </Card>

        {/* People */}
        <Card title={t('people.title')} hint={t('people.hint')}>
          <SimpleGrid cols={3} spacing="sm">
            <Figure label={t('people.users')} value={countOf(data.users)} testId="overview-users" />
            <Figure label={t('people.groups')} value={countOf(data.groups)} testId="overview-groups" />
            <Figure label={t('people.tokens')} value={countOf(data.tokens)} testId="overview-tokens" />
          </SimpleGrid>
          <Group gap="xs">
            <Button
              component={Link}
              href={iamHref('principals', { principalType: 'user' })}
              size="xs"
              variant="default"
            >
              {t('people.open')}
            </Button>
          </Group>
        </Card>
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        {/* Recent denials */}
        <Card
          title={t('denials.title')}
          hint={t('denials.hint')}
          right={
            <Button component={Link} href={iamHref('audit')} size="compact-xs" variant="subtle">
              {t('denials.viewAll')}
            </Button>
          }
        >
          {data.denials.status === 'loading' ? <Skeletons rows={4} /> : null}
          {failure(data.denials)}
          {denials && denials.length === 0 ? (
            <Text size="sm" c="dimmed" data-testid="overview-no-denials">
              {t('denials.empty')}
            </Text>
          ) : null}
          {denials && denials.length > 0 ? (
            <Stack gap="xs" data-testid="overview-denials">
              {denials.map((item) => (
                <Group key={item.id} gap="sm" wrap="nowrap" align="flex-start">
                  <PrincipalAvatar type={item.principal?.type ?? 'user'} label={item.principal?.label ?? '?'} size={28} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Text size="sm" lineClamp={2}>
                      {formatAuditText(item, tAudit, tCenter)}
                    </Text>
                    <Group gap="xs">
                      <Text size="xs" c="dimmed">
                        {item.principal?.label ?? '—'} · {formatRelativeTime(item.at, { locale })}
                      </Text>
                      {item.code === 'authorization_unavailable' ? (
                        <Badge size="xs" variant="light" color="yellow">
                          {t('denials.unavailable')}
                        </Badge>
                      ) : null}
                    </Group>
                  </div>
                  {item.decisionId ? (
                    <Anchor component={Link} href={checkHref({ decisionId: item.decisionId })} size="xs" ff="monospace">
                      {shortId(item.decisionId)}
                    </Anchor>
                  ) : null}
                </Group>
              ))}
            </Stack>
          ) : null}
        </Card>

        {/* Shortcuts */}
        <Card title={t('links.title')}>
          <Stack gap={4}>
            {shortcuts.map((link) => (
              <UnstyledButton
                key={link.id}
                component={Link}
                href={link.href}
                data-testid={`overview-link-${link.id}`}
                style={{ display: 'block', padding: '8px 10px', borderRadius: 8 }}
              >
                <Group gap="sm" wrap="nowrap" align="flex-start">
                  <span aria-hidden style={{ display: 'inline-flex', marginTop: 2 }}>
                    {link.icon}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" fw={500}>
                      {link.title}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {link.text}
                    </Text>
                  </div>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        </Card>
      </SimpleGrid>

      <Group gap={6} c="dimmed">
        <IconShieldLock size={14} />
        <Text size="xs" c="dimmed">
          {t('footnote')}
        </Text>
      </Group>
    </Stack>
  );
}
