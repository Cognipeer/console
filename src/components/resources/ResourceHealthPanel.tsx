'use client';

import { useCallback, useState } from 'react';
import { Alert, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTranslations } from '@/lib/i18n';
import { errorMessage } from '@/lib/api/client';
import { useResourceHealth } from '@/lib/api/queries/resources';
import { tryTranslate } from './i18nLookup';
import ProjectCell from './ProjectCell';
import { edgeKindLabel, type EdgeSeverity, type ResourceRefView } from './ResourceUsagePanel';

// Mirrors the HealthIssue / GET /api/resources/health contract.
export interface HealthIssue {
  id: string;
  kind: string;
  severity: EdgeSeverity;
  resource: ResourceRefView;
  related?: ResourceRefView[];
  edgeKind?: string;
  field?: string;
  targetType?: string;
  targetKey?: string;
}

export interface HealthSummary {
  error: number;
  warning: number;
  byKind: Record<string, number>;
}

interface HealthResponse {
  summary: HealthSummary;
  issues: HealthIssue[];
  truncated: boolean;
  graphUnavailable?: boolean;
  generatedAt: string;
}

export const ISSUE_KINDS = [
  'broken-reference',
  'cross-project-reference',
  'inactive-reference',
  'ambiguous-reference',
  'duplicate-key',
  'mcp-dual-registration',
] as const;

const REFERENCE_KINDS = new Set<string>(ISSUE_KINDS.slice(0, 4));

/** Short, human explanation of an issue (kind + severity aware). Shared with the drawer. */
export function explainIssue(t: (k: string) => string, issue: Pick<HealthIssue, 'kind' | 'severity'>): string {
  if (REFERENCE_KINDS.has(issue.kind)) {
    const specific = tryTranslate(t, `health.explain.${issue.kind}_${issue.severity}`);
    if (specific) return specific;
  }
  return t(`health.explain.${issue.kind}`);
}

export function SeverityBadge({ severity }: { severity: EdgeSeverity }) {
  const t = useTranslations('resources');
  return (
    <span className={`ds-badge ${severity === 'error' ? 'ds-badge-err' : 'ds-badge-warn'}`}>
      <span className="ds-badge-dot" />
      {t(`health.severity.${severity}`)}
    </span>
  );
}

interface Props {
  types: Array<{ type: string }>;
  onOpen(ref: ResourceRefView): void;
}

export default function ResourceHealthPanel({ types, onOpen }: Props) {
  const t = useTranslations('resources');
  const [severity, setSeverity] = useState('');
  const [kind, setKind] = useState('');
  const [type, setType] = useState('');
  const healthQuery = useResourceHealth<HealthResponse>({ severity, kind, type });
  const data = healthQuery.data ?? null;
  const loading = healthQuery.isFetching;
  const error = healthQuery.isError ? errorMessage(healthQuery.error, t('health.loadFailed')) : null;

  const typeLabel = useCallback(
    (v: string) => {
      return tryTranslate(t, `types.${v}`) ?? v;
    },
    [t],
  );

  const columns: DataGridColumn<HealthIssue>[] = [
    { key: 'severity', label: t('health.colSeverity'), render: (row) => <SeverityBadge severity={row.severity} /> },
    {
      key: 'kind',
      label: t('health.colKind'),
      render: (row) => t(`health.kind.${row.kind}`),
    },
    {
      key: 'resource',
      label: t('health.colResource'),
      render: (row) => (
        <div>
          <div style={{ fontWeight: 500 }}>{row.resource.name ?? row.resource.key ?? row.resource.id}</div>
          <div className="ds-muted" style={{ fontSize: 11.5 }}>
            {typeLabel(row.resource.type)} · <ProjectCell display={row.resource.projectDisplay} />
          </div>
        </div>
      ),
    },
    {
      key: 'target',
      label: t('health.colTarget'),
      render: (row) => (
        <div>
          {row.edgeKind ? <div style={{ fontSize: 13 }}>{edgeKindLabel(t, row.edgeKind)}</div> : null}
          {row.targetKey ? (
            <div style={{ fontFamily: 'var(--ds-font-mono, monospace)', fontSize: 11.5 }} className="ds-muted">
              {row.targetType ? `${typeLabel(row.targetType)}: ` : ''}
              {row.targetKey}
            </div>
          ) : null}
          {row.related && row.related.length > 0 ? (
            <div className="ds-muted" style={{ fontSize: 11.5 }}>
              {t('health.related')}:{' '}
              {row.related.slice(0, 3).map((r, i) => (
                <span key={`${r.id ?? r.key}:${i}`}>
                  {i > 0 ? ', ' : ''}
                  {r.name ?? r.key ?? r.id}
                  {r.projectDisplay ? (
                    <>
                      {' ('}
                      <ProjectCell display={r.projectDisplay} />
                      {')'}
                    </>
                  ) : null}
                </span>
              ))}
              {row.related.length > 3 ? ` +${row.related.length - 3}` : ''}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'explain',
      label: t('health.colExplanation'),
      render: (row) => <Text size="sm">{explainIssue(t, row)}</Text>,
    },
  ];

  return (
    <Stack gap="sm">
      {error ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('health.loadFailed')}>
          {error}
        </Alert>
      ) : null}
      {data?.graphUnavailable ? (
        <Alert color="orange" icon={<IconAlertTriangle size={16} />}>
          {t('health.graphUnavailable')}
        </Alert>
      ) : null}
      {data?.truncated ? (
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
          {t('health.truncated')}
        </Alert>
      ) : null}
      <DataGrid<HealthIssue>
        records={data?.issues ?? []}
        rowKey={(row) => row.id}
        columns={columns}
        loading={loading}
        onRowClick={(row) => onOpen(row.resource)}
        filters={[
          {
            value: severity,
            onChange: setSeverity,
            ariaLabel: t('health.filterSeverity'),
            width: 150,
            options: [
              { value: '', label: t('health.allSeverities') },
              { value: 'error', label: t('health.severity.error') },
              { value: 'warning', label: t('health.severity.warning') },
            ],
          },
          {
            value: kind,
            onChange: setKind,
            ariaLabel: t('health.filterKind'),
            width: 220,
            options: [
              { value: '', label: t('health.allKinds') },
              ...ISSUE_KINDS.map((k) => ({
                value: k,
                label: `${t(`health.kind.${k}`)}${data?.summary.byKind[k] ? ` (${data.summary.byKind[k]})` : ''}`,
              })),
            ],
          },
          {
            value: type,
            onChange: setType,
            ariaLabel: t('health.filterType'),
            width: 180,
            options: [
              { value: '', label: t('health.allTypes') },
              ...types.map((i) => ({ value: i.type, label: typeLabel(i.type) })),
            ],
          },
        ]}
        empty={{ title: t('health.emptyTitle'), description: t('health.emptyDescription') }}
      />
    </Stack>
  );
}
