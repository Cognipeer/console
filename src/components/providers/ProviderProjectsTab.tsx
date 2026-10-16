'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Center, Loader, Switch } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle } from '@tabler/icons-react';
import { DetailCard } from '@/components/common/ui/DetailShell';
import ConfirmModal from '@/components/common/ui/ConfirmModal';
import { useTranslations } from '@/lib/i18n';
import { unassignImpact, type ProviderUsageEntry } from './providerAccessModel';

/** `GET /api/providers/:id/usage`: every tenant project, with what uses the provider in it. */
export function useProviderUsage(providerId: string | undefined) {
  const [entries, setEntries] = useState<ProviderUsageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!providerId) return;
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/usage`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to load usage');
      }
      const data = (await res.json()) as { projects?: ProviderUsageEntry[] };
      setEntries(data.projects ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage');
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { entries, loading, error, reload };
}

export interface ProviderProjectsTabProps {
  providerId: string;
  providerName: string;
  entries: ProviderUsageEntry[];
  loading: boolean;
  error: string | null;
  /** Owners and admins only (the assignment PATCH is admin-gated). */
  canEdit: boolean;
  /** Reload usage and the provider after a change. */
  onChanged: () => void | Promise<void>;
}

/** All tenant projects with an "assigned" toggle; unassigning first shows what would stop working. */
export default function ProviderProjectsTab({
  providerId,
  providerName,
  entries,
  loading,
  error,
  canEdit,
  onChanged,
}: ProviderProjectsTabProps) {
  const t = useTranslations('providerAccess.detail');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<ProviderUsageEntry | null>(null);

  const sorted = useMemo(
    () => [...entries].sort((a, b) => a.name.localeCompare(b.name)),
    [entries],
  );

  const write = async (projectId: string, assign: boolean) => {
    const ids = entries
      .filter((e) => (e.projectId === projectId ? assign : e.assigned))
      .map((e) => e.projectId);
    setBusyId(projectId);
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}?scope=tenant`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectIds: ids }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || t('updateFailed'));
      }
      await onChanged();
    } catch (e) {
      notifications.show({
        color: 'red',
        title: t('updateFailed'),
        message: e instanceof Error ? e.message : t('updateFailed'),
      });
    } finally {
      setBusyId(null);
    }
  };

  const toggle = (entry: ProviderUsageEntry, next: boolean) => {
    if (next) {
      void write(entry.projectId, true);
      return;
    }
    setPendingRemoval(entry);
  };

  const impact = pendingRemoval ? unassignImpact(pendingRemoval) : null;

  return (
    <DetailCard title={t('projectsTitle')} description={t('projectsDescription')}>
      {!canEdit ? (
        <div className="ds-muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
          {t('readOnly')}
        </div>
      ) : null}
      {loading ? (
        <Center py="md">
          <Loader size="sm" color="teal" />
        </Center>
      ) : error ? (
        <Alert icon={<IconAlertCircle size={16} />} color="red" title={t('projectsLoadFailed')}>
          {error}
        </Alert>
      ) : (
        sorted.map((entry) => {
          const inUse = entry.models.length > 0 || entry.agents.length > 0;
          return (
            <div
              key={entry.projectId}
              className="ds-row-between"
              style={{ padding: '10px 0', borderBottom: '1px solid var(--ds-border)', gap: 12 }}
            >
              <div className="ds-col" style={{ gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{entry.name}</span>
                {entry.assigned ? (
                  <span className="ds-faint" style={{ fontSize: 12 }}>
                    {inUse
                      ? [
                          t('models', { count: entry.models.length }),
                          t('agents', { count: entry.agents.length }),
                          entry.requests7d ? t('requests7d', { count: entry.requests7d }) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : t('notUsed')}
                  </span>
                ) : null}
              </div>
              <Switch
                color="teal"
                checked={entry.assigned}
                disabled={!canEdit || busyId !== null}
                onChange={(e) => toggle(entry, e.currentTarget.checked)}
                aria-label={t('assignedToggle', { name: entry.name })}
              />
            </div>
          );
        })
      )}

      <ConfirmModal
        opened={pendingRemoval !== null}
        title={t('unassignTitle', { name: pendingRemoval?.name ?? '' })}
        message={
          impact && pendingRemoval ? (
            impact.hasImpact ? (
              <>
                {t('unassignMessage', { provider: providerName, name: pendingRemoval.name })}
                {impact.models.length > 0 ? (
                  <ImpactList title={t('impactModels')} items={impact.models.map((m) => m.name)} />
                ) : null}
                {impact.agents.length > 0 ? (
                  <ImpactList title={t('impactAgents')} items={impact.agents.map((a) => a.name)} />
                ) : null}
              </>
            ) : (
              t('unassignNoImpact', { provider: providerName, name: pendingRemoval.name })
            )
          ) : null
        }
        confirmLabel={t('unassignConfirm')}
        cancelLabel={t('unassignCancel')}
        loading={busyId !== null}
        onClose={() => setPendingRemoval(null)}
        onConfirm={() => {
          const target = pendingRemoval;
          if (!target) return;
          void write(target.projectId, false).then(() => setPendingRemoval(null));
        }}
      />
    </DetailCard>
  );
}

function ImpactList({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 12.5 }}>{title}</div>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {items.slice(0, 8).map((name, i) => (
          <li key={`${name}-${i}`}>{name}</li>
        ))}
        {items.length > 8 ? <li>+{items.length - 8}</li> : null}
      </ul>
    </div>
  );
}
