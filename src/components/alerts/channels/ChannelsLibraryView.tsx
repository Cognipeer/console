'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBroadcast, IconEdit, IconPlus, IconSend, IconTrash } from '@tabler/icons-react';
import Link from 'next/link';
import { useDeleteResource } from '@/components/common/confirm';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { formatRelative } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { LibraryChannelDto } from '../alertTypes';
import { readApiError } from '../apiError';
import LoadError from '../LoadError';
import LibraryChannelForm from './LibraryChannelForm';
import { libraryDestinationHint, usedByNames } from './libraryUi';
import { useChannelLibrary } from './useChannelLibrary';

const MANAGER_ROLES = new Set(['owner', 'admin']);

/** Workspace-wide notification channels that rules can reference. Everyone with alerts access reads; owners and admins manage. */
export default function ChannelsLibraryView() {
  const t = useTranslations('alerts');
  const locale = useLocale();
  const deleteResource = useDeleteResource();
  const library = useChannelLibrary({ fallbackError: t('libraryUx.loadError') });
  const [canManage, setCanManage] = useState(false);
  const [search, setSearch] = useState('');
  const [formOpened, setFormOpened] = useState(false);
  const [editing, setEditing] = useState<LibraryChannelDto | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  // The server enforces the role; the UI only hides what would be refused.
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((me: { role?: string } | null) => {
        if (!cancelled) setCanManage(MANAGER_ROLES.has(me?.role ?? ''));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return library.channels;
    return library.channels.filter((entry) => [entry.name, entry.kind, libraryDestinationHint(entry)].join(' ').toLowerCase().includes(needle));
  }, [library.channels, search]);

  const openCreate = () => {
    setEditing(null);
    setFormOpened(true);
  };
  const openEdit = (entry: LibraryChannelDto) => {
    setEditing(entry);
    setFormOpened(true);
  };

  const sendTest = async (entry: LibraryChannelDto) => {
    setTesting(entry.id);
    try {
      const res = await fetch(`/api/alerts/channels/library/${entry.id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = (await res.json().catch(() => null)) as { result?: { success?: boolean; error?: string }; message?: string; error?: string } | null;
      if (!res.ok || !data?.result) throw new Error(data?.message ?? data?.error ?? t('channels.testNoDetail'));
      notifications.show(
        data.result.success
          ? { title: t('libraryUx.testSent'), message: t('channels.testOk'), color: 'teal' }
          : { title: t('error'), message: t('channels.testFailed', { error: data.result.error || t('channels.testNoDetail') }), color: 'red' },
      );
    } catch (error) {
      notifications.show({ title: t('error'), message: error instanceof Error ? error.message : t('channels.testNoDetail'), color: 'red' });
    } finally {
      setTesting(null);
    }
  };

  const remove = async (entry: LibraryChannelDto) => {
    const rules = usedByNames(entry);
    if (rules.length > 0) {
      notifications.show({ title: t('libraryUx.inUseTitle'), message: t('libraryUx.inUse', { rules: rules.slice(0, 5).join(', ') }), color: 'orange' });
      return;
    }
    const done = await deleteResource({
      noun: t('libraryUx.noun'),
      name: entry.name,
      action: async () => {
        const res = await fetch(`/api/alerts/channels/library/${entry.id}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { code?: string; rules?: Array<{ name: string }> } | null;
          if (data?.code === 'channel_in_use') {
            throw new Error(t('libraryUx.inUse', { rules: (data.rules ?? []).map((rule) => rule.name).slice(0, 5).join(', ') }));
          }
          throw new Error(await readApiError(res, t('libraryUx.deleteFailed')));
        }
      },
    });
    if (!done) return;
    notifications.show({ title: t('libraryUx.deleted'), message: t('libraryUx.deletedMessage', { name: entry.name }), color: 'teal' });
    library.reload();
  };

  const columns: DataGridColumn<LibraryChannelDto>[] = [
    {
      key: 'name',
      label: t('libraryUx.columnName'),
      render: (entry) => (
        <Text size="sm" fw={600} lineClamp={1}>
          {entry.name}
        </Text>
      ),
    },
    {
      key: 'kind',
      label: t('libraryUx.columnKind'),
      render: (entry) => (
        <Badge size="xs" variant="light">
          {t(`channelTypes.${entry.kind}`)}
        </Badge>
      ),
    },
    {
      key: 'destination',
      label: t('libraryUx.columnDestination'),
      render: (entry) => (
        <Text size="xs" className="ds-mono" lineClamp={1}>
          {libraryDestinationHint(entry) || '—'}
        </Text>
      ),
    },
    {
      key: 'usedBy',
      label: t('libraryUx.columnUsedBy'),
      render: (entry) => {
        const names = usedByNames(entry);
        if (names.length === 0) {
          return (
            <Text size="xs" c="dimmed">
              {t('libraryUx.unused')}
            </Text>
          );
        }
        return (
          <Text size="xs" title={names.join(', ')}>
            {t('libraryUx.usedByCount', { count: names.length })}
          </Text>
        );
      },
    },
    {
      key: 'updated',
      label: t('libraryUx.columnUpdated'),
      render: (entry) => (
        <Text size="xs" c="dimmed">
          {entry.updatedAt ? formatRelative(entry.updatedAt, locale) : '—'}
        </Text>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('libraryUx.title')}
        subtitle={t('libraryUx.subtitle')}
        actions={
          <>
            <Button component={Link} href="/dashboard/alerts" variant="default" size="sm">
              {t('libraryUx.backToRules')}
            </Button>
            {canManage ? (
              <Button color="teal" size="sm" leftSection={<IconPlus size={14} stroke={1.7} />} onClick={openCreate}>
                {t('libraryUx.newChannel')}
              </Button>
            ) : null}
          </>
        }
      />
      {library.error && library.channels.length === 0 ? (
        <LoadError message={library.error} onRetry={library.reload} />
      ) : (
        <DataGrid<LibraryChannelDto>
          records={filtered}
          rowKey={(entry) => entry.id}
          columns={columns}
          loading={library.loading && library.channels.length === 0}
          refreshing={library.loading}
          onRefresh={library.reload}
          onRowClick={canManage ? openEdit : undefined}
          search={{ value: search, onChange: setSearch, placeholder: t('libraryUx.searchPlaceholder') }}
          rowActions={
            canManage
              ? (entry) => [
                  { id: 'edit', label: t('edit'), icon: <IconEdit size={14} />, onClick: openEdit },
                  { id: 'test', label: t('libraryUx.sendTest'), icon: <IconSend size={14} />, disabled: testing === entry.id, onClick: () => void sendTest(entry) },
                  { id: 'divider', divider: true },
                  { id: 'delete', label: t('delete'), icon: <IconTrash size={14} />, color: 'red', onClick: () => void remove(entry) },
                ]
              : undefined
          }
          empty={{
            icon: <IconBroadcast size={28} />,
            title: library.channels.length === 0 ? t('libraryUx.empty') : t('libraryUx.noMatch'),
            description: library.channels.length === 0 ? (canManage ? t('libraryUx.emptyDescription') : t('libraryUx.emptyReadOnly')) : undefined,
            primaryAction: library.channels.length === 0 && canManage ? { label: t('libraryUx.newChannel'), icon: <IconPlus size={14} />, onClick: openCreate } : undefined,
          }}
          footerLeft={canManage ? undefined : t('libraryUx.readOnlyNote')}
        />
      )}
      <LibraryChannelForm opened={formOpened} onClose={() => setFormOpened(false)} onSaved={library.reload} entry={editing} />
    </PageContainer>
  );
}
