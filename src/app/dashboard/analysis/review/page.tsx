'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Group, Loader, Text } from '@mantine/core';
import { IconListCheck } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import type { AnalysisResultRowView } from '@/components/analysis/types';
import { useAnalysisDefinitions, useAnalysisResults } from '@/lib/api/queries/analysis';
import { decisionBadgeClass, formatAnswer, pct } from '@/components/analysis/decisionUi';

const PAGE_SIZE = 50;
const MAX_CHIPS = 3;
const NO_ROWS: AnalysisResultRowView[] = [];

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

  const definitionsQuery = useAnalysisDefinitions();
  // Only definitions with a decision model produce answers to review.
  const definitions = useMemo(
    () => (definitionsQuery.data ?? []).filter((d) => d.decisionModelKey),
    [definitionsQuery.data],
  );
  const [picked, setPicked] = useState('');
  const [page, setPage] = useState(1);
  const defsLoading = definitionsQuery.isPending;

  // The picked definition, else the preselected one, else the first.
  const definitionKey = useMemo(() => {
    if (picked) return picked;
    if (preselect && definitions.some((d) => d.key === preselect)) return preselect;
    return definitions[0]?.key ?? '';
  }, [picked, preselect, definitions]);

  const resultsQuery = useAnalysisResults(
    definitionKey
      ? {
          definitionKey,
          needsReview: true,
          sort: 'confidence',
          limit: PAGE_SIZE,
          skip: (page - 1) * PAGE_SIZE,
        }
      : null,
  );
  const rows = definitionKey && !resultsQuery.isError ? resultsQuery.data?.results ?? NO_ROWS : NO_ROWS;
  const total = definitionKey && !resultsQuery.isError ? resultsQuery.data?.total ?? 0 : 0;
  const loading = Boolean(definitionKey) && resultsQuery.isFetching;

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
            onChange: (v) => { setPicked(v); setPage(1); },
            options: definitions.map((d) => ({ value: d.key, label: d.name })),
            width: 240,
            ariaLabel: 'Definition',
          }]}
          onRefresh={() => void resultsQuery.refetch()}
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
