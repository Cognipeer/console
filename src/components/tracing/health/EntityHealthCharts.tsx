'use client';

/**
 * Reusable health views of one entity (an agent here; the Enterprise health page hands it the same payload
 * for models, knowledge bases, MCP servers and tools): KPI tiles with deltas against the previous period,
 * traffic + error rate, durations with the learned normal range, and tool errors / abandoned runs. It only
 * draws what the payload has: no tool calls, no abandoned runs, no cost or no baseline means no tile, line
 * or band for it.
 */

import { useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { ChartTooltip, CompositeChart, type CompositeChartSeries } from '@mantine/charts';
import { usePlotArea, useXAxisScale } from 'recharts';
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react';
import Spark from '@/components/common/ui/Spark';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  formatHealthCost,
  formatHealthCount,
  formatHealthMs,
  formatHealthPercent,
} from './healthFormat';
import {
  buildChartRows,
  buildKpiSpecs,
  deltaText,
  detectAvailability,
  snapMarkers,
  type ChartMarker,
  type EntityHealthSeriesPayload,
  type HealthChartRow,
  type KpiId,
  type KpiSpec,
} from './healthSeries';
import { layoutMarkerLabels } from './markerLabels';

const colorVar = (token: string) => `var(--mantine-color-${token.replace('.', '-')})`;

const COLORS = {
  requests: 'blue.4',
  errorRate: 'red.6',
  p50: 'teal.6',
  p95: 'orange.6',
  toolErrorRate: 'violet.6',
  abandonedRate: 'yellow.7',
  band: 'gray.5',
  version: 'violet.6',
  incident: 'red.6',
} as const;

/* ---------------------------------------------------------------------------------------------- */
/* KPI tiles                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

export interface EntityHealthKpiTilesProps {
  series: EntityHealthSeriesPayload;
  /** Word for the traffic tile: "Sessions" for agents, "Requests" for the rest. */
  requestsLabel?: string;
}

function kpiValue(spec: KpiSpec, locale: string): string {
  switch (spec.kind) {
    case 'percent':
      return formatHealthPercent(spec.value, locale);
    case 'ms':
      return formatHealthMs(spec.value, locale);
    case 'usd':
      return formatHealthCost(spec.value, locale);
    default:
      return formatHealthCount(spec.value, locale);
  }
}

export function EntityHealthKpiTiles({ series, requestsLabel }: EntityHealthKpiTilesProps) {
  const t = useTranslations('tracingHealth');
  const locale = useLocale();
  const specs = useMemo(() => {
    const rows = buildChartRows(series, locale);
    return buildKpiSpecs(series, detectAvailability(series, rows), rows);
  }, [series, locale]);

  const labelOf = (id: KpiId): string => {
    switch (id) {
      case 'requests':
        return requestsLabel ?? t('kpi.requests');
      case 'errorRate':
        return t('kpi.errorRate');
      case 'p95Ms':
        return t('kpi.p95');
      case 'toolErrorRate':
        return t('kpi.toolErrorRate');
      case 'costUsd':
        return t('kpi.cost');
      default:
        return t('kpi.abandoned');
    }
  };

  const hasPrevious = Boolean(series.previous);

  return (
    <div className="ds-stat-grid">
      {specs.map((spec) => {
        const delta = spec.delta;
        // `.ds-stat-delta.up` is green and `.down` red: the class carries good / bad, the arrow the real direction.
        const toneClass = delta?.tone === 'good' ? 'up' : delta?.tone === 'bad' ? 'down' : '';
        return (
          <div className="ds-stat" key={spec.id} data-kpi={spec.id}>
            <div className="ds-stat-label">{labelOf(spec.id)}</div>
            <div className="ds-stat-value">
              <span>{kpiValue(spec, locale)}</span>
            </div>
            {delta ? (
              <div className={`ds-stat-delta ${toneClass}`} data-tone={delta.tone}>
                {delta.direction === 'up' ? (
                  <IconArrowUp size={12} stroke={2} aria-hidden="true" />
                ) : delta.direction === 'down' ? (
                  <IconArrowDown size={12} stroke={2} aria-hidden="true" />
                ) : null}
                <span>{deltaText(delta, t('kpi.newDelta'), locale)}</span>
                <span className="ds-faint">{t('kpi.vsPrevious')}</span>
              </div>
            ) : (
              <div className="ds-stat-delta">
                <span className="ds-faint">{hasPrevious ? t('kpi.vsPrevious') : t('kpi.noPrevious')}</span>
              </div>
            )}
            {spec.spark && spec.spark.length > 1 ? (
              <div className="ds-stat-spark">
                <Spark data={spec.spark} color="var(--ds-accent)" />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Charts                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

export interface TooltipEntry {
  name: string;
  label: string;
  color: string;
  value: (row: HealthChartRow) => string | null;
}

/**
 * Tooltip that reads the whole chart row, so the bands (stacked base + height) show as "low – high" and the
 * helper series stay out of it.
 */
export function createRowTooltip(rows: Map<string, HealthChartRow>, entries: TooltipEntry[]) {
  const series = entries.map((entry) => ({ name: entry.name, label: entry.label, color: entry.color }));
  function RowTooltip({ label, payload }: { label?: ReactNode; payload?: unknown[] }) {
    const row = typeof label === 'string' ? rows.get(label) : undefined;
    if (!row || !payload) return null;
    const items = entries
      .map((entry) => ({ entry, value: entry.value(row) }))
      .filter((item): item is { entry: TooltipEntry; value: string } => item.value !== null)
      .map(({ entry, value }) => ({
        name: entry.name,
        dataKey: entry.name,
        color: entry.color,
        payload: { [entry.name]: value },
      }));
    if (items.length === 0) return null;
    return <ChartTooltip label={label} payload={items} series={series} />;
  }
  return RowTooltip;
}

const MARKER_TAG_MAX = 14;
const MARKER_FONT_SIZE = 11;
/** Rough width of one character at `MARKER_FONT_SIZE`, for the label layout. */
const MARKER_CHAR_WIDTH = 6.4;
const MARKER_ROW_HEIGHT = 14;
/** Space between a marker's dot and its tag, and the least space between two tags in a row. */
const MARKER_TEXT_GAP = 6;

/** Marker lines only: the labels are drawn by `MarkerLabels`, which knows the plot area. */
function markerLines(markers: ChartMarker[]) {
  return markers.map((marker) => ({
    x: marker.x,
    color: marker.type === 'incident' ? COLORS.incident : COLORS.version,
    strokeDasharray: '4 4',
  }));
}

interface MarkerLabelsProps {
  markers: ChartMarker[];
  /** Short text on the chart: the version tag, or a compact word for an incident. */
  tagOf: (marker: ChartMarker) => string;
  /** Full text of the tooltip. */
  titleOf: (marker: ChartMarker) => string;
}

/**
 * Tags on top of the marker lines. They stay inside the plot area (flipping to the left of the line near the
 * right edge, clear of the right axis), take a second row when two are close, and fall back to the bare tag
 * when neither row has room. Every tag carries the full text as its tooltip.
 */
function MarkerLabels({ markers, tagOf, titleOf }: MarkerLabelsProps) {
  const plot = usePlotArea();
  const scale = useXAxisScale();
  if (!plot || !scale) return null;

  const positioned = markers.flatMap((marker) => {
    const x = scale(marker.x, { position: 'middle' });
    return typeof x === 'number' && Number.isFinite(x) ? [{ marker, x }] : [];
  });
  const text = (marker: ChartMarker) => {
    const tag = tagOf(marker);
    return tag.length > MARKER_TAG_MAX ? `${tag.slice(0, MARKER_TAG_MAX - 1)}…` : tag;
  };
  const placements = new Map(
    layoutMarkerLabels(
      positioned.map(({ marker, x }) => ({ key: marker.key, x, text: text(marker) })),
      { left: plot.x, right: plot.x + plot.width, charWidth: MARKER_CHAR_WIDTH, rows: 2, pad: MARKER_TEXT_GAP },
    ).map((placement) => [placement.key, placement]),
  );

  return (
    <g data-marker-labels="">
      {positioned.map(({ marker, x }) => {
        const placement = placements.get(marker.key);
        if (!placement) return null;
        const color = colorVar(marker.type === 'incident' ? COLORS.incident : COLORS.version);
        const y = plot.y + MARKER_FONT_SIZE + placement.row * MARKER_ROW_HEIGHT;
        return (
          <g key={marker.key} data-marker={marker.key}>
            <title>{titleOf(marker)}</title>
            <circle cx={x} cy={plot.y + 3} r={3} fill={color} />
            {placement.visible ? (
              <text
                x={placement.anchor === 'start' ? x + MARKER_TEXT_GAP : x - MARKER_TEXT_GAP}
                y={y}
                textAnchor={placement.anchor}
                fontSize={MARKER_FONT_SIZE}
                fill={color}
                stroke="var(--mantine-color-body)"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {placement.text}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

/** Traffic bars sit behind the error rate: light enough that the normal range and the line read through them. */
const TRAFFIC_BAR_OPACITY = 0.45;

const BAND_AREA_PROPS = (series: CompositeChartSeries) => {
  if (series.name.endsWith('BandBase')) {
    return { stackId: 'band', fill: 'none', stroke: 'none', strokeWidth: 0, dot: false, activeDot: false } as const;
  }
  if (series.name.endsWith('BandRange')) {
    // The dashed edge keeps the range visible where it overlaps tall traffic bars.
    return {
      stackId: 'band',
      fillOpacity: 0.16,
      stroke: colorVar(COLORS.band),
      strokeWidth: 1,
      strokeDasharray: '4 3',
      dot: false,
      activeDot: false,
    } as const;
  }
  return {};
};

/** `line` swatch for line series (the default), `block` for bars, `band` for the normal-range shading. */
interface LegendItem {
  label: string;
  color: string;
  shape?: 'line' | 'block' | 'band';
}

function LegendRow({ items }: { items: LegendItem[] }) {
  return (
    <div className="ds-row" style={{ flexWrap: 'wrap', gap: 14, marginBottom: 8, fontSize: 12 }}>
      {items.map((item) => (
        <span key={item.label} className="ds-row ds-gap-xs ds-muted">
          <span
            aria-hidden="true"
            style={{
              width: 10,
              height: item.shape === 'band' || item.shape === 'block' ? 10 : 3,
              borderRadius: 2,
              background: colorVar(item.color),
              opacity: item.shape === 'band' ? 0.4 : item.shape === 'block' ? TRAFFIC_BAR_OPACITY : 1,
              display: 'inline-block',
            }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function ChartCard({ title, ariaLabel, legend, children }: {
  title: string;
  ariaLabel: string;
  legend: LegendItem[];
  children: ReactNode;
}) {
  return (
    <div className="ds-card ds-card-pad">
      <div className="ds-h4" style={{ marginBottom: 8 }}>{title}</div>
      <LegendRow items={legend} />
      <div role="img" aria-label={ariaLabel}>
        {children}
      </div>
    </div>
  );
}

export interface EntityHealthChartsProps {
  series: EntityHealthSeriesPayload;
  /** Word for the traffic series: "Sessions" for agents, "Requests" for the rest. */
  requestsLabel?: string;
  chartHeight?: number;
}

function markerTime(t: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(t));
}

export function EntityHealthCharts({ series, requestsLabel, chartHeight = 220 }: EntityHealthChartsProps) {
  const t = useTranslations('tracingHealth');
  const locale = useLocale();
  const view = useMemo(() => {
    const rows = buildChartRows(series, locale);
    return {
      rows,
      byLabel: new Map(rows.map((row) => [row.label, row])),
      availability: detectAvailability(series, rows),
      markers: snapMarkers(series.markers, rows, series.range?.bucketMs ?? 0),
    };
  }, [series, locale]);

  const { rows, byLabel, availability, markers } = view;
  const requests = requestsLabel ?? t('charts.series.requests');
  const drawable = rows.length >= 2;
  const showToolChart = availability.toolErrors || availability.abandoned;
  const pct = (value: number | null) => (value === null ? null : formatHealthPercent(value, locale));
  const band = (lower: number | null, upper: number | null, format: (v: number) => string) =>
    lower === null || upper === null ? null : `${format(lower)} – ${format(upper)}`;
  const dotSize = rows.length > 100 ? 1.5 : 2.5;

  const trafficSeries: CompositeChartSeries[] = [
    { name: 'requests', label: requests, color: COLORS.requests, type: 'bar' },
  ];
  const trafficEntries: TooltipEntry[] = [
    { name: 'requests', label: requests, color: COLORS.requests, value: (row) => formatHealthCount(row.requests, locale) },
  ];
  const trafficLegend: LegendItem[] = [{ label: requests, color: COLORS.requests, shape: 'block' }];
  if (availability.errorBand) {
    trafficSeries.push(
      { name: 'errorBandBase', color: COLORS.band, type: 'area', yAxisId: 'right' },
      { name: 'errorBandRange', color: COLORS.band, type: 'area', yAxisId: 'right' },
    );
    trafficEntries.push({
      name: 'errorBand',
      label: t('charts.series.normalErrorRate'),
      color: COLORS.band,
      value: (row) => band(row.errorBandLower, row.errorBandUpper, (v) => formatHealthPercent(v, locale)),
    });
    trafficLegend.push({ label: t('charts.series.normalErrorRate'), color: COLORS.band, shape: 'band' });
  }
  if (availability.errorRate) {
    trafficSeries.push({
      name: 'errorRate',
      label: t('charts.series.errorRate'),
      color: COLORS.errorRate,
      type: 'line',
      yAxisId: 'right',
    });
    trafficEntries.push({
      name: 'errorRate',
      label: t('charts.series.errorRate'),
      color: COLORS.errorRate,
      value: (row) => pct(row.errorRate),
    });
    trafficLegend.push({ label: t('charts.series.errorRate'), color: COLORS.errorRate });
  }

  const durationSeries: CompositeChartSeries[] = [];
  const durationEntries: TooltipEntry[] = [];
  const durationLegend: LegendItem[] = [];
  if (availability.latencyBand) {
    durationSeries.push(
      { name: 'p95BandBase', color: COLORS.band, type: 'area' },
      { name: 'p95BandRange', color: COLORS.band, type: 'area' },
    );
    durationLegend.push({ label: t('charts.series.normalP95'), color: COLORS.band, shape: 'band' });
  }
  durationSeries.push(
    { name: 'p50Ms', label: t('charts.series.p50'), color: COLORS.p50, type: 'line' },
    { name: 'p95Ms', label: t('charts.series.p95'), color: COLORS.p95, type: 'line' },
  );
  durationEntries.push(
    { name: 'p50Ms', label: t('charts.series.p50'), color: COLORS.p50, value: (row) => (row.p50Ms === null ? null : formatHealthMs(row.p50Ms, locale)) },
    { name: 'p95Ms', label: t('charts.series.p95'), color: COLORS.p95, value: (row) => (row.p95Ms === null ? null : formatHealthMs(row.p95Ms, locale)) },
  );
  if (availability.latencyBand) {
    durationEntries.push({
      name: 'p95Band',
      label: t('charts.series.normalP95'),
      color: COLORS.band,
      value: (row) => band(row.p95BandLower, row.p95BandUpper, (v) => formatHealthMs(v, locale)),
    });
  }
  durationLegend.push(
    { label: t('charts.series.p50'), color: COLORS.p50 },
    { label: t('charts.series.p95'), color: COLORS.p95 },
  );

  const toolSeries: CompositeChartSeries[] = [];
  const toolEntries: TooltipEntry[] = [];
  const toolLegend: LegendItem[] = [];
  if (availability.toolErrors) {
    toolSeries.push({ name: 'toolErrorRate', label: t('charts.series.toolErrorRate'), color: COLORS.toolErrorRate, type: 'line' });
    toolEntries.push({ name: 'toolErrorRate', label: t('charts.series.toolErrorRate'), color: COLORS.toolErrorRate, value: (row) => pct(row.toolErrorRate) });
    toolLegend.push({ label: t('charts.series.toolErrorRate'), color: COLORS.toolErrorRate });
  }
  if (availability.abandoned) {
    toolSeries.push({ name: 'abandonedRate', label: t('charts.series.abandonedRate'), color: COLORS.abandonedRate, type: 'line' });
    toolEntries.push({ name: 'abandonedRate', label: t('charts.series.abandonedRate'), color: COLORS.abandonedRate, value: (row) => pct(row.abandonedRate) });
    toolLegend.push({ label: t('charts.series.abandonedRate'), color: COLORS.abandonedRate });
  }

  const xAxisProps = { minTickGap: 28 };
  const markerKinds = (marker: ChartMarker) => (marker.type === 'incident' ? t('charts.markerIncident') : t('charts.markerVersion'));
  // An incident's name is long and already in the list below, so the chart only tags it; a version tag is short.
  const markerTag = (marker: ChartMarker) => (marker.type === 'incident' ? t('charts.markerIncident') : marker.label);
  const markerTitle = (marker: ChartMarker) => `${markerKinds(marker)}: ${marker.label} · ${markerTime(marker.t, locale)}`;

  return (
    <div className="ds-col ds-gap-md">
      <EntityHealthKpiTiles series={series} requestsLabel={requestsLabel} />

      {!drawable ? (
        <div className="ds-card ds-card-pad">
          <span className="ds-muted" style={{ fontSize: 13 }}>{t('charts.noChartData')}</span>
        </div>
      ) : (
        <>
          <ChartCard
            title={availability.errorRate ? t('charts.sessionsAndErrors') : requests}
            ariaLabel={availability.errorRate ? t('charts.sessionsAndErrors') : requests}
            legend={trafficLegend}
          >
            <CompositeChart
              h={chartHeight}
              data={rows}
              dataKey="label"
              series={trafficSeries}
              curveType="monotone"
              connectNulls={false}
              withLegend={false}
              withDots
              dotProps={{ r: dotSize }}
              withRightYAxis={availability.errorRate || availability.errorBand}
              gridAxis="x"
              tickLine="x"
              valueFormatter={(value) => formatHealthCount(value, locale)}
              // A request count is whole: with a handful of requests the axis would otherwise tick at 0.25 steps and,
              // rounded, label them "1 1 1 0 0".
              yAxisProps={{ allowDecimals: false }}
              rightYAxisProps={{
                domain: [0, 'auto'],
                tickFormatter: (value: number) => formatHealthPercent(value, locale),
              }}
              xAxisProps={xAxisProps}
              areaProps={BAND_AREA_PROPS}
              barProps={{ fillOpacity: TRAFFIC_BAR_OPACITY }}
              referenceLines={markerLines(markers)}
              tooltipProps={{ content: createRowTooltip(byLabel, trafficEntries) as never }}
            >
              <MarkerLabels markers={markers} tagOf={markerTag} titleOf={markerTitle} />
            </CompositeChart>
          </ChartCard>

          {availability.latency ? (
            <ChartCard title={t('charts.durations')} ariaLabel={t('charts.durations')} legend={durationLegend}>
              <CompositeChart
                h={chartHeight}
                data={rows}
                dataKey="label"
                series={durationSeries}
                curveType="monotone"
                connectNulls={false}
                withLegend={false}
                withDots
                dotProps={{ r: dotSize }}
                gridAxis="x"
                tickLine="x"
                valueFormatter={(value) => formatHealthMs(value, locale)}
                xAxisProps={xAxisProps}
                areaProps={BAND_AREA_PROPS}
                referenceLines={markerLines(markers)}
                tooltipProps={{ content: createRowTooltip(byLabel, durationEntries) as never }}
              />
              {availability.latencyBand || availability.errorBand ? (
                <div className="ds-faint" style={{ fontSize: 11.5, marginTop: 6 }}>{t('charts.bandNote')}</div>
              ) : null}
            </ChartCard>
          ) : null}

          {showToolChart ? (
            <ChartCard title={t('charts.toolAndAbandoned')} ariaLabel={t('charts.toolAndAbandoned')} legend={toolLegend}>
              <CompositeChart
                h={Math.round(chartHeight * 0.75)}
                data={rows}
                dataKey="label"
                series={toolSeries}
                curveType="monotone"
                connectNulls={false}
                withLegend={false}
                withDots
                dotProps={{ r: dotSize }}
                gridAxis="x"
                tickLine="x"
                valueFormatter={(value) => formatHealthPercent(value, locale)}
                xAxisProps={xAxisProps}
                referenceLines={markerLines(markers)}
                tooltipProps={{ content: createRowTooltip(byLabel, toolEntries) as never }}
              />
            </ChartCard>
          ) : null}

          {markers.length > 0 || series.markersPartial ? (
            <div className="ds-row" style={{ flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
              {markers.length > 0 ? <span className="ds-faint">{t('charts.markers')}</span> : null}
              {markers.map((marker) => {
                const content = (
                  <>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        display: 'inline-block',
                        background: colorVar(marker.type === 'incident' ? COLORS.incident : COLORS.version),
                      }}
                    />
                    {markerKinds(marker)}: {marker.label} · {markerTime(marker.t, locale)}
                  </>
                );
                return marker.href ? (
                  <Link key={marker.key} href={marker.href} className="ds-badge ds-row ds-gap-xs">
                    {content}
                  </Link>
                ) : (
                  <span key={marker.key} className="ds-badge ds-row ds-gap-xs">{content}</span>
                );
              })}
              {series.markersPartial ? <span className="ds-faint">{t('charts.markersPartial')}</span> : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export default EntityHealthCharts;
