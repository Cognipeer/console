'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, Button } from '@mantine/core';
import { IconAlertCircle, IconBellPlus, IconListSearch } from '@tabler/icons-react';
import EmptyState from '@/components/common/EmptyState';
import RefreshIndicator from '@/components/common/ui/RefreshIndicator';
import { CardSkeleton, StatGridSkeleton } from '@/components/common/ui/Skeletons';
import { useTranslations } from '@/lib/i18n';
import {
  buildDashboardDateSearchParams,
  type DashboardDateFilterState,
} from '@/lib/utils/dashboardDateFilter';
import EntityHealthCharts from './EntityHealthCharts';
import { buildAgentIncidentsHref, buildCreateAgentAlertHref, buildFailingSessionsHref } from './healthLinks';
import type { EntityHealthSeriesPayload } from './healthSeries';

export interface AgentHealthPanelProps {
  agentName: string;
  dateFilter: DashboardDateFilterState;
  /** Bumped by the page's Refresh button to refetch. */
  refreshKey?: number;
}

/** `agent` is the agent the state belongs to: data of another agent is never shown for this one. */
type PanelState =
  | { status: 'loading'; agent: string; data: EntityHealthSeriesPayload | null }
  | { status: 'error'; agent: string; message: string | null }
  | { status: 'ready'; agent: string; data: EntityHealthSeriesPayload };

function hasAnyTraffic(data: EntityHealthSeriesPayload): boolean {
  if ((data.totals?.requests ?? 0) > 0) return true;
  return (data.buckets ?? []).some((bucket) => (bucket.requests ?? 0) > 0);
}

/**
 * Health of one agent from the rollup (`GET /tracing/agents/:name/health`): KPI tiles against the previous
 * period, traffic and error rate, durations with the normal range, markers for new versions and incidents,
 * and the shortcuts to alert on it or look at its failing sessions.
 */
export default function AgentHealthPanel({ agentName, dateFilter, refreshKey = 0 }: AgentHealthPanelProps) {
  const t = useTranslations('tracingHealth');
  const [state, setState] = useState<PanelState>({ status: 'loading', agent: agentName, data: null });
  const [attempt, setAttempt] = useState(0);

  const query = useMemo(() => buildDashboardDateSearchParams(dateFilter).toString(), [dateFilter]);

  useEffect(() => {
    const controller = new AbortController();
    // Keep the previous payload while a refetch of the SAME agent runs (period change, refresh); never carry
    // one agent's charts over to another.
    setState((previous) => ({
      status: 'loading',
      agent: agentName,
      data: previous.status !== 'error' && previous.agent === agentName ? previous.data : null,
    }));
    const load = async () => {
      try {
        const response = await fetch(
          `/api/tracing/agents/${encodeURIComponent(agentName)}/health?${query}`,
          { signal: controller.signal, cache: 'no-store' },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: unknown };
          throw new Error(typeof body.error === 'string' ? body.error : '');
        }
        const data = (await response.json()) as EntityHealthSeriesPayload;
        if (!controller.signal.aborted) setState({ status: 'ready', agent: agentName, data });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setState({ status: 'error', agent: agentName, message: error instanceof Error && error.message ? error.message : null });
      }
    };
    void load();
    return () => controller.abort();
  }, [agentName, query, refreshKey, attempt]);

  // A state still belonging to the previous agent (before the effect resets it) is treated as loading.
  const current = state.agent === agentName;
  const status = current ? state.status : 'loading';
  const data = current && state.status !== 'error' ? state.data : null;
  const refreshing = status === 'loading' && data !== null;
  const alerts = data?.alerts ?? null;

  return (
    <section className="ds-col ds-gap-md" aria-label={t('panel.title')} aria-busy={status === 'loading'}>
      <div className="ds-row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="ds-h3">{t('panel.title')}</div>
          <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
            {t('panel.subtitle')}
            {dateFilter.period === 'total' ? ` ${t('panel.periodTotalNote')}` : ''}
          </div>
        </div>
        <div className="ds-row ds-gap-sm" style={{ flexWrap: 'wrap' }}>
          {alerts && alerts.firing > 0 ? (
            <Link href={buildAgentIncidentsHref(agentName)} className="ds-badge ds-badge-err">
              <span className="ds-badge-dot" />
              {t(alerts.firing === 1 ? 'panel.alertsFiring' : 'panel.alertsFiringMany', { count: alerts.firing })}
            </Link>
          ) : null}
          {alerts && alerts.pending > 0 ? (
            <span className="ds-badge ds-badge-warn">
              <span className="ds-badge-dot" />
              {t('panel.alertsPending', { count: alerts.pending })}
            </span>
          ) : null}
          <Button
            component={Link}
            href={buildCreateAgentAlertHref(agentName)}
            variant="default"
            size="xs"
            leftSection={<IconBellPlus size={14} stroke={1.7} />}
          >
            {t('panel.createAlert')}
          </Button>
          <Button
            component={Link}
            href={buildFailingSessionsHref(agentName, data?.range)}
            variant="default"
            size="xs"
            leftSection={<IconListSearch size={14} stroke={1.7} />}
          >
            {t('panel.failingSessions')}
          </Button>
        </div>
      </div>

      {current && state.status === 'error' ? (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertCircle size={16} />}
          title={t('panel.loadError')}
        >
          <div className="ds-row-between" style={{ gap: 12 }}>
            <span style={{ fontSize: 13 }}>{state.message}</span>
            <Button size="xs" variant="default" onClick={() => setAttempt((n) => n + 1)}>
              {t('common.retry')}
            </Button>
          </div>
        </Alert>
      ) : null}

      {status === 'loading' && !data ? (
        <>
          <StatGridSkeleton count={4} delta label={t('panel.loading')} />
          <CardSkeleton blockHeight={220} lines={0} />
        </>
      ) : null}

      {data && !hasAnyTraffic(data) ? (
        <div className="ds-card" style={{ position: 'relative' }}>
          <RefreshIndicator active={refreshing} />
          <EmptyState title={t('panel.emptyTitle')} description={t('panel.emptyDescription')} minHeight={180} />
        </div>
      ) : null}

      {data && hasAnyTraffic(data) ? (
        <div style={{ position: 'relative', opacity: refreshing ? 0.7 : 1 }}>
          <RefreshIndicator active={refreshing} />
          <EntityHealthCharts series={data} requestsLabel={t('kpi.sessions')} />
        </div>
      ) : null}
    </section>
  );
}
