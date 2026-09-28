'use client';

import { ReactNode, useMemo, type MouseEvent } from 'react';
import {
  ActionIcon,
  Button,
  Menu,
  Text,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import {
  IconChevronLeft,
  IconChevronRight,
  IconDots,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';
import {
  useIntentPrefetch,
  useNavigationFeedback,
  usePendingNavigationKey,
} from '@/components/common/navigation/useNavigationFeedback';
import { useTranslations } from '@/lib/i18n';
import { isNavigationPendingFor } from '@/lib/navigation/navigationProgress';
import RefreshIndicator from './RefreshIndicator';
import { DataGridSkeletonRows, DEFAULT_SKELETON_ROWS, SkeletonText } from './Skeletons';
import TabsBar, { type TabsBarItem } from './TabsBar';

export interface DataGridColumn<T> {
  key: string;
  label: ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  render: (row: T) => ReactNode;
}

export interface DataGridRowAction<T> {
  id?: string;
  label?: ReactNode;
  icon?: ReactNode;
  color?: 'red' | 'teal' | 'gray' | 'blue' | 'orange' | undefined;
  onClick?: (row: T) => void;
  disabled?: boolean | ((row: T) => boolean);
  hidden?: boolean | ((row: T) => boolean);
  divider?: boolean;
}

export interface DataGridFilter {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  width?: number;
  ariaLabel?: string;
}

export interface DataGridEmpty {
  icon?: ReactNode;
  title?: string;
  description?: string;
  primaryAction?: {
    label: string;
    icon?: ReactNode;
    onClick: () => void;
  };
}

export interface DataGridBulkAction<T> {
  label: ReactNode;
  icon?: ReactNode;
  color?: 'red' | 'teal' | 'gray' | 'orange' | 'blue';
  onClick: (rows: T[]) => void;
}

export interface DataGridProps<T> {
  /** Row data */
  records: T[];
  /** Stable key per row */
  rowKey: (row: T) => string;
  /** Column definitions */
  columns: DataGridColumn<T>[];
  /**
   * Loading state. With no records yet the grid draws skeleton rows under the
   * real toolbar and header; with records it keeps them and shows a subtle
   * refreshing indicator.
   */
  loading?: boolean;
  /** Skeleton rows drawn while loading without records (default 6). */
  skeletonRows?: number;
  /** Row click handler — when set, rows become "clickable" */
  onRowClick?: (row: T) => void;
  /**
   * Navigation target of a row. Enables intent prefetch (hover, focus,
   * pointer down) and a pending highlight while the navigation is in flight.
   * Without `onRowClick`, clicking the row navigates there. Render a real
   * `<Link>` in the primary cell so Cmd/Ctrl-click opens a new tab.
   */
  rowHref?: (row: T) => string | null | undefined;
  /**
   * Prefetch for `rowHref` targets: `auto` (default) mirrors a default Link,
   * `full` suits client-rendered detail pages, `false` disables it.
   */
  rowPrefetch?: 'auto' | 'full' | false;
  /** Kebab menu actions per row (right-aligned) */
  rowActions?: (row: T) => DataGridRowAction<T>[];

  /** Toolbar search input */
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  /** Toolbar filter selects */
  filters?: DataGridFilter[];
  /** Extra content placed in toolbar (right of filters) */
  toolbarRight?: ReactNode;
  /** Refresh button handler */
  onRefresh?: () => void;
  /** Whether refresh is in progress (also shows the refreshing indicator) */
  refreshing?: boolean;

  /** Tabs above the toolbar */
  tabs?: TabsBarItem[];
  activeTab?: string;
  onTabChange?: (id: string) => void;

  /** Enable selection checkboxes */
  selectable?: boolean;
  selected?: Set<string>;
  onSelectionChange?: (selected: Set<string>) => void;
  /** Bulk action buttons shown in toolbar when items are selected */
  bulkActions?: DataGridBulkAction<T>[];

  /** Empty state config */
  empty?: DataGridEmpty;

  /** Pagination */
  pagination?: {
    page: number;
    onPageChange: (page: number) => void;
    pageSize?: number;
    onPageSizeChange?: (size: number) => void;
    pageSizeOptions?: number[];
    total?: number;
    hasMore?: boolean;
  };

  /** Footer left content (e.g. "Showing N of M") */
  footerLeft?: ReactNode;
  /** Footer right content (overrides default refresh) */
  footerRight?: ReactNode;
}

export default function DataGrid<T>({
  records,
  rowKey,
  columns,
  loading,
  skeletonRows,
  onRowClick,
  rowHref,
  rowPrefetch = 'auto',
  rowActions,
  search,
  filters,
  toolbarRight,
  onRefresh,
  refreshing,
  tabs,
  activeTab,
  onTabChange,
  selectable,
  selected,
  onSelectionChange,
  bulkActions,
  empty,
  pagination,
  footerLeft,
  footerRight,
}: DataGridProps<T>) {
  const totalColumns =
    columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);

  const hasRecords = records.length > 0;
  const showSkeleton = Boolean(loading) && !hasRecords;
  const isRefreshing = !showSkeleton && Boolean(loading || refreshing);

  const tFeedback = useTranslations('navigationFeedback');
  const { push: navigate } = useNavigationFeedback();
  const pendingKey = usePendingNavigationKey(Boolean(rowHref));
  const { getIntentProps } = useIntentPrefetch({
    kind: rowPrefetch === 'full' ? 'full' : 'auto',
  });

  const activateRow = useMemo(() => {
    if (onRowClick) return onRowClick;
    if (!rowHref) return undefined;
    return (row: T) => {
      const href = rowHref(row);
      if (href) navigate(href);
    };
  }, [onRowClick, rowHref, navigate]);

  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>, row: T) => {
    if (!activateRow) return;
    // A real link inside the row handles its own click (incl. Cmd/Ctrl-click).
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (anchor && event.currentTarget.contains(anchor)) return;
    const href = rowHref?.(row);
    if (href && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    activateRow(row);
  };

  const allSelected = useMemo(() => {
    if (!selectable || !selected || records.length === 0) return false;
    return records.every((r) => selected.has(rowKey(r)));
  }, [selectable, selected, records, rowKey]);

  const someSelected = useMemo(() => {
    if (!selectable || !selected) return false;
    return records.some((r) => selected.has(rowKey(r)));
  }, [selectable, selected, records, rowKey]);

  const toggleAll = () => {
    if (!onSelectionChange) return;
    if (allSelected) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(records.map((r) => rowKey(r))));
    }
  };

  const toggleRow = (id: string) => {
    if (!onSelectionChange || !selected) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  };

  const selectedRows = useMemo(() => {
    if (!selected) return [];
    return records.filter((r) => selected.has(rowKey(r)));
  }, [records, rowKey, selected]);

  const showToolbar = Boolean(
    search ||
      (filters && filters.length > 0) ||
      toolbarRight ||
      onRefresh ||
      (selectable && bulkActions && bulkActions.length > 0),
  );

  return (
    <>
      {tabs && tabs.length > 0 && activeTab !== undefined && onTabChange ? (
        <TabsBar items={tabs} activeId={activeTab} onChange={onTabChange} />
      ) : null}

      <div
        className="ds-card"
        style={{ overflow: 'hidden', position: 'relative' }}
        aria-busy={loading || refreshing ? true : undefined}
        data-refreshing={isRefreshing || undefined}
      >
        <RefreshIndicator active={isRefreshing} />
        {showToolbar ? (
          <div className="ds-toolbar">
            {search ? (
              <div className="ds-toolbar-search">
                <IconSearch size={14} stroke={1.7} color="var(--ds-text-muted)" />
                <input
                  placeholder={search.placeholder ?? 'Filter…'}
                  value={search.value}
                  onChange={(e) => search.onChange(e.target.value)}
                />
              </div>
            ) : null}

            {(filters ?? []).map((f, i) => (
              <select
                key={`filter-${i}`}
                className="ds-select"
                value={f.value}
                onChange={(e) => f.onChange(e.target.value)}
                style={{ minWidth: f.width ?? 140 }}
                aria-label={f.ariaLabel}
              >
                {f.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ))}

            <div style={{ flex: 1 }} />

            {selectable && bulkActions && selected && selected.size > 0 ? (
              <>
                <span
                  className="ds-muted"
                  style={{ fontSize: 13 }}
                >
                  {selected.size} selected
                </span>
                {bulkActions.map((a, i) => (
                  <Button
                    key={`bulk-${i}`}
                    size="xs"
                    variant="default"
                    color={a.color}
                    leftSection={a.icon}
                    onClick={() => a.onClick(selectedRows)}
                  >
                    {a.label}
                  </Button>
                ))}
                <div
                  style={{
                    width: 1,
                    height: 20,
                    background: 'var(--ds-border-soft)',
                  }}
                />
              </>
            ) : null}

            {toolbarRight}

            {onRefresh ? (
              <Tooltip label="Refresh" withArrow>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  radius="md"
                  onClick={onRefresh}
                  loading={refreshing}
                  aria-label="Refresh"
                >
                  <IconRefresh size={14} stroke={1.7} />
                </ActionIcon>
              </Tooltip>
            ) : null}
          </div>
        ) : null}

        {!loading && !hasRecords ? (
          <EmptyView empty={empty} />
        ) : (
          <div className="ds-tbl-wrap">
            <table className="ds-tbl">
              <thead>
                <tr>
                  {selectable ? (
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        className="ds-checkbox"
                        checked={allSelected}
                        disabled={!hasRecords}
                        ref={(el) => {
                          if (el)
                            el.indeterminate = someSelected && !allSelected;
                        }}
                        onChange={toggleAll}
                        aria-label="Select all rows"
                      />
                    </th>
                  ) : null}
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      style={{
                        width: c.width,
                        textAlign: c.align ?? 'left',
                      }}
                    >
                      {c.label}
                    </th>
                  ))}
                  {rowActions ? (
                    <th
                      style={{ width: 60, textAlign: 'right' }}
                      aria-label="Actions"
                    />
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {showSkeleton ? (
                  <DataGridSkeletonRows
                    columns={columns.length}
                    rows={skeletonRows ?? DEFAULT_SKELETON_ROWS}
                    selectable={selectable}
                    withActions={Boolean(rowActions)}
                    align={columns.map((c) => c.align)}
                  />
                ) : null}
                {records.map((row) => {
                  const id = rowKey(row);
                  const isSel = selected?.has(id) ?? false;
                  const actions = rowActions ? rowActions(row) : [];
                  const href = rowHref ? rowHref(row) : null;
                  const isRowPending =
                    Boolean(href && pendingKey) &&
                    typeof window !== 'undefined' &&
                    isNavigationPendingFor(pendingKey, href, window.location.href);
                  return (
                    <tr
                      key={id}
                      className={`${activateRow ? 'clickable' : ''} ${isSel ? 'selected' : ''}`}
                      onClick={activateRow ? (event) => handleRowClick(event, row) : undefined}
                      data-pending={isRowPending || undefined}
                      {...(href && rowPrefetch !== false ? getIntentProps(href) : null)}
                    >
                      {selectable ? (
                        <td
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleRow(id);
                          }}
                        >
                          <input
                            type="checkbox"
                            className="ds-checkbox"
                            checked={isSel}
                            onChange={() => {}}
                            aria-label="Select row"
                          />
                        </td>
                      ) : null}
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          style={{ textAlign: c.align ?? 'left' }}
                        >
                          {c.render(row)}
                        </td>
                      ))}
                      {rowActions ? (
                        <td
                          style={{ textAlign: 'right' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <RowActionsMenu actions={actions} row={row} />
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {showSkeleton ? <VisuallyHidden>{tFeedback('loadingContent')}</VisuallyHidden> : null}

        {(footerLeft || footerRight || pagination) && (hasRecords || showSkeleton) ? (
          <div
            className="ds-row-between"
            style={{
              padding: '12px 18px',
              borderTop: '1px solid var(--ds-border-soft)',
              fontSize: 12.5,
              color: 'var(--ds-text-muted)',
            }}
          >
            <span>{showSkeleton && footerLeft ? <SkeletonText width={140} /> : footerLeft}</span>
            <div className="ds-row ds-gap-sm">
              {footerRight}
              {pagination ? (
                <>
                  {pagination.onPageSizeChange && pagination.pageSizeOptions?.length ? (
                    <select
                      className="ds-select"
                      value={pagination.pageSize}
                      aria-label="Rows per page"
                      style={{ fontSize: 12, padding: '2px 6px' }}
                      onChange={(e) => pagination.onPageSizeChange?.(Number(e.target.value))}
                    >
                      {pagination.pageSizeOptions.map((n) => (
                        <option key={n} value={n}>{n} / page</option>
                      ))}
                    </select>
                  ) : null}
                  <Button
                    variant="default"
                    size="xs"
                    disabled={Boolean(loading) || pagination.page <= 1}
                    leftSection={<IconChevronLeft size={12} />}
                    onClick={() =>
                      pagination.onPageChange(Math.max(1, pagination.page - 1))
                    }
                  >
                    Prev
                  </Button>
                  <span className="ds-mono" style={{ fontSize: 12 }}>
                    {pagination.page}
                  </span>
                  <Button
                    variant="default"
                    size="xs"
                    disabled={Boolean(loading) || pagination.hasMore === false}
                    rightSection={<IconChevronRight size={12} />}
                    onClick={() => pagination.onPageChange(pagination.page + 1)}
                  >
                    Next
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Reserved column count for screen-readers in case of debug */}
        <span hidden aria-hidden="true">
          {totalColumns}
        </span>
      </div>
    </>
  );
}

function EmptyView({ empty }: { empty?: DataGridEmpty }) {
  if (!empty) {
    return (
      <div className="ds-empty">
        <Text size="sm" c="dimmed">
          No records found.
        </Text>
      </div>
    );
  }
  return (
    <div className="ds-empty">
      {empty.icon ? <div className="ds-empty-icon">{empty.icon}</div> : null}
      {empty.title ? (
        <div className="ds-h4" style={{ marginBottom: 4 }}>
          {empty.title}
        </div>
      ) : null}
      {empty.description ? (
        <Text size="sm" c="dimmed" mb="md" maw={440} ta="center">
          {empty.description}
        </Text>
      ) : null}
      {empty.primaryAction ? (
        <Button
          size="sm"
          color="teal"
          leftSection={empty.primaryAction.icon}
          onClick={empty.primaryAction.onClick}
        >
          {empty.primaryAction.label}
        </Button>
      ) : null}
    </div>
  );
}

function RowActionsMenu<T>({
  actions,
  row,
}: {
  actions: DataGridRowAction<T>[];
  row: T;
}) {
  const visible = actions.filter((a) => {
    if (!a.hidden) return true;
    return typeof a.hidden === 'function' ? !a.hidden(row) : !a.hidden;
  });
  if (visible.length === 0) return null;
  return (
    <Menu withinPortal position="bottom-end" withArrow>
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" size="md" radius="md">
          <IconDots size={16} stroke={1.7} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {visible.map((a, idx) => {
          if (a.divider) return <Menu.Divider key={`d-${idx}`} />;
          const disabled =
            typeof a.disabled === 'function' ? a.disabled(row) : !!a.disabled;
          return (
            <Menu.Item
              key={a.id ?? `${idx}`}
              color={a.color}
              leftSection={a.icon}
              disabled={disabled}
              onClick={() => a.onClick?.(row)}
            >
              {a.label}
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}
