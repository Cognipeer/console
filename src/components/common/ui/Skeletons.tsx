'use client';

import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { Skeleton, VisuallyHidden } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';

/*
 * Fixed-geometry loading placeholders. They reuse the real layout classes
 * (ds-page, ds-page-header, ds-stat, ds-card, ds-toolbar, ds-tbl,
 * detail-header, ds-tabs) and draw text placeholders inside the same line
 * boxes as the real text, so swapping to content keeps the layout in place.
 *
 * Every exported skeleton is a busy region with one accessible label. When
 * skeletons are nested, only the outermost region is announced.
 */

type Length = number | string;

/** Rows drawn by table skeletons when the caller has no better estimate. */
export const DEFAULT_SKELETON_ROWS = 6;

const STAT_LABEL_WIDTHS = [96, 78, 108, 88];
const STAT_VALUE_WIDTHS = [64, 48, 72, 56];
const HEADER_CELL_WIDTHS = [72, 56, 64, 48, 60, 52];
const CELL_WIDTHS = ['68%', '52%', '60%', '44%', '56%', '48%', '64%'];
const LINE_WIDTHS = ['92%', '78%', '86%', '64%', '72%', '58%'];
const TAB_WIDTHS = [60, 72, 52, 64, 48, 56];
const ACTION_WIDTHS = [112, 96, 88];

const CARD_PAD_CLASS = {
  sm: 'ds-card-pad-sm',
  md: 'ds-card-pad',
  lg: 'ds-card-pad-lg',
} as const;

const SkeletonRegionContext = createContext(false);

function joinClasses(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

export interface SkeletonTextProps {
  /**
   * Bar width. Use px (or `clamp()`) inside auto-sized containers such as
   * flex rows and headers; percentages resolve against the nearest block.
   */
  width?: Length;
  /** Bar height; `em` values follow the surrounding font size. */
  height?: Length;
}

/**
 * Inline text placeholder. It sits in the line box of the surrounding
 * typography, so its container keeps the height of one line of real text.
 */
export function SkeletonText({ width = 120, height = '0.72em' }: SkeletonTextProps) {
  return (
    <span className="ds-skeleton-text">
      <Skeleton
        width={width}
        height={height}
        radius="sm"
        style={{ display: 'inline-block', verticalAlign: 'middle', maxWidth: '100%' }}
      />
    </span>
  );
}

export interface SkeletonRegionProps {
  /** Accessible label; defaults to "Loading content…". */
  label?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * Busy wrapper for skeleton content. The bars carry no text, so the region
 * exposes a single loading label to assistive technology. Nested regions
 * render their children only (plus a wrapper when `className`/`style` is set).
 */
export function SkeletonRegion({ label, className, style, children }: SkeletonRegionProps) {
  const nested = useContext(SkeletonRegionContext);
  const t = useTranslations('navigationFeedback');

  if (nested) {
    return className || style ? (
      <div className={joinClasses('ds-skeleton', className)} style={style}>
        {children}
      </div>
    ) : (
      <>{children}</>
    );
  }

  return (
    <SkeletonRegionContext.Provider value>
      <div className={joinClasses('ds-skeleton', className)} style={style} aria-busy="true">
        {children}
        <VisuallyHidden>{label ?? t('loadingContent')}</VisuallyHidden>
      </div>
    </SkeletonRegionContext.Provider>
  );
}

/** A count of placeholders, or their exact widths in px. */
export type SkeletonWidths = number | readonly number[];

function resolveWidths(value: SkeletonWidths, defaults: readonly number[]): number[] {
  if (typeof value !== 'number') return [...value];
  return Array.from({ length: Math.max(0, value) }, (_, index) => defaults[index % defaults.length]);
}

function ActionBones({ actions }: { actions: SkeletonWidths }) {
  const widths = resolveWidths(actions, ACTION_WIDTHS);
  if (widths.length === 0) return null;
  return (
    <div className="ds-row ds-gap-sm" style={{ flexShrink: 0 }}>
      {widths.map((width, index) => (
        <Skeleton key={index} width={width} height={36} radius="sm" />
      ))}
    </div>
  );
}

// ─── Page header ────────────────────────────────────────────────────────────

export interface PageHeaderSkeletonProps {
  eyebrow?: boolean;
  subtitle?: boolean;
  /** Action placeholders (sm controls, 36px) on the right. */
  actions?: SkeletonWidths;
  titleWidth?: Length;
  label?: string;
}

/** Mirrors `PageHeader` (eyebrow, h1 title, subtitle, actions). */
export function PageHeaderSkeleton({
  eyebrow = true,
  subtitle = true,
  actions = 1,
  titleWidth = 220,
  label,
}: PageHeaderSkeletonProps) {
  return (
    <SkeletonRegion label={label}>
      <div className="ds-page-header">
        <div style={{ minWidth: 0 }}>
          {eyebrow ? (
            <div className="ds-eyebrow" style={{ marginBottom: 4 }}>
              <SkeletonText width={104} />
            </div>
          ) : null}
          <div className="ds-h1">
            <SkeletonText width={titleWidth} />
          </div>
          {subtitle ? (
            <div style={{ marginTop: 4, fontSize: 13.5 }}>
              <SkeletonText width="clamp(160px, 38vw, 380px)" />
            </div>
          ) : null}
        </div>
        <ActionBones actions={actions} />
      </div>
    </SkeletonRegion>
  );
}

// ─── Stat tiles ─────────────────────────────────────────────────────────────

export interface StatGridSkeletonProps {
  count?: number;
  /** Reserve the delta line (`StatTile` `delta`). */
  delta?: boolean;
  /** Reserve the sparkline (`StatTile` `spark`). */
  spark?: boolean;
  style?: CSSProperties;
  label?: string;
}

/** Mirrors a `ds-stat-grid` of `StatTile`s. */
export function StatGridSkeleton({
  count = 4,
  delta = false,
  spark = false,
  style,
  label,
}: StatGridSkeletonProps) {
  return (
    <SkeletonRegion label={label}>
      <div className="ds-stat-grid" style={style}>
        {Array.from({ length: count }, (_, index) => (
          <div key={index} className="ds-stat">
            <div className="ds-stat-label">
              <SkeletonText width={STAT_LABEL_WIDTHS[index % STAT_LABEL_WIDTHS.length]} />
            </div>
            <div className="ds-stat-value">
              <SkeletonText width={STAT_VALUE_WIDTHS[index % STAT_VALUE_WIDTHS.length]} />
            </div>
            {delta ? (
              <div className="ds-stat-delta">
                <SkeletonText width={96} />
              </div>
            ) : null}
            {spark ? (
              <div className="ds-stat-spark">
                <Skeleton height="100%" radius="sm" style={{ opacity: 0.6 }} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

// ─── Tables (DataGrid) ──────────────────────────────────────────────────────

export interface DataGridSkeletonRowsProps {
  /** Data columns, excluding the selection and actions columns. */
  columns: number;
  rows?: number;
  selectable?: boolean;
  withActions?: boolean;
  /** Per-column alignment so bars line up with the real cell content. */
  align?: ReadonlyArray<'left' | 'right' | 'center' | undefined>;
}

/** Placeholder `<tr>`s for a `ds-tbl` body; rows keep the real 44px height. */
export function DataGridSkeletonRows({
  columns,
  rows = DEFAULT_SKELETON_ROWS,
  selectable = false,
  withActions = false,
  align,
}: DataGridSkeletonRowsProps) {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <tr key={`skeleton-${rowIndex}`} className="ds-skeleton-row" aria-hidden="true">
          {selectable ? (
            <td>
              <Skeleton width={16} height={16} radius={4} />
            </td>
          ) : null}
          {Array.from({ length: columns }, (_, columnIndex) => (
            <td key={columnIndex} style={{ textAlign: align?.[columnIndex] ?? 'left' }}>
              <SkeletonText
                width={CELL_WIDTHS[(rowIndex + columnIndex * 3) % CELL_WIDTHS.length]}
              />
            </td>
          ))}
          {withActions ? <td /> : null}
        </tr>
      ))}
    </>
  );
}

export interface TableSkeletonProps {
  rows?: number;
  columns?: number;
  /** Mirror the DataGrid toolbar (search, filters, refresh). */
  toolbar?: boolean;
  /** Filter select placeholders in the toolbar (count or widths). */
  filters?: SkeletonWidths;
  selectable?: boolean;
  /** Reserve the footer; `pagination` adds Prev / Next placeholders. */
  footer?: boolean | 'pagination';
  style?: CSSProperties;
  label?: string;
}

/** Mirrors a `DataGrid` card: toolbar, header row, body rows and footer. */
export function TableSkeleton({
  rows = DEFAULT_SKELETON_ROWS,
  columns = 5,
  toolbar = true,
  filters = 1,
  selectable = false,
  footer = false,
  style,
  label,
}: TableSkeletonProps) {
  return (
    <SkeletonRegion label={label}>
      <div className="ds-card" style={{ overflow: 'hidden', ...style }}>
        {toolbar ? (
          <div className="ds-toolbar">
            <Skeleton height={32} radius="sm" style={{ flex: 1, maxWidth: 320 }} />
            {resolveWidths(filters, [140]).map((width, index) => (
              <Skeleton key={index} height={32} width={width} radius="sm" />
            ))}
            <div style={{ flex: 1 }} />
            <Skeleton height={28} width={28} radius="md" />
          </div>
        ) : null}
        <div className="ds-tbl-wrap">
          <table className="ds-tbl" aria-hidden="true">
            <thead>
              <tr>
                {selectable ? <th style={{ width: 36 }} /> : null}
                {Array.from({ length: columns }, (_, index) => (
                  <th key={index}>
                    <SkeletonText
                      width={HEADER_CELL_WIDTHS[index % HEADER_CELL_WIDTHS.length]}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <DataGridSkeletonRows rows={rows} columns={columns} selectable={selectable} />
            </tbody>
          </table>
        </div>
        {footer ? (
          // Mirrors the DataGrid footer bar.
          <div
            className="ds-row-between"
            style={{
              padding: '12px 18px',
              borderTop: '1px solid var(--ds-border-soft)',
              fontSize: 12.5,
            }}
          >
            <SkeletonText width={140} />
            {footer === 'pagination' ? (
              <div className="ds-row ds-gap-sm">
                <Skeleton width={68} height={30} radius="sm" />
                <Skeleton width={68} height={30} radius="sm" />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </SkeletonRegion>
  );
}

// ─── Cards and tabs ─────────────────────────────────────────────────────────

export interface CardSkeletonProps {
  /** Title line (`ds-h3`). */
  title?: boolean;
  /** Text lines below the title. */
  lines?: number;
  /** Height (px) of a chart / media block below the lines. */
  blockHeight?: number;
  pad?: 'sm' | 'md' | 'lg';
  style?: CSSProperties;
  label?: string;
}

/** Mirrors a `ds-card` with a title, text lines and an optional media block. */
export function CardSkeleton({
  title = true,
  lines = 3,
  blockHeight,
  pad = 'lg',
  style,
  label,
}: CardSkeletonProps) {
  return (
    <SkeletonRegion label={label}>
      <div className={joinClasses('ds-card', CARD_PAD_CLASS[pad])} style={style}>
        {title ? (
          <div className="ds-h3" style={{ marginBottom: lines > 0 || blockHeight ? 12 : 0 }}>
            <SkeletonText width={150} />
          </div>
        ) : null}
        {Array.from({ length: lines }, (_, index) => (
          <div key={index} style={{ fontSize: 13 }}>
            <SkeletonText width={LINE_WIDTHS[index % LINE_WIDTHS.length]} />
          </div>
        ))}
        {blockHeight ? (
          <Skeleton
            height={blockHeight}
            radius="sm"
            style={{ marginTop: lines > 0 ? 12 : 0 }}
          />
        ) : null}
      </div>
    </SkeletonRegion>
  );
}

export interface TabsSkeletonProps {
  count?: number;
  /** Tabs with a leading 14px icon (keeps the TabsBar height identical). */
  icons?: boolean;
  label?: string;
}

/** Mirrors `TabsBar`. */
export function TabsSkeleton({ count = 4, icons = false, label }: TabsSkeletonProps) {
  return (
    <SkeletonRegion label={label}>
      <div className="ds-tabs">
        {Array.from({ length: count }, (_, index) => {
          const width = TAB_WIDTHS[index % TAB_WIDTHS.length];
          return (
            <span key={index} className="ds-tab">
              <span>
                {icons ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Skeleton width={14} height={14} radius="sm" />
                    <SkeletonText width={width} />
                  </span>
                ) : (
                  <SkeletonText width={width} />
                )}
              </span>
            </span>
          );
        })}
      </div>
    </SkeletonRegion>
  );
}

// ─── Pages ──────────────────────────────────────────────────────────────────

export interface PageSkeletonProps {
  /** Header action placeholders. */
  actions?: SkeletonWidths;
  /** Stat tiles between the header and the body; 0 hides the row. */
  stats?: number;
  /** Body placeholder: a DataGrid-like table (default) or a content card. */
  body?: 'table' | 'card';
  label?: string;
}

/** Neutral page placeholder: `PageContainer` + header + optional stats + body. */
export function PageSkeleton({ actions = 1, stats = 0, body = 'table', label }: PageSkeletonProps) {
  return (
    <SkeletonRegion className="ds-page" label={label}>
      <PageHeaderSkeleton actions={actions} />
      {stats > 0 ? <StatGridSkeleton count={stats} /> : null}
      {body === 'table' ? <TableSkeleton /> : <CardSkeleton lines={5} />}
    </SkeletonRegion>
  );
}

export interface DetailSkeletonProps {
  /** Back button placeholder (DetailShell renders one). */
  withBack?: boolean;
  /** Tab placeholders; 0 hides the tab bar. */
  tabs?: number;
  tabIcons?: boolean;
  /** Header action placeholders. */
  actions?: SkeletonWidths;
  /** Two-column body with a 320px aside (`DetailTwoCol`). */
  aside?: boolean;
  label?: string;
}

/** Mirrors `DetailShell`: header with icon and meta row, tabs, two-column body. */
export function DetailSkeleton({
  withBack = true,
  tabs = 4,
  tabIcons = false,
  actions = 2,
  aside = true,
  label,
}: DetailSkeletonProps) {
  return (
    <SkeletonRegion className="ds-page" label={label}>
      <div className="detail-header">
        {withBack ? (
          <Skeleton width={34} height={34} radius="md" style={{ flexShrink: 0 }} />
        ) : null}
        <Skeleton width={52} height={52} radius={12} style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="detail-title-row">
            <div className="ds-h2">
              <SkeletonText width={220} />
            </div>
          </div>
          <div className="detail-meta-row">
            <SkeletonText width="clamp(140px, 30vw, 300px)" />
          </div>
        </div>
        <ActionBones actions={actions} />
      </div>
      {tabs > 0 ? <TabsSkeleton count={tabs} icons={tabIcons} /> : null}
      <div className={aside ? 'detail-grid' : undefined}>
        <div className="ds-col ds-gap-md">
          <CardSkeleton lines={1} blockHeight={140} />
          <CardSkeleton lines={3} />
        </div>
        {aside ? <CardSkeleton lines={6} /> : null}
      </div>
    </SkeletonRegion>
  );
}
