'use client';

import Link from 'next/link';
import { Text } from '@mantine/core';
import { DetailCard } from '@/components/common/ui/DetailShell';
import { formatDateTime } from '@/components/iam/timeFormat';
import { entityHref, entityTypeLabel } from '../alertCatalog';
import { useLocale, useTranslations } from '@/lib/i18n';
import { investigateWindow, modelLogsHref, sessionsHref } from './investigateLinks';
import type { IncidentDto } from '../alertTypes';

const MAX_ENTITIES = 6;

interface Props {
  incident: IncidentDto;
  entity: { type: string | null; key: string } | null;
  windowMinutes?: number;
  entityLinks: Record<string, string | null>;
}

/** Quick access from an incident to the agent sessions and model logs of the period it covers. */
export default function InvestigateCard({ incident, entity, windowMinutes, entityLinks }: Props) {
  const t = useTranslations('incidents');
  const ta = useTranslations('alerts');
  const locale = useLocale();
  const window = investigateWindow(incident, windowMinutes);
  if (!window) return null;

  // The incident's own entity first, then the related ones the system found changing alongside it.
  const targets: Array<{ type: string; key: string }> = [];
  const add = (type: string | null | undefined, key: string | null | undefined) => {
    if (!type || !key || (type !== 'agent' && type !== 'model')) return;
    if (targets.some((entry) => entry.type === type && entry.key === key)) return;
    targets.push({ type, key });
  };
  add(entity?.type, entity?.key);
  for (const entry of incident.context?.correlations ?? []) add(entry.entityType, entry.entityKey);

  const rows = targets.slice(0, MAX_ENTITIES).map((target) => {
    if (target.type === 'agent') {
      return {
        id: `agent:${target.key}`,
        label: target.key,
        type: entityTypeLabel('agent', ta),
        links: [
          { id: 'sessions', label: t('quickAccess.sessions'), href: sessionsHref(window, { agent: target.key }) },
          { id: 'failed', label: t('quickAccess.failedSessions'), href: sessionsHref(window, { agent: target.key, failedOnly: true }) },
        ],
      };
    }
    const modelPath = entityHref('model', target.key, entityLinks);
    return {
      id: `model:${target.key}`,
      label: target.key,
      type: entityTypeLabel('model', ta),
      links: modelPath ? [{ id: 'logs', label: t('quickAccess.modelLogs'), href: modelLogsHref(modelPath, window) }] : [],
    };
  });

  return (
    <DetailCard title={t('quickAccess.title')} description={t('quickAccess.period', { from: formatDateTime(window.from.toISOString(), locale), to: formatDateTime(window.to.toISOString(), locale) })}>
      <div className="ds-stack ds-gap-sm" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((row) => (
          <div key={row.id}>
            <div style={{ fontSize: 12.5, wordBreak: 'break-word' }}>
              <span className="ds-mono">{row.label}</span> <span className="ds-faint">· {row.type}</span>
            </div>
            <div className="ds-row ds-gap-sm" style={{ flexWrap: 'wrap', marginTop: 2 }}>
              {row.links.length > 0 ? (
                row.links.map((link) => (
                  <Link key={link.id} href={link.href}>
                    {link.label}
                  </Link>
                ))
              ) : (
                <Text size="xs" c="dimmed">
                  {t('quickAccess.noLink')}
                </Text>
              )}
            </div>
          </div>
        ))}
        <div className="ds-row ds-gap-sm" style={{ flexWrap: 'wrap' }}>
          <Link href={sessionsHref(window)}>{t('quickAccess.allSessions')}</Link>
          <Link href={sessionsHref(window, { failedOnly: true })}>{t('quickAccess.allFailedSessions')}</Link>
        </div>
      </div>
    </DetailCard>
  );
}
