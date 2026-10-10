import { useEffect, useState } from 'react';
import { SegmentedControl, Text } from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import {
  IconAlertTriangle,
  IconClockHour4,
  IconCoin,
  IconPigMoney,
  IconRoute,
  IconScale,
  IconShieldCheck,
  IconStopwatch,
} from '@tabler/icons-react';
import StatTile from '@/components/common/ui/StatTile';
import type { RoutingAnalytics } from '@/lib/services/models/routingAnalytics';

const WINDOWS = [
  { value: '1', label: '24h' },
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
];

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const abs = Math.abs(value);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 5 : abs < 1 ? 4 : 2;
  return `${value < 0 ? '−' : ''}$${abs.toFixed(digits)}`;
}

function pct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(digits)}%`;
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—';
}

function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Decider time as a share of end-to-end time: the decider runs before the child call, so they add up. */
function deciderShare(perRequest: number | null, total: number | null): string | undefined {
  if (perRequest === null || total === null || total <= 0) return undefined;
  return `${((perRequest / total) * 100).toFixed(0)}% of request time`;
}

/**
 * Dynamic LLM spend vs baseline: what the router actually cost, what the same
 * traffic would have cost on its baseline model, and which routes, models,
 * guards and shadow decisions moved the number.
 */
export default function RoutingAnalyticsPanel({ modelId }: { modelId: string }) {
  const [days, setDays] = useState('7');
  const [data, setData] = useState<RoutingAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/models/${modelId}/routing-analytics?days=${days}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? 'Failed to load routing analytics');
        return body.analytics as RoutingAnalytics;
      })
      .then((analytics) => {
        if (!cancelled) setData(analytics);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load routing analytics');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modelId, days]);

  const totals = data?.totals;
  const savingsDir = totals ? (totals.savingsUsd > 0 ? 'up' : totals.savingsUsd < 0 ? 'down' : null) : null;

  return (
    <div className="ds-col ds-gap-md" style={{ marginBottom: 16 }}>
      <div className="ds-row-between">
        <div>
          <div className="ds-h3">Routing analytics</div>
          <span className="ds-faint" style={{ fontSize: 12 }}>
            Spend of routed calls (child + decider) vs the same usage priced at the baseline model.
          </span>
        </div>
        <SegmentedControl size="xs" data={WINDOWS} value={days} onChange={setDays} />
      </div>

      {error ? (
        <div className="ds-card ds-card-pad">
          <Text size="sm" c="red">{error}</Text>
        </div>
      ) : null}

      {!error && !loading && totals && totals.requests === 0 && totals.deciderCalls === 0 ? (
        <div className="ds-card ds-empty" style={{ padding: 28 }}>
          <Text size="sm" c="dimmed">
            No routed traffic in this window yet. Analytics fill in as requests hit this router.
          </Text>
        </div>
      ) : null}

      {totals && (totals.requests > 0 || totals.deciderCalls > 0) ? (
        <>
          <div className="ds-stat-grid">
            <StatTile label="Routed requests" icon={<IconRoute size={14} stroke={1.7} />} value={totals.requests.toLocaleString()} />
            <StatTile
              label="Actual spend"
              icon={<IconCoin size={14} stroke={1.7} />}
              value={usd(totals.costUsd)}
              delta={totals.deciderCalls > 0 ? `decider ${usd(totals.deciderCostUsd)}` : undefined}
            />
            <StatTile label="Baseline spend" icon={<IconScale size={14} stroke={1.7} />} value={usd(totals.baselineCostUsd)} />
            <StatTile
              label="Savings vs baseline"
              icon={<IconPigMoney size={14} stroke={1.7} />}
              value={usd(totals.savingsUsd)}
              delta={totals.savingsPct !== null ? pct(totals.savingsPct) : undefined}
              deltaDir={savingsDir}
            />
            <StatTile
              label="Quality signals"
              icon={<IconAlertTriangle size={14} stroke={1.7} />}
              value={`${share(totals.errors, totals.requests)} err`}
              delta={`${share(totals.lengthStops, totals.requests)} cut off`}
            />
            <StatTile
              label="Fallback / guard"
              icon={<IconShieldCheck size={14} stroke={1.7} />}
              value={share(totals.fallbacks, totals.requests)}
              delta={`${totals.guardTrips} guard trips`}
            />
            <StatTile
              label="Total latency"
              icon={<IconStopwatch size={14} stroke={1.7} />}
              value={duration(totals.avgTotalLatencyMs)}
              delta={
                totals.deciderCalls > 0
                  ? `${duration(totals.avgLatencyMs)} model + ${duration(totals.avgDeciderPerRequestMs)} decider`
                  : undefined
              }
            />
            {totals.deciderCalls > 0 ? (
              <StatTile
                label="Decider latency"
                icon={<IconClockHour4 size={14} stroke={1.7} />}
                value={duration(totals.avgDeciderLatencyMs)}
                delta={deciderShare(totals.avgDeciderPerRequestMs, totals.avgTotalLatencyMs)}
              />
            ) : null}
          </div>

          {data && data.daily.length > 1 ? (
            <div className="ds-card ds-card-pad">
              <div className="ds-h4" style={{ marginBottom: 8 }}>Daily spend vs baseline (USD)</div>
              <AreaChart
                h={160}
                data={data.daily}
                dataKey="day"
                series={[
                  { name: 'baselineCostUsd', label: 'Baseline', color: 'gray.5' },
                  { name: 'costUsd', label: 'Actual', color: 'teal.6' },
                ]}
                curveType="monotone"
                withDots={false}
                gridAxis="x"
                tickLine="x"
                valueFormatter={(v) => usd(v)}
              />
            </div>
          ) : null}

          <div className="ds-card">
            <div className="ds-row-between" style={{ padding: '12px 18px' }}>
              <div className="ds-h4">By route</div>
              <span className="ds-faint" style={{ fontSize: 12 }}>
                cost estimate error (weighted): {pct(totals.costEstimateErrorPct, 0)}
              </span>
            </div>
            <div className="ds-tbl-wrap">
              <table className="ds-tbl">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th>Models</th>
                    <th style={{ textAlign: 'right' }}>Requests</th>
                    <th style={{ textAlign: 'right' }}>Spend</th>
                    <th style={{ textAlign: 'right' }}>Savings</th>
                    <th style={{ textAlign: 'right' }}>Errors</th>
                    <th style={{ textAlign: 'right' }}>Cut off</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.byRoute.map((row) => (
                    <tr key={row.route}>
                      <td style={{ fontSize: 12.5 }}>
                        {row.route}
                        {row.policy ? <span className="ds-badge" style={{ marginLeft: 6 }}>{row.policy}</span> : null}
                      </td>
                      <td className="ds-mono ds-muted" style={{ fontSize: 11.5 }}>
                        {Object.entries(row.models)
                          .sort((a, b) => b[1] - a[1])
                          .map(([key, n]) => `${key} ${share(n, row.requests)}`)
                          .join(' · ')}
                      </td>
                      <td className="ds-mono" style={{ textAlign: 'right' }}>{row.requests}</td>
                      <td className="ds-mono" style={{ textAlign: 'right' }}>{usd(row.costUsd)}</td>
                      <td className="ds-mono" style={{ textAlign: 'right' }}>{usd(row.savingsUsd)}</td>
                      <td className="ds-mono" style={{ textAlign: 'right' }}>{share(row.errors, row.requests)}</td>
                      <td className="ds-mono" style={{ textAlign: 'right' }}>{share(row.lengthStops, row.requests)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="ds-card">
            <div className="ds-h4" style={{ padding: '12px 18px' }}>By model</div>
            <div className="ds-tbl-wrap">
              <table className="ds-tbl">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th style={{ textAlign: 'right' }}>Share</th>
                    <th style={{ textAlign: 'right' }}>Spend</th>
                    <th style={{ textAlign: 'right' }}>Out / in</th>
                    <th style={{ textAlign: 'right' }}>Cached in</th>
                    <th style={{ textAlign: 'right' }}>Errors</th>
                    <th style={{ textAlign: 'right' }}>Avg latency</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.byModel.map((row) => (
                    <tr key={row.modelKey}>
                      <td className="ds-mono" style={{ fontSize: 12 }}>{row.modelKey}</td>
                      <td className="ds-mono" style={{ textAlign: 'right' }}>{share(row.requests, totals.requests)}</td>
                      <td className="ds-mono" style={{ textAlign: 'right' }}>{usd(row.costUsd)}</td>
                      <td className="ds-mono" style={{ textAlign: 'right' }}>
                        {row.inputTokens > 0 ? (row.outputTokens / row.inputTokens).toFixed(2) : '—'}
                      </td>
                      <td className="ds-mono" style={{ textAlign: 'right' }}>{share(row.cachedInputTokens, row.inputTokens)}</td>
                      <td className="ds-mono" style={{ textAlign: 'right' }}>{share(row.errors, row.requests)}</td>
                      <td className="ds-mono" style={{ textAlign: 'right' }}>
                        {row.avgLatencyMs !== null ? `${Math.round(row.avgLatencyMs)}ms` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {data!.shadow.length > 0 ? (
            <div className="ds-card">
              <div className="ds-row-between" style={{ padding: '12px 18px' }}>
                <div className="ds-h4">Shadow decisions</div>
                <span className="ds-faint" style={{ fontSize: 12 }}>
                  What the pool / guards would have chosen, compared on decision-time estimates.
                </span>
              </div>
              <div className="ds-tbl-wrap">
                <table className="ds-tbl">
                  <thead>
                    <tr>
                      <th>Served</th>
                      <th>Would route to</th>
                      <th style={{ textAlign: 'right' }}>Requests</th>
                      <th style={{ textAlign: 'right' }}>Est. served</th>
                      <th style={{ textAlign: 'right' }}>Est. proposed</th>
                      <th style={{ textAlign: 'right' }}>Est. savings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.shadow.map((row) => (
                      <tr key={`${row.actualModelKey}-${row.proposedModelKey}`}>
                        <td className="ds-mono" style={{ fontSize: 12 }}>{row.actualModelKey}</td>
                        <td className="ds-mono" style={{ fontSize: 12 }}>{row.proposedModelKey}</td>
                        <td className="ds-mono" style={{ textAlign: 'right' }}>{row.requests}</td>
                        <td className="ds-mono" style={{ textAlign: 'right' }}>{usd(row.actualEstimatedCostUsd)}</td>
                        <td className="ds-mono" style={{ textAlign: 'right' }}>{usd(row.proposedEstimatedCostUsd)}</td>
                        <td className="ds-mono" style={{ textAlign: 'right' }}>{usd(row.estimatedSavingsUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {data!.truncated ? (
            <span className="ds-faint" style={{ fontSize: 12 }}>
              Showing the most recent {data!.rowsRead.toLocaleString()} routed calls in this window.
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
