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
import { layoutMarkerLabels } from '@/components/tracing/health/markerLabels';

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

  it('keeps the normal range readable over tall traffic bars: light bars and a dashed edge on the band', async () => {
    mounted = await mount(h(EntityHealthCharts, {
      series: series({ baseline: { errorRate: band(1, 6), p95Ms: band(700, 1000) } }),
    }));
    await settle(20);
    const bars = qa('.recharts-bar-rectangle path, .recharts-bar-rectangle rect');
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(bar.getAttribute('fill-opacity')).toBe('0.45');
    const dashedEdges = qa('.recharts-area-curve').filter((curve) => curve.getAttribute('stroke-dasharray') === '4 3');
    // the range area of the traffic chart and of the durations chart
    expect(dashedEdges.length).toBeGreaterThanOrEqual(2);
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

  describe('marker labels', () => {
    const dense = (markers: EntityHealthSeriesPayload['markers']) =>
      series({
        range: { fromMs: FROM, toMs: FROM + 60 * HOUR, bucketMs: HOUR },
        buckets: Array.from({ length: 60 }, (_, i) => ({ t: FROM + i * HOUR, requests: 10, errors: 1, errorRate: 10, p50Ms: 200, p95Ms: 900 })),
        markers,
      });
    const labelNodes = () => qa('[data-marker-labels] [data-marker]');

    it('tags a version with its short label and an incident with a compact word, the full text in the tooltip', async () => {
      mounted = await mount(h(EntityHealthCharts, {
        series: dense([
          { t: FROM + 10 * HOUR, type: 'version', label: 'v1.5.0' },
          { t: FROM + 30 * HOUR, type: 'incident', label: 'Agents - error rate vs normal +2' },
        ]),
      }));
      await settle(20);
      // Only the traffic chart carries tags.
      expect(qa('[data-marker-labels]')).toHaveLength(1);
      const [version, incident] = labelNodes();
      expect(version!.querySelector('text')!.textContent).toBe('v1.5.0');
      expect(incident!.querySelector('text')!.textContent).toBe('Incident');
      expect(incident!.querySelector('title')!.textContent).toContain('Agents - error rate vs normal +2');
      expect(version!.querySelector('title')!.textContent).toContain('New version: v1.5.0');
    });

    it('moves a close label to the second row and drops the text of a third one that has no room', async () => {
      mounted = await mount(h(EntityHealthCharts, {
        series: dense([
          { t: FROM + 20 * HOUR, type: 'version', label: 'v1.5.0' },
          { t: FROM + 21 * HOUR, type: 'version', label: 'v1.5.1' },
          { t: FROM + 22 * HOUR, type: 'version', label: 'v1.5.2' },
        ]),
      }));
      await settle(20);
      const nodes = labelNodes();
      expect(nodes).toHaveLength(3);
      const ys = nodes.map((node) => node.querySelector('text')?.getAttribute('y') ?? null);
      expect(ys[0]).not.toBeNull();
      expect(ys[1]).not.toBeNull();
      expect(ys[1]).not.toBe(ys[0]);
      // No row is left for the third: its tag dot and tooltip stay, the text is not drawn.
      expect(ys[2]).toBeNull();
      expect(nodes[2]!.querySelector('circle')).not.toBeNull();
      expect(nodes[2]!.querySelector('title')!.textContent).toContain('v1.5.2');
    });

    it('draws no tags and does not break when the series has no markers', async () => {
      mounted = await mount(h(EntityHealthCharts, { series: dense([]) }));
      await settle(20);
      expect(labelNodes()).toHaveLength(0);
      expect(qa('[data-marker-labels] text')).toHaveLength(0);
    });

    it('keeps a label near the right edge inside the plot by putting it left of its line', async () => {
      mounted = await mount(h(EntityHealthCharts, {
        series: dense([{ t: FROM + 59 * HOUR, type: 'version', label: 'v1.5.0' }]),
      }));
      await settle(20);
      const label = labelNodes()[0]!.querySelector('text')!;
      expect(label.getAttribute('text-anchor')).toBe('end');
      expect(Number(label.getAttribute('x'))).toBeLessThan(Number(labelNodes()[0]!.querySelector('circle')!.getAttribute('cx')));
    });
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

describe('layoutMarkerLabels edge cases', () => {
  const plot = { left: 40, right: 400, charWidth: 6, rows: 2 };

  it('returns nothing for no markers and keeps the input order for unsorted ones', () => {
    expect(layoutMarkerLabels([], plot)).toEqual([]);
    const placed = layoutMarkerLabels([{ key: 'late', x: 300, text: 'v2' }, { key: 'early', x: 100, text: 'v1' }], plot);
    expect(placed.map((p) => p.key)).toEqual(['late', 'early']);
    expect(placed.every((p) => p.visible && p.row === 0 && p.anchor === 'start')).toBe(true);
  });

  it('drops the text of a label wider than the plot or whose line is left of it, instead of drawing it outside', () => {
    expect(layoutMarkerLabels([{ key: 'wide', x: 200, text: 'x'.repeat(100) }], plot)[0]).toMatchObject({ visible: false });
    expect(layoutMarkerLabels([{ key: 'off', x: 20, text: 'v1' }], plot)[0]).toMatchObject({ visible: false });
  });

  it('puts two markers on the same x on different rows and hides a third', () => {
    const placed = layoutMarkerLabels(
      [{ key: 'a', x: 100, text: 'v1' }, { key: 'b', x: 100, text: 'v2' }, { key: 'c', x: 100, text: 'v3' }],
      plot,
    );
    expect(placed.map((p) => [p.visible, p.row])).toEqual([[true, 0], [true, 1], [false, 0]]);
  });

  it('never lets two visible labels in one row touch, also when they are flipped at the right edge', () => {
    const items = [{ key: 'a', x: 395, text: 'v1.0.0' }, { key: 'b', x: 380, text: 'v1.0.1' }, { key: 'c', x: 370, text: 'v1.0.2' }];
    const placed = layoutMarkerLabels(items, plot);
    const spans = placed
      .filter((p) => p.visible)
      .map((p) => {
        const x = items.find((i) => i.key === p.key)!.x;
        const width = p.text.length * plot.charWidth;
        const from = p.anchor === 'start' ? x + 4 : x - 4 - width;
        return { row: p.row, from, to: from + width };
      });
    for (const a of spans) {
      expect(a.from).toBeGreaterThanOrEqual(plot.left);
      expect(a.to).toBeLessThanOrEqual(plot.right);
      for (const b of spans) if (a !== b && a.row === b.row) expect(a.to <= b.from || b.to <= a.from).toBe(true);
    }
  });
});
