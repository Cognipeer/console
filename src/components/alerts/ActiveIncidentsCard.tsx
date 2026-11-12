'use client';

import Link from 'next/link';
import { Button, Text } from '@mantine/core';
import { IconChevronRight, IconShieldCheck } from '@tabler/icons-react';
import { CardSkeleton } from '@/components/common/ui/Skeletons';
import { formatRelative } from '@/components/iam/timeFormat';
import { isApiError } from '@/lib/api/client';
import { useIncidentList } from '@/lib/api/queries/alertIncidents';
import { useLocale, useTranslations } from '@/lib/i18n';
import LoadError from './LoadError';
import { apiErrorMessage } from './apiError';
import { entityOf, metricLabel } from './alertCatalog';
import { describeRowValue, severityBadgeClass } from './incidentUi';
import { useAlertMeta } from './useAlertMeta';

export interface ActiveIncidentsCardProps {
  /** How many incidents to list (default 5). */
  limit?: number;
  /** Tighter rows without the metric line. */
  compact?: boolean;
  /**
   * Nothing at all unless an incident is open: no placeholder while loading, no error and no "all clear" line (the
   * home page's needs-attention row, which is there only when something needs attention).
   */
  hideWhenEmpty?: boolean;
}

/**
 * The project's open incidents, newest first, with a link to the full list. Fetches
 * its own data (`GET /alerts/incidents?status=open`). A viewer without access to the
 * alerts service sees nothing at all, so the card can sit on any overview page.
 */
export default function ActiveIncidentsCard({ limit = 5, compact = false, hideWhenEmpty = false }: ActiveIncidentsCardProps) {
  const t = useTranslations('alerts');
  const locale = useLocale();
  const { catalog } = useAlertMeta();
  const query = useIncidentList(`status=open&limit=${limit}`);
  // A viewer without access to the alerts service sees nothing at all.
  const hidden = isApiError(query.error) && [401, 403, 404].includes(query.error.status);
  const incidents = query.data?.incidents ?? [];
  const openCount = query.data ? query.data.openCount ?? incidents.length : 0;
  const loading = query.isPending;
  const error = query.isError && !hidden ? apiErrorMessage(query.error, t('activeIncidents.loadError')) : null;

  if (hidden) return null;
  if (hideWhenEmpty && (error || incidents.length === 0)) return null;
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
        <LoadError bare message={error} onRetry={() => void query.refetch()} />
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
