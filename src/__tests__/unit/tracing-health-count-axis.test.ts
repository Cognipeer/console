// @vitest-environment jsdom
/**
 * The requests axis of the entity health chart counts whole requests: Recharts would otherwise tick it at fractions
 * (0, 0.25, 0.5 ...) which, formatted as counts, read "1 1 1 0 0" when only a few requests are charted.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installDomStubs, mount, settle, type Mounted } from '../helpers/iamCenterUi';

const charts = vi.hoisted(() => ({ composite: [] as Array<Record<string, unknown>> }));

vi.mock('@mantine/charts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantine/charts')>()),
  CompositeChart: (props: Record<string, unknown>) => {
    charts.composite.push(props);
    return null;
  },
}));

import EntityHealthCharts from '@/components/tracing/health/EntityHealthCharts';
import type { EntityHealthSeriesPayload } from '@/components/tracing/health/healthSeries';

const HOUR = 3_600_000;
const FROM = Date.UTC(2026, 9, 14, 0, 0, 0);

const SERIES: EntityHealthSeriesPayload = {
  range: { fromMs: FROM, toMs: FROM + 3 * HOUR, bucketMs: HOUR },
  buckets: [
    { t: FROM, requests: 1, errors: 1, errorRate: 100, p50Ms: 200, p95Ms: 900 },
    { t: FROM + HOUR, requests: 1, errors: 1, errorRate: 100, p50Ms: 300, p95Ms: 2000 },
    { t: FROM + 2 * HOUR, requests: 0 },
  ],
  totals: { requests: 2, errors: 2, errorRate: 100, p95Ms: 2000 },
  previous: null,
  baseline: null,
  markers: [],
  markersPartial: false,
  alerts: { firing: 0, pending: 0 },
};

let mounted: Mounted | null = null;
beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  charts.composite.length = 0;
  vi.unstubAllGlobals();
});

describe('EntityHealthCharts count axis', () => {
  it('keeps the requests axis to whole numbers', async () => {
    mounted = await mount(h(EntityHealthCharts, { series: SERIES }));
    await settle(30);
    const traffic = charts.composite[0]!;
    expect(traffic).toBeDefined();
    expect(traffic.yAxisProps).toMatchObject({ allowDecimals: false });
  });
});
