'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { IconChevronLeft, IconChevronRight, IconSearch } from '@tabler/icons-react';

const input: CSSProperties = {
  padding: '5px 10px 5px 28px', borderRadius: 6, border: '1px solid var(--ds-border, #d1d5db)',
  fontSize: 12.5, background: 'var(--ds-surface, #fff)', color: 'inherit', width: 200,
};
const pagerBtn: CSSProperties = {
  padding: '3px 7px', borderRadius: 6, border: '1px solid var(--ds-border, #d1d5db)',
  background: 'var(--ds-surface, #f9fafb)', cursor: 'pointer', fontSize: 12, display: 'inline-flex', alignItems: 'center',
};
const muted: CSSProperties = { fontSize: 12, color: 'var(--ds-muted, #6b7280)' };

/** Client-side search + pagination over an in-memory list. */
export function useListControls<T>(rows: T[], getText: (r: T) => string, pageSize = 8) {
  const [query, setQueryRaw] = useState('');
  const [page, setPage] = useState(1);

  const q = query.trim().toLowerCase();
  const filtered = q ? rows.filter((r) => getText(r).toLowerCase().includes(q)) : rows;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const items = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Clamp page if the filtered set shrank (e.g. after deletes/filtering).
  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const setQuery = (v: string) => {
    setQueryRaw(v);
    setPage(1);
  };

  return {
    query, setQuery, page: safePage, setPage, pageCount, items,
    total: filtered.length, allTotal: rows.length, pageSize, from: filtered.length === 0 ? 0 : (safePage - 1) * pageSize + 1,
    to: Math.min(safePage * pageSize, filtered.length),
  };
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <IconSearch size={14} style={{ position: 'absolute', left: 9, color: 'var(--ds-muted, #9ca3af)' }} />
      <input style={input} value={value} placeholder={placeholder ?? 'Search…'} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function Pager({
  page, pageCount, setPage, from, to, total,
}: { page: number; pageCount: number; setPage: (p: number) => void; from: number; to: number; total: number }) {
  if (total === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
      <span style={muted}>{from}–{to} of {total}</span>
      <button style={{ ...pagerBtn, opacity: page <= 1 ? 0.4 : 1 }} disabled={page <= 1} onClick={() => setPage(page - 1)}>
        <IconChevronLeft size={14} />
      </button>
      <span style={muted}>{page} / {pageCount}</span>
      <button style={{ ...pagerBtn, opacity: page >= pageCount ? 0.4 : 1 }} disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
        <IconChevronRight size={14} />
      </button>
    </div>
  );
}
