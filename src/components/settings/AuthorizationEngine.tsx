'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { useConfirm } from '@/components/common/confirm';
import {
  ApiError,
  CATEGORIES,
  CATEGORY_I18N,
  parseMode,
  parseStats,
  parseSummary,
  readJson,
  type Category,
  type EngineStats,
  type Mode,
  type Summary,
} from './authorizationEngineData';

const CATEGORY_COLOR: Record<Category, string> = {
  'parity-mismatch': 'red',
  'token-groups': 'blue',
  'project-narrowing': 'orange',
  'unmapped-path': 'gray',
};

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function formatMicros(v: number | null): string {
  if (v === null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(2)} ms` : `${Math.round(v)} µs`;
}

function formatTime(v?: string): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
}

const KNOWN_ERROR_CODES = ['engine_unavailable', 'mode_unavailable', 'invalid_mode'] as const;

export default function AuthorizationEngine() {
  const t = useTranslations('iam');
  const confirm = useConfirm();

  const [mode, setMode] = useState<Mode | null>(null);
  const [savingMode, setSavingMode] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMode(parseMode(await readJson('/api/iam/mode')));
      const [s, st] = await Promise.allSettled([
        readJson('/api/iam/shadow/summary'),
        readJson('/api/iam/engine/stats'),
      ]);
      if (s.status === 'fulfilled') {
        setSummary(parseSummary(s.value));
        setSummaryError(null);
      } else {
        setSummaryError(s.reason instanceof Error ? s.reason.message : String(s.reason));
      }
      if (st.status === 'fulfilled') {
        setStats(parseStats(st.value));
        setStatsError(null);
      } else {
        setStatsError(st.reason instanceof Error ? st.reason.message : String(st.reason));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const describeError = useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError) {
        if (err.status === 403) return t('errors.forbidden');
        const code = (KNOWN_ERROR_CODES as readonly string[]).includes(err.code ?? '') ? err.code : undefined;
        if (code) return t(`errors.${code}`);
      }
      return err instanceof Error ? err.message : String(err);
    },
    [t],
  );

  const changeMode = useCallback(
    async (next: Mode) => {
      if (next === mode) return;
      setSavingMode(true);
      try {
        // Not optimistic: the control follows what the server confirms.
        const data = await readJson('/api/iam/mode', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: next }),
        });
        setMode(parseMode(data));
        notifications.show({ color: 'green', message: t('modeSaved') });
        void load();
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) setReadOnly(true);
        notifications.show({ color: 'red', title: t('modeFailed'), message: describeError(err) });
      } finally {
        setSavingMode(false);
      }
    },
    [describeError, load, mode, t],
  );

  const resetShadow = useCallback(async () => {
    const ok = await confirm.confirm({
      title: t('resetConfirmTitle'),
      message: t('resetConfirmMessage'),
      confirmLabel: t('reset'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await readJson('/api/iam/shadow/reset', { method: 'POST' });
      notifications.show({ color: 'green', message: t('resetDone') });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setReadOnly(true);
      notifications.show({ color: 'red', message: describeError(err) });
    }
  }, [confirm, describeError, load, t]);

  const categoryLabel = useCallback(
    (c: string) => (c in CATEGORY_I18N ? t(`categories.${CATEGORY_I18N[c as Category]}.title`) : c),
    [t],
  );

  const mismatches = summary?.categories['parity-mismatch'].events ?? 0;
  const totalEvents = summary?.totalEvents ?? 0;

  if (loading && mode === null) {
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
      </Group>
    );
  }

  if (error) {
    return (
      <Alert color="red" title={t('loadFailed')} icon={<IconAlertTriangle size={16} />}>
        <Stack gap="xs">
          <Text size="sm">{error}</Text>
          <div>
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => void load()}>
              {t('refresh')}
            </Button>
          </div>
        </Stack>
      </Alert>
    );
  }

  return (
    <Stack gap="lg">
      {/* Mode */}
      <Paper withBorder p="md" radius="md">
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <div>
              <Text fw={600}>{t('mode.title')}</Text>
              <Text size="sm" c="dimmed" maw={680}>
                {t('mode.description')}
              </Text>
            </div>
            <SegmentedControl
              value={mode ?? 'legacy'}
              disabled={savingMode || readOnly}
              onChange={(v) => void changeMode(v as Mode)}
              data={[
                { value: 'legacy', label: t('mode.legacy') },
                { value: 'shadow', label: t('mode.shadow') },
              ]}
            />
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
            <ModeNote active={mode === 'legacy'} title={t('mode.legacy')} text={t('mode.legacyHelp')} />
            <ModeNote active={mode === 'shadow'} title={t('mode.shadow')} text={t('mode.shadowHelp')} />
            <ModeNote active={false} muted title={t('mode.enforce')} text={t('mode.enforceHelp')} />
          </SimpleGrid>
        </Stack>
      </Paper>

      {mismatches > 0 ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('mismatchAlertTitle')}>
          {t('mismatchAlertBody', { count: mismatches })}
        </Alert>
      ) : null}

      {/* Toolbar */}
      <Group justify="space-between">
        <Text fw={600}>{t('report.title')}</Text>
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            leftSection={<IconRefresh size={14} />}
            loading={loading}
            onClick={() => void load()}
          >
            {t('refresh')}
          </Button>
          <Button
            size="xs"
            variant="default"
            color="red"
            leftSection={<IconTrash size={14} />}
            disabled={readOnly}
            onClick={() => void resetShadow()}
          >
            {t('reset')}
          </Button>
        </Group>
      </Group>

      {readOnly ? <Alert color="yellow">{t('errors.forbidden')}</Alert> : null}

      {summaryError ? (
        <Alert color="red" title={t('report.summaryFailed')} icon={<IconAlertTriangle size={16} />}>
          <Stack gap="xs">
            <Text size="sm">{summaryError}</Text>
            <div>
              <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => void load()}>
                {t('refresh')}
              </Button>
            </div>
          </Stack>
        </Alert>
      ) : null}

      {summary && !summaryError ? (
        <>
          {mode === 'legacy' && totalEvents === 0 ? <Alert color="gray">{t('report.legacyEmpty')}</Alert> : null}
          {mode === 'legacy' && totalEvents > 0 ? <Alert color="gray">{t('report.paused')}</Alert> : null}
          {mode === 'shadow' && totalEvents === 0 ? <Alert color="blue">{t('report.collecting')}</Alert> : null}
          {summary.dropped.keys > 0 || summary.dropped.events > 0 ? (
            <Alert color="orange" icon={<IconAlertTriangle size={16} />}>
              {t('report.dropped', {
                events: summary.dropped.events.toLocaleString(),
                keys: summary.dropped.keys.toLocaleString(),
              })}
            </Alert>
          ) : null}
        </>
      ) : null}

      {/* Category cards */}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        {CATEGORIES.map((c) => {
          const totals = summary?.categories[c];
          const count = totals?.events ?? 0;
          const key = CATEGORY_I18N[c];
          return (
            <Paper key={c} withBorder p="md" radius="md">
              <Stack gap={6}>
                <Group justify="space-between" wrap="nowrap">
                  <Text size="sm" fw={600}>
                    {t(`categories.${key}.title`)}
                  </Text>
                  <Badge color={count > 0 ? CATEGORY_COLOR[c] : 'gray'} variant={count > 0 ? 'filled' : 'light'}>
                    {count.toLocaleString()}
                  </Badge>
                </Group>
                {totals && (totals.wouldDeny > 0 || totals.wouldAllow > 0) ? (
                  <Group gap={6}>
                    {totals.wouldDeny > 0 ? (
                      <Badge size="sm" variant="light" color="red">
                        {t('wouldDeny', { count: totals.wouldDeny.toLocaleString() })}
                      </Badge>
                    ) : null}
                    {totals.wouldAllow > 0 ? (
                      <Badge size="sm" variant="light" color="green">
                        {t('wouldAllow', { count: totals.wouldAllow.toLocaleString() })}
                      </Badge>
                    ) : null}
                  </Group>
                ) : null}
                <Text size="xs" c="dimmed">
                  {t(`categories.${key}.description`)}
                </Text>
                <Text size="xs" c="dimmed">
                  {t(`categories.${key}.effect`)}
                </Text>
                <Text size="xs" c="dimmed" fs="italic">
                  {t(`categories.${key}.action`)}
                </Text>
              </Stack>
            </Paper>
          );
        })}
      </SimpleGrid>

      {/* Per-service */}
      <Section title={t('perService.title')}>
        {summary && summary.perService.length > 0 ? (
          <Table.ScrollContainer minWidth={560}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('perService.service')}</Table.Th>
                  {CATEGORIES.map((c) => (
                    <Table.Th key={c} ta="right">
                      {categoryLabel(c)}
                    </Table.Th>
                  ))}
                  <Table.Th ta="right">{t('perService.total')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {summary.perService.map((row) => (
                  <Table.Tr key={row.service}>
                    <Table.Td>
                      <Text size="sm" ff="monospace">
                        {row.service}
                      </Text>
                    </Table.Td>
                    {CATEGORIES.map((c) => (
                      <Table.Td key={c} ta="right">
                        {num(row.byCategory[c]).toLocaleString()}
                      </Table.Td>
                    ))}
                    <Table.Td ta="right" fw={600}>
                      {row.total.toLocaleString()}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : (
          <Empty text={t('report.empty')} />
        )}
      </Section>

      {/* Top routes */}
      <Section title={t('topRoutes.title')} hint={t('topRoutes.hint')}>
        {summary && summary.topRoutes.length > 0 ? (
          <Table.ScrollContainer minWidth={760}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('topRoutes.category')}</Table.Th>
                  <Table.Th>{t('topRoutes.route')}</Table.Th>
                  <Table.Th>{t('topRoutes.legacy')}</Table.Th>
                  <Table.Th>{t('topRoutes.target')}</Table.Th>
                  <Table.Th ta="right">{t('topRoutes.count')}</Table.Th>
                  <Table.Th>{t('topRoutes.lastSeen')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {summary.topRoutes.map((row, i) => (
                  <Table.Tr key={`${row.category}:${row.service}:${row.method}:${row.route}:${i}`}>
                    <Table.Td>
                      <Badge
                        variant="light"
                        color={CATEGORY_COLOR[row.category as Category] ?? 'gray'}
                      >
                        {categoryLabel(row.category)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" ff="monospace">
                        {row.method} {row.route}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {row.service}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Verdict allowed={row.legacyAllowed} allowLabel={t('allowed')} denyLabel={t('denied')} />
                    </Table.Td>
                    <Table.Td>
                      <Verdict allowed={row.targetAllowed} allowLabel={t('allowed')} denyLabel={t('denied')} />
                    </Table.Td>
                    <Table.Td ta="right">{row.count.toLocaleString()}</Table.Td>
                    <Table.Td>
                      <Text size="xs">{formatTime(row.lastSeen)}</Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : (
          <Empty text={t('report.empty')} />
        )}
      </Section>

      {/* Samples */}
      <Section title={t('samples.title')} hint={t('samples.hint')}>
        {summary && summary.samples.length > 0 ? (
          <Table.ScrollContainer minWidth={760}>
            <Table striped verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('samples.time')}</Table.Th>
                  <Table.Th>{t('topRoutes.category')}</Table.Th>
                  <Table.Th>{t('topRoutes.route')}</Table.Th>
                  <Table.Th>{t('samples.principal')}</Table.Th>
                  <Table.Th>{t('samples.role')}</Table.Th>
                  <Table.Th>{t('samples.requestId')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {summary.samples.map((row, i) => (
                  <Table.Tr key={`${row.requestId ?? i}:${i}`}>
                    <Table.Td>
                      <Text size="xs">{formatTime(row.at)}</Text>
                    </Table.Td>
                    <Table.Td>{categoryLabel(row.category)}</Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {row.method} {row.route || row.service}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {row.tokenId ? `${t('samples.token')} ${row.tokenId}` : (row.userId ?? '—')}
                      </Text>
                    </Table.Td>
                    <Table.Td>{row.role ?? '—'}</Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {row.requestId ?? '—'}
                      </Text>
                      {row.detail ? (
                        <Text size="xs" c="red" ff="monospace">
                          {row.detail}
                        </Text>
                      ) : null}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : (
          <Empty text={t('report.empty')} />
        )}
      </Section>

      {/* Engine stats */}
      <Section
        title={t('stats.title')}
        hint={stats?.statsScope === 'tenant' ? t('stats.hintTenant') : t('stats.hint')}
      >
        {stats ? (
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 4 }} spacing="md">
            <Stat label={t('stats.decisions')} value={stats.decisions.toLocaleString()} />
            <Stat label={t('stats.p50')} value={formatMicros(stats.p50Us)} />
            <Stat label={t('stats.p99')} value={formatMicros(stats.p99Us)} />
            <Stat
              label={t('stats.cacheHitRate')}
              value={stats.cacheHitRate === null ? '—' : `${Math.round(stats.cacheHitRate * 100)}%`}
            />
            <Stat
              label={t('stats.queueDrops')}
              value={stats.queueDrops.toLocaleString()}
              color={stats.queueDrops > 0 ? 'orange' : undefined}
            />
            <Stat
              label={t('stats.evaluationFailures')}
              value={stats.evaluationFailures.toLocaleString()}
              color={stats.evaluationFailures > 0 ? 'red' : undefined}
            />
            <Stat
              label={t('stats.queueDepth')}
              value={stats.queueDepth === null ? '—' : stats.queueDepth.toLocaleString()}
            />
            <Stat
              label={t('stats.parityMismatches')}
              value={stats.parityMismatches.toLocaleString()}
              color={stats.parityMismatches > 0 ? 'red' : undefined}
            />
          </SimpleGrid>
        ) : (
          <Empty text={statsError ? `${t('stats.unavailable')} (${statsError})` : t('stats.unavailable')} />
        )}
      </Section>
    </Stack>
  );
}

function ModeNote({
  title,
  text,
  active,
  muted,
}: {
  title: string;
  text: string;
  active: boolean;
  muted?: boolean;
}) {
  return (
    <Paper
      withBorder
      p="sm"
      radius="sm"
      style={{
        opacity: muted ? 0.6 : 1,
        borderColor: active ? 'var(--mantine-primary-color-filled)' : undefined,
      }}
    >
      <Text size="sm" fw={600}>
        {title}
      </Text>
      <Text size="xs" c="dimmed">
        {text}
      </Text>
    </Paper>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <div>
          <Text fw={600}>{title}</Text>
          {hint ? (
            <Text size="xs" c="dimmed">
              {hint}
            </Text>
          ) : null}
        </div>
        {children}
      </Stack>
    </Paper>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="lg" c={color}>
        {value}
      </Text>
    </div>
  );
}

function Verdict({
  allowed,
  allowLabel,
  denyLabel,
}: {
  allowed: boolean;
  allowLabel: string;
  denyLabel: string;
}) {
  return (
    <Badge variant="light" color={allowed ? 'green' : 'red'}>
      {allowed ? allowLabel : denyLabel}
    </Badge>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <Text size="sm" c="dimmed">
      {text}
    </Text>
  );
}
