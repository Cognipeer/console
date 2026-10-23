'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Group, Loader, Text } from '@mantine/core';
import { IconListCheck } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import type { AnalysisDefinitionView, AnalysisResultRowView } from '@/components/analysis/types';
import { decisionBadgeClass, formatAnswer, pct } from '@/components/analysis/decisionUi';

const PAGE_SIZE = 50;
const MAX_CHIPS = 3;

function fmtDate(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

/** Chips for the answers that triggered the flag (all of them for a spot-check). */
function flaggedDecisions(row: AnalysisResultRowView) {
  const entries = Object.entries(row.decisions ?? {});
  const flagged = entries.filter(([, d]) => d.needsReview || d.refused);
  return flagged.length > 0 ? flagged : entries;
}

export default function AnalysisReviewQueuePage() {
  const searchParams = useSearchParams();
  const preselect = searchParams?.get('definition') ?? '';

  const [definitions, setDefinitions] = useState<AnalysisDefinitionView[]>([]);
  const [definitionKey, setDefinitionKey] = useState('');
  const [defsLoading, setDefsLoading] = useState(true);
  const [rows, setRows] = useState<AnalysisResultRowView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  // Only definitions with a decision model produce answers to review.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/analysis/definitions', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const list = ((await res.json()).definitions ?? []) as AnalysisDefinitionView[];
        const withDecisions = list.filter((d) => d.decisionModelKey);
        setDefinitions(withDecisions);
        setDefinitionKey((current) => {
          if (current) return current;
          if (preselect && withDecisions.some((d) => d.key === preselect)) return preselect;
          return withDecisions[0]?.key ?? '';
        });
      } finally {
        if (!cancelled) setDefsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [preselect]);

  const load = useCallback(async (key: string, pageNo: number) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        definitionKey: key,
        needsReview: 'true',
        sort: 'confidence',
        limit: String(PAGE_SIZE),
        skip: String((pageNo - 1) * PAGE_SIZE),
      });
      const res = await fetch(`/api/analysis/results?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) { setRows([]); setTotal(0); return; }
      const body = await res.json();
      setRows(body.results ?? []);
      setTotal(typeof body.total === 'number' ? body.total : 0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (definitionKey) void load(definitionKey, page);
  }, [definitionKey, page, load]);

  const columns: DataGridColumn<AnalysisResultRowView>[] = [
    { key: 'title', label: 'Conversation', render: (r) => <span>{r.title || 'Untitled session'}</span> },
    {
      key: 'flagged',
      label: 'Flagged',
      render: (r) => {
        const entries = flaggedDecisions(r);
        return (
          <Group gap={4} style={{ flexWrap: 'wrap' }}>
            {entries.slice(0, MAX_CHIPS).map(([k, d]) => (
              <span key={k} className={decisionBadgeClass(d)} title={`${k}: ${formatAnswer(d)} · ${pct(d.confidence)}`}>
                {k}: {formatAnswer(d)} · {pct(d.confidence)}
              </span>
            ))}
            {entries.length > MAX_CHIPS ? <span className="ds-faint" style={{ fontSize: 11 }}>+{entries.length - MAX_CHIPS}</span> : null}
          </Group>
        );
      },
    },
    { key: 'reason', label: 'Reason', render: (r) => <span className="ds-badge">{r.reviewReason === 'spot_check' ? 'Spot-check' : 'Low confidence'}</span> },
    { key: 'conf', label: 'Lowest confidence', align: 'right', render: (r) => <span>{pct(r.minConfidence)}</span> },
    { key: 'analyzed', label: 'Analyzed', render: (r) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(r.analyzedAt)}</span> },
  ];

  if (defsLoading) {
    return <PageContainer><Group justify="center" mt={80}><Loader /></Group></PageContainer>;
  }

  const resultHref = (r: AnalysisResultRowView) => `/dashboard/analysis/results/${r.id}?queue=${encodeURIComponent(definitionKey)}`;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Analysis"
        title="Review"
        subtitle={definitionKey ? `${total} ${total === 1 ? 'answer needs' : 'answers need'} review` : 'Check the decision model\'s uncertain answers'}
      />

      {definitions.length === 0 ? (
        <Text c="dimmed" size="sm">No definition uses a decision model yet. Set a decision model on a definition to review its answers here.</Text>
      ) : (
        <DataGrid<AnalysisResultRowView>
          records={rows}
          rowKey={(r) => r.id}
          columns={columns}
          loading={loading}
          rowHref={resultHref}
          filters={[{
            value: definitionKey,
            onChange: (v) => { setDefinitionKey(v); setPage(1); },
            options: definitions.map((d) => ({ value: d.key, label: d.name })),
            width: 240,
            ariaLabel: 'Definition',
          }]}
          onRefresh={() => void load(definitionKey, page)}
          refreshing={loading}
          pagination={{ page, onPageChange: setPage, pageSize: PAGE_SIZE, total, hasMore: page * PAGE_SIZE < total }}
          footerLeft={total > 0 ? `${total} to review` : undefined}
          empty={{
            icon: <IconListCheck size={26} stroke={1.7} />,
            title: 'Nothing to review',
            description: 'Answers below the confidence threshold appear here.',
          }}
        />
      )}
    </PageContainer>
  );
}
