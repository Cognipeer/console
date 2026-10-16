'use client';

import Link from 'next/link';
import { ActionIcon, Button, Text } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconEye } from '@tabler/icons-react';
import { formatRelative } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';
import { entityHref, entityOf, formatDurationBetween } from '../alertCatalog';
import type { IncidentDto } from '../alertTypes';
import { isSnoozed, severityBadgeClass, statusBadgeClass } from '../incidentUi';
import type { IncidentGroupModel, InboxGroup } from './inboxModel';

interface Props {
  groups: IncidentGroupModel[];
  by: Exclude<InboxGroup, 'none'>;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onSelectGroup: (ids: string[], on: boolean) => void;
  previewId: string | null;
  onPreview: (incident: IncidentDto) => void;
  /** The heading of a group (rule name, entity key). */
  groupLabel: (group: IncidentGroupModel) => string;
  links: Record<string, string | null>;
}

/** The loaded page grouped by rule or entity: a header per group and compact selectable rows under it. */
export default function IncidentGroups({ groups, by, collapsed, onToggle, selected, onToggleSelect, onSelectGroup, previewId, onPreview, groupLabel, links }: Props) {
  const t = useTranslations('incidents');
  const locale = useLocale();

  return (
    <div className="ds-col ds-gap-md">
      {groups.map((group) => {
        const open = !collapsed.has(group.key);
        const ids = group.incidents.map((incident) => incident._id);
        const allSelected = ids.every((id) => selected.has(id));
        const headingId = `inbox-group-${group.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        return (
          <section key={group.key} className="ds-card" aria-labelledby={headingId}>
            <div className="ds-row-between" style={{ padding: '10px 14px', gap: 8 }}>
              <div className="ds-row" style={{ gap: 8, minWidth: 0 }}>
                <input
                  type="checkbox"
                  className="ds-checkbox"
                  aria-label={t('ux.groups.selectGroup', { name: groupLabel(group) })}
                  checked={allSelected}
                  onChange={() => onSelectGroup(ids, !allSelected)}
                />
                <Button
                  variant="subtle"
                  size="compact-sm"
                  color="gray"
                  aria-expanded={open}
                  leftSection={open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                  onClick={() => onToggle(group.key)}
                >
                  <span id={headingId} style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                    {groupLabel(group)}
                  </span>
                </Button>
              </div>
              <div className="ds-row" style={{ gap: 8, flexShrink: 0 }}>
                <span className={severityBadgeClass(group.worstSeverity)}>{t(`severity.${group.worstSeverity}`)}</span>
                <span className="ds-badge">{t('ux.groups.count', { count: group.incidents.length })}</span>
                {by === 'rule' ? <span className="ds-faint" style={{ fontSize: 12 }}>{t('ux.groups.entities', { count: group.entityCount })}</span> : null}
                <span className="ds-faint" style={{ fontSize: 12 }}>{formatRelative(group.latestFiredAt, locale)}</span>
              </div>
            </div>
            {open ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--ds-border-soft)' }}>
                {group.incidents.map((incident) => {
                  const entity = entityOf(incident);
                  const href = entity?.type ? entityHref(entity.type, entity.key, links) : null;
                  const isSel = selected.has(incident._id);
                  return (
                    <li
                      key={incident._id}
                      data-row-container
                      className="ds-row"
                      style={{ gap: 10, padding: '8px 14px', background: previewId === incident._id ? 'var(--ds-accent-soft)' : isSel ? 'var(--ds-hover)' : undefined }}
                    >
                      <input
                        type="checkbox"
                        className="ds-checkbox"
                        aria-label={t('ux.groups.selectRow', { name: incident.ruleName })}
                        checked={isSel}
                        onChange={() => onToggleSelect(incident._id)}
                      />
                      <span className={severityBadgeClass(incident.severity)}>{t(`severity.${incident.severity}`)}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <Link href={`/dashboard/alerts/incidents/${incident._id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                          <Text size="sm" fw={600} lineClamp={1} data-incident-row={incident._id}>
                            {by === 'rule' ? (entity?.key ?? incident.ruleName) : incident.ruleName}
                          </Text>
                        </Link>
                        {by === 'rule' && entity?.key && href ? (
                          <Link href={href} className="ds-faint" style={{ fontSize: 11.5 }}>
                            {t('openEntityHealth')}
                          </Link>
                        ) : null}
                      </div>
                      <span className={statusBadgeClass(incident.status)}>{t(`status.${incident.status}`)}</span>
                      {isSnoozed(incident) ? <span className="ds-badge">{t('ux.snooze.badge')}</span> : null}
                      <span className="ds-faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {formatRelative(incident.firedAt, locale)} · {formatDurationBetween(incident.firedAt, incident.resolvedAt ?? incident.closedAt ?? null)}
                      </span>
                      <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t('ux.groups.preview', { name: incident.ruleName })} onClick={() => onPreview(incident)}>
                        <IconEye size={14} />
                      </ActionIcon>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
