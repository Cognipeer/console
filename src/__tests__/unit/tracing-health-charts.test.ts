// @vitest-environment jsdom
/**
 * What the entity health charts actually draw: bars for traffic, the error-rate line on the right axis, the
 * stacked "normal range" band and marker lines. Recharts needs a measured container, which jsdom does not
 * have, so the ResizeObserver stub reports a fixed size.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installDomStubs, mount, qa, q, settle, text, type Mounted } from '../helpers/iamCenterUi';

import EntityHealthCharts from '@/components/tracing/health/EntityHealthCharts';
import type { EntityHealthSeriesPayload } from '@/components/tracing/health/healthSeries';

const HOUR = 3_600_000;
const FROM = Date.UTC(2026, 9, 14, 0, 0, 0);

function series(over: Partial<EntityHealthSeriesPayload> = {}): EntityHealthSeriesPayload {
  return {
    range: { fromMs: FROM, toMs: FROM + 6 * HOUR, bucketMs: HOUR },
    buckets: Array.from({ length: 6 }, (_, i) =>
      i === 2
        ? { t: FROM + i * HOUR, requests: 0 }
        : { t: FROM + i * HOUR, requests: 10 + i, errors: i, errorRate: i * 5, p50Ms: 200 + i, p95Ms: 900 + i * 10, toolErrorRate: i, toolCalls: 3 },
    ),
    totals: { requests: 60, errors: 10, errorRate: 16, p95Ms: 950, toolCalls: 15, toolErrorRate: 6 },
    previous: { requests: 50, errorRate: 10, p95Ms: 800, toolErrorRate: 6 },
    ...over,
  };
}

const band = (lower: number, upper: number) =>
  Array.from({ length: 6 }, (_, i) => ({ t: FROM + i * HOUR, median: (lower + upper) / 2, lower, upper }));

let mounted: Mounted | null = null;
beforeAll(() => {
  installDomStubs();
  // Recharts' ResponsiveContainer sizes itself from the observer's first report.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private readonly callback: (entries: unknown[]) => void) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: { width: 800, height: 260 } }]);
    }
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 260 });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe('EntityHealthCharts drawing', () => {
  it('draws traffic bars with the error-rate line, durations, and tool errors', async () => {
    mounted = await mount(h(EntityHealthCharts, { series: series(), requestsLabel: 'Sessions' }));
    await settle(20);
    // Three charts: traffic + errors, durations, tool errors.
    expect(qa('.recharts-wrapper')).toHaveLength(3);
    expect(qa('.recharts-bar-rectangle').length).toBeGreaterThan(0);
    // Error rate (traffic chart), p50 and p95 (durations), tool error rate: four lines.
    expect(qa('.recharts-line')).toHaveLength(4);
    expect(text()).toContain('Sessions and error rate');
    expect(text()).toContain('Duration');
    expect(text()).toContain('Tool errors and abandoned runs');
  });

  it('leaves out the tool chart and the band without that data', async () => {
    const plain = series({
      totals: { requests: 60, errors: 10, errorRate: 16, p95Ms: 950 },
      buckets: series().buckets.map(
        (bucket) =>
          Object.fromEntries(
            Object.entries(bucket).filter(([key]) => key !== 'toolErrorRate' && key !== 'toolCalls'),
          ) as typeof bucket,
      ),
    });
    mounted = await mount(h(EntityHealthCharts, { series: plain }));
    await settle(20);
    expect(qa('.recharts-wrapper')).toHaveLength(2);
    expect(qa('.recharts-area')).toHaveLength(0);
    expect(text()).not.toContain('Tool errors and abandoned runs');
    expect(text()).not.toContain('shaded band');
  });

  it('draws the normal-range band as two stacked areas on each chart that has a baseline', async () => {
    mounted = await mount(h(EntityHealthCharts, {
      series: series({ baseline: { errorRate: band(1, 6), p95Ms: band(700, 1000) } }),
    }));
    await settle(20);
    // Base + range on the traffic chart and on the durations chart.
    expect(qa('.recharts-area')).toHaveLength(4);
    expect(text()).toContain('Normal error rate range');
    expect(text()).toContain('Normal p95 range');
    expect(text()).toContain('The shaded band is the normal range');
  });

  it('draws one marker line per bucket and type on the charts, and lists the markers with links', async () => {
    mounted = await mount(h(EntityHealthCharts, {
      series: series({
        markers: [
          { t: FROM + 3 * HOUR + 1000, type: 'version', label: 'v3', href: '/dashboard/tracing/sessions?agent=a' },
          { t: FROM + 4 * HOUR + 1000, type: 'incident', label: 'Latency alert', href: '/dashboard/alerts/incidents/i1' },
        ],
      }),
    }));
    await settle(20);
    // Two markers on each of the three charts.
    expect(qa('.recharts-reference-line')).toHaveLength(6);
    const links = qa('a').map((a) => a.getAttribute('href'));
    expect(links).toContain('/dashboard/tracing/sessions?agent=a');
    expect(links).toContain('/dashboard/alerts/incidents/i1');
    expect(text()).toContain('New version: v3');
    expect(text()).toContain('Incident: Latency alert');
  });

  it('shows the KPI tiles above the charts and a legend per chart', async () => {
    mounted = await mount(h(EntityHealthCharts, { series: series() }));
    await settle(20);
    expect(q('.ds-stat-grid')).not.toBeNull();
    expect(qa('[role="img"]').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Sessions and error rate',
      'Duration',
      'Tool errors and abandoned runs',
    ]);
  });
});

describe('the chart tooltip', () => {
  it('shows each series of the hovered bucket, the normal range as "low – high", and skips empty values', async () => {
    const { createRowTooltip } = await import('@/components/tracing/health/EntityHealthCharts');
    const { buildChartRows } = await import('@/components/tracing/health/healthSeries');
    const rows = buildChartRows(series({ baseline: { p95Ms: band(700, 1000) } }), 'en');
    const byLabel = new Map(rows.map((row) => [row.label, row]));
    const Tooltip = createRowTooltip(byLabel, [
      { name: 'p50Ms', label: 'p50', color: 'teal.6', value: (row) => (row.p50Ms === null ? null : `${row.p50Ms} ms`) },
      { name: 'p95Ms', label: 'p95', color: 'orange.6', value: (row) => (row.p95Ms === null ? null : `${row.p95Ms} ms`) },
      {
        name: 'p95Band',
        label: 'Normal p95 range',
        color: 'gray.5',
        value: (row) => (row.p95BandLower === null ? null : `${row.p95BandLower} – ${row.p95BandUpper}`),
      },
    ]);

    mounted = await mount(h(Tooltip, { label: rows[0]!.label, payload: [{}] }));
    expect(q('.mantine-ChartTooltip-tooltip')).not.toBeNull();
    expect(text()).toContain(rows[0]!.label);
    expect(text()).toContain('p50');
    expect(text()).toContain('200 ms');
    expect(text()).toContain('Normal p95 range');
    expect(text()).toContain('700 – 1000');
    await mounted.unmount();

    // The empty bucket (index 2) has no p50 / p95: nothing but the band.
    mounted = await mount(h(Tooltip, { label: rows[2]!.label, payload: [{}] }));
    expect(text()).not.toContain('p50');
    expect(text()).toContain('700 – 1000');
    await mounted.unmount();

    // An unknown label renders nothing.
    mounted = await mount(h(Tooltip, { label: 'nope', payload: [{}] }));
    expect(q('.mantine-ChartTooltip-tooltip')).toBeNull();
  });
});
