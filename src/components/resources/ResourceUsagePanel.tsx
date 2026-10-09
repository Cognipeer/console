'use client';

import { Group, Stack, Text, Tooltip } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { tryTranslate } from './i18nLookup';
import ProjectCell, { projectDisplayLabel, type ProjectDisplay } from './ProjectCell';

// Mirrors the ResourceEdgeView / ResourceRefView contract of GET /api/resources/:type/:id.
export interface ResourceRefView {
  type: string;
  id: string | null;
  key: string | null;
  name: string | null;
  projectId: string | null;
  projectName: string | null;
  /** null for a target that does not exist. */
  projectDisplay: ProjectDisplay | null;
  crn: string | null;
}

export type EdgeStatus = 'ok' | 'missing' | 'cross-project' | 'inactive' | 'ambiguous';
export type EdgeSeverity = 'error' | 'warning';

export interface ResourceEdgeView {
  kind: string;
  field: string;
  direction: 'out' | 'in';
  status: EdgeStatus;
  severity: EdgeSeverity | null;
  other: ResourceRefView;
  candidates?: ResourceRefView[];
}

export interface ResourceUsagePanelProps {
  uses?: ResourceEdgeView[];
  usedBy?: ResourceEdgeView[];
  onOpen?(ref: ResourceRefView): void;
  compact?: boolean;
}

const STATUS_CLASS: Record<EdgeStatus, string> = {
  ok: 'ds-badge-ok',
  missing: 'ds-badge-err',
  'cross-project': 'ds-badge-warn',
  inactive: 'ds-badge-warn',
  ambiguous: 'ds-badge-warn',
};

const MONO = { fontFamily: 'var(--ds-font-mono, monospace)', fontSize: 11.5 } as const;

/**
 * Translate with a fallback: the i18n helper echoes the key for unknown ones, so
 * a new server-side edge kind degrades to its raw name instead of a dotted path.
 */
function useLabel() {
  const t = useTranslations('resources');
  return {
    t,
    label(path: string, fallback: string): string {
      return tryTranslate(t, path) ?? fallback;
    },
  };
}

/** Self-contained "Uses" / "Used by" lists for one resource (embeddable in service pages). */
export default function ResourceUsagePanel({ uses, usedBy, onOpen, compact }: ResourceUsagePanelProps) {
  const { t } = useLabel();
  return (
    <Stack gap={compact ? 'xs' : 'md'}>
      <Section title={t('usage.uses')} edges={uses ?? []} onOpen={onOpen} compact={compact} />
      <Section title={t('usage.usedBy')} edges={usedBy ?? []} onOpen={onOpen} compact={compact} />
    </Stack>
  );
}

function Section({
  title,
  edges,
  onOpen,
  compact,
}: {
  title: string;
  edges: ResourceEdgeView[];
  onOpen?: (ref: ResourceRefView) => void;
  compact?: boolean;
}) {
  const { t } = useLabel();
  return (
    <div>
      <Text fw={600} size="sm" mb={4}>
        {title} {edges.length > 0 ? <span className="ds-muted">({edges.length})</span> : null}
      </Text>
      {edges.length === 0 ? (
        <Text size="sm" c="dimmed">{t('usage.none')}</Text>
      ) : (
        <Stack gap={compact ? 4 : 8}>
          {edges.map((edge, i) => (
            <EdgeRow key={`${edge.kind}:${edge.field}:${edge.other.type}:${edge.other.id ?? edge.other.key}:${i}`} edge={edge} onOpen={onOpen} />
          ))}
        </Stack>
      )}
    </div>
  );
}

export function edgeKindLabel(t: (k: string) => string, kind: string): string {
  const exact = tryTranslate(t, `edgeKinds.${kind}`);
  if (exact) return exact;
  // evaluation.* / redteam.* / analysis.* / alert.* share one family label.
  return tryTranslate(t, `edgeKinds.${kind.split('.')[0]}`) ?? kind;
}

export function statusHelp(
  t: (k: string) => string,
  status: EdgeStatus,
  severity: EdgeSeverity | null,
): string {
  const specific = severity ? tryTranslate(t, `usage.help.${status}_${severity}`) : undefined;
  return specific ?? t(`usage.help.${status}`);
}

function EdgeRow({ edge, onOpen }: { edge: ResourceEdgeView; onOpen?: (ref: ResourceRefView) => void }) {
  const { t, label } = useLabel();
  const other = edge.other;
  const openable = Boolean(onOpen && other.id);
  const typeLabel = label(`types.${other.type}`, other.type);
  const title = other.name ?? other.key ?? other.id ?? '—';

  return (
    <div
      style={{
        border: '1px solid var(--ds-border, rgba(128,128,128,0.25))',
        borderRadius: 8,
        padding: '8px 10px',
      }}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
        <div style={{ minWidth: 0 }}>
          <Group gap={6} wrap="wrap">
            <span className="ds-badge">{typeLabel}</span>
            {openable ? (
              <button
                type="button"
                onClick={() => onOpen?.(other)}
                style={{
                  background: 'none',
                  border: 0,
                  padding: 0,
                  cursor: 'pointer',
                  color: 'inherit',
                  fontWeight: 500,
                  fontSize: 13.5,
                  textDecoration: 'underline',
                  textUnderlineOffset: 2,
                  ...(other.name ? null : MONO),
                }}
              >
                {title}
              </button>
            ) : (
              <span style={{ fontWeight: 500, fontSize: 13.5, ...(other.name ? null : MONO) }}>{title}</span>
            )}
          </Group>
          <div className="ds-muted" style={{ fontSize: 12, marginTop: 2 }}>
            {edgeKindLabel(t, edge.kind)}
            {other.name && other.key ? <> · <span style={MONO}>{other.key}</span></> : null}
            {edge.status !== 'missing' && other.projectDisplay ? <> · <ProjectCell display={other.projectDisplay} /></> : null}
          </div>
        </div>
        <Tooltip label={statusHelp(t, edge.status, edge.severity)} multiline w={260} withArrow>
          <span className={`ds-badge ${STATUS_CLASS[edge.status]}`} style={{ flexShrink: 0 }}>
            <span className="ds-badge-dot" />
            {t(`usage.status.${edge.status}`)}
          </span>
        </Tooltip>
      </Group>
      {edge.candidates && edge.candidates.length > 0 ? (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          <span className="ds-muted">
            {edge.status === 'cross-project' ? t('usage.foundIn') : t('usage.candidates')}
          </span>
          <Group gap={6} mt={2}>
            {edge.candidates.slice(0, 10).map((c, i) => {
              const text = `${c.name ?? c.key ?? c.id ?? '—'} · ${projectDisplayLabel(t, c.projectDisplay)}`;
              return c.id && onOpen ? (
                <button
                  key={`${c.id}:${i}`}
                  type="button"
                  className="ds-badge"
                  style={{ cursor: 'pointer' }}
                  onClick={() => onOpen(c)}
                >
                  {text}
                </button>
              ) : (
                <span key={`${c.id ?? c.key}:${i}`} className="ds-badge">{text}</span>
              );
            })}
          </Group>
        </div>
      ) : null}
    </div>
  );
}
