'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Text } from '@mantine/core';
import { IconChevronRight, IconShieldCheck } from '@tabler/icons-react';
import { CardSkeleton } from '@/components/common/ui/Skeletons';
import { formatRelative } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';
import LoadError from './LoadError';
import { isAbortError, readApiError } from './apiError';
import { entityOf, metricLabel } from './alertCatalog';
import type { IncidentDto } from './alertTypes';
import { describeRowValue, severityBadgeClass } from './incidentUi';
import { useAlertMeta } from './useAlertMeta';

export interface ActiveIncidentsCardProps {
  /** How many incidents to list (default 5). */
  limit?: number;
  /** Tighter rows without the metric line. */
  compact?: boolean;
}

/**
 * The project's open incidents, newest first, with a link to the full list. Fetches
 * its own data (`GET /alerts/incidents?status=open`). A viewer without access to the
 * alerts service sees nothing at all, so the card can sit on any overview page.
 */
export default function ActiveIncidentsCard({ limit = 5, compact = false }: ActiveIncidentsCardProps) {
  const t = useTranslations('alerts');
  const locale = useLocale();
  const { catalog } = useAlertMeta();
  const [incidents, setIncidents] = useState<IncidentDto[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const res = await fetch(`/api/alerts/incidents?status=open&limit=${limit}`, { signal: controller.signal });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        setHidden(true);
        return;
      }
      if (!res.ok) throw new Error(await readApiError(res, t('activeIncidents.loadError')));
      const data = (await res.json()) as { incidents?: IncidentDto[]; openCount?: number };
      setIncidents(data.incidents ?? []);
      setOpenCount(data.openCount ?? data.incidents?.length ?? 0);
      setError(null);
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : t('activeIncidents.loadError'));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [limit, t]);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  if (hidden) return null;
  if (loading && incidents.length === 0 && !error) return <CardSkeleton lines={compact ? 2 : 3} />;

  return (
    <div className={`ds-card ${compact ? 'ds-card-pad' : 'ds-card-pad-lg'}`} data-testid="active-incidents-card">
      <div className="ds-row-between" style={{ marginBottom: 12 }}>
        <div className="ds-row" style={{ gap: 8 }}>
          <div className="ds-h3">{t('activeIncidents.title')}</div>
          {openCount > 0 ? <span className="ds-badge ds-badge-err">{openCount}</span> : null}
        </div>
        <Button component={Link} href="/dashboard/alerts/incidents" variant="subtle" size="xs" rightSection={<IconChevronRight size={12} />}>
          {t('activeIncidents.viewAll')}
        </Button>
      </div>

      {error ? (
        <LoadError bare message={error} onRetry={() => void load()} />
      ) : incidents.length === 0 ? (
        <div className="ds-row" style={{ gap: 8 }}>
          <IconShieldCheck size={16} stroke={1.7} color="var(--ds-ok)" />
          <Text size="sm" c="dimmed">
            {t('activeIncidents.empty')}
          </Text>
        </div>
      ) : (
        <div className="ds-col" style={{ gap: compact ? 4 : 8 }}>
          {incidents.map((incident) => {
            const entity = entityOf(incident);
            const valueText = describeRowValue(incident, catalog, t, locale).value;
            return (
              <Link
                key={incident._id}
                href={`/dashboard/alerts/incidents/${incident._id}`}
                className="ds-link-row"
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: compact ? '4px 0' : '8px 10px', textDecoration: 'none', color: 'inherit', borderRadius: 8 }}
              >
                <span className={severityBadgeClass(incident.severity)}>{t(`severity.${incident.severity}`)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={500} lineClamp={1}>
                    {incident.ruleName}
                    {entity ? <span className="ds-mono ds-muted"> · {entity.key}</span> : null}
                  </Text>
                  {compact ? null : (
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {metricLabel(catalog, incident.metric, t)} · {valueText}
                    </Text>
                  )}
                </div>
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  {formatRelative(incident.firedAt, locale)}
                </Text>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
