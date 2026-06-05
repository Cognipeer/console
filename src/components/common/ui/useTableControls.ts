'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * Client-side search + pagination for DataGrid lists.
 *
 * The list workspaces (evaluations, red team, analysis, …) load their full
 * record set up front, so this hook layers filtering and paging purely on the
 * client — no backend changes. It returns the slice for the current page plus
 * ready-made `search` / `pagination` objects to spread into <DataGrid>.
 *
 *   const ctl = useTableControls(rows, {
 *     searchText: (r) => `${r.name} ${r.key}`,
 *     searchPlaceholder: 'Filter…',
 *   });
 *   <DataGrid records={ctl.records} search={ctl.search} pagination={ctl.pagination}
 *     footerLeft={ctl.footerLeft('items')} … />
 */
export interface UseTableControlsOptions<T> {
  /** Build the searchable text for a row (matched case-insensitively, substring). */
  searchText?: (row: T) => string;
  /** Placeholder for the search box. */
  searchPlaceholder?: string;
  /** Extra predicate applied before search (e.g. dropdown filters). */
  filter?: (row: T) => boolean;
  /**
   * Serialized active filter values. When this string changes the view resets
   * to the first page (so a new filter doesn't strand you on an empty page).
   */
  filterKey?: string;
  /** Rows per page (default 20). */
  pageSize?: number;
}

export interface TableControls<T> {
  /** Rows to render for the current page. */
  records: T[];
  /** Row count after filtering/search (across all pages). */
  filteredCount: number;
  /** Row count before filtering/search. */
  totalCount: number;
  /** Current search query. */
  query: string;
  /** Spread into <DataGrid search={…} /> — undefined when no `searchText` given. */
  search?: { value: string; onChange: (value: string) => void; placeholder?: string };
  /** Spread into <DataGrid pagination={…} />. */
  pagination: {
    page: number;
    onPageChange: (page: number) => void;
    hasMore: boolean;
    total: number;
  };
  /** Convenience footer text, e.g. "Showing 20 of 134 items". */
  footerLeft: (noun?: string) => string;
}

export function useTableControls<T>(
  records: T[],
  options: UseTableControlsOptions<T> = {},
): TableControls<T> {
  const { searchText, searchPlaceholder, filter, filterKey, pageSize = 20 } = options;
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter((row) => {
      if (filter && !filter(row)) return false;
      if (!q || !searchText) return true;
      return searchText(row).toLowerCase().includes(q);
    });
  }, [records, query, searchText, filter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));

  // Reset to the first page whenever the active dropdown filters change.
  useEffect(() => {
    setPage(1);
  }, [filterKey]);

  // Keep the page in range when the result set shrinks (search/filter/refresh).
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  );

  return {
    records: paged,
    filteredCount: filtered.length,
    totalCount: records.length,
    query,
    search: searchText
      ? {
          value: query,
          onChange: (value: string) => {
            setQuery(value);
            setPage(1);
          },
          placeholder: searchPlaceholder,
        }
      : undefined,
    pagination: {
      page,
      onPageChange: setPage,
      hasMore: page < pageCount,
      total: filtered.length,
    },
    footerLeft: (noun = 'items') =>
      `Showing ${paged.length} of ${filtered.length} ${noun}`,
  };
}
