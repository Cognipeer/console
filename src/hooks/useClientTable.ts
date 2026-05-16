'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDebouncedValue } from '@mantine/hooks';

export const TABLE_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

interface UseClientTableOptions<TRecord> {
  records: TRecord[];
  initialPageSize?: number;
  search?: (record: TRecord, query: string) => boolean;
  debounceMs?: number;
}

export function useClientTable<TRecord>({
  records,
  initialPageSize = 25,
  search,
  debounceMs = 250,
}: UseClientTableOptions<TRecord>) {
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query.trim().toLowerCase(), debounceMs);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);

  const filteredRecords = useMemo(() => {
    if (!debouncedQuery || !search) {
      return records;
    }
    return records.filter((record) => search(record, debouncedQuery));
  }, [debouncedQuery, records, search]);

  const totalRecords = filteredRecords.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));

  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, pageSize]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const paginatedRecords = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredRecords.slice(start, start + pageSize);
  }, [filteredRecords, page, pageSize]);

  const setPageSize = (nextPageSize: number) => {
    setPageSizeState(TABLE_PAGE_SIZE_OPTIONS.includes(nextPageSize) ? nextPageSize : initialPageSize);
  };

  return {
    query,
    setQuery,
    page,
    setPage,
    pageSize,
    setPageSize,
    records: paginatedRecords,
    totalRecords,
    totalPages,
  };
}
