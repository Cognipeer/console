'use client';

/**
 * The Document Store's front page: the buckets of the project with what they hold and how their provider is
 * doing, filterable by name, provider and status (the filters live in the address, so a view can be shared).
 *
 * The numbers of the tiles come from the buckets themselves (each carries its file count and size), so nothing
 * here asks for a dashboard or filters by date. A list that could not be loaded says so with a way to try again; it
 * is never drawn as an empty list, which would read as "you have no buckets".
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, Button, VisuallyHidden } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconBan,
  IconBook,
  IconCheck,
  IconCloudOff,
  IconFiles,
  IconFolder,
  IconPlus,
  IconSearchOff,
} from '@tabler/icons-react';
import { useNavigationFeedback } from '@/components/common/navigation/useNavigationFeedback';
import DataGrid, { type DataGridColumn, type DataGridFilter } from '@/components/common/ui/DataGrid';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { StatGridSkeleton } from '@/components/common/ui/Skeletons';
import StatTile from '@/components/common/ui/StatTile';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import { useLocale, useTranslations } from '@/lib/i18n';
import { CreateFileBucketForm } from '../create/CreateFileBucketForm';
import { isFilesApiError, type BucketListItem } from '../filesApi';
import { bucketRefusalMessage } from '../bucket/fileBrowse';
import {
  BucketStatusBadge,
  ReadOnlyHint,
  RelativeTime,
  filesErrorMessage,
  formatBytes,
  formatCount,
} from '../shared';
import { useBuckets, useUpdateBucket } from '../useFilesQueries';
import { useFilesAccess } from '../useFilesAccess';
import BucketProviderCell from './BucketProviderCell';
import BucketRowActions from './BucketRowActions';
import ListStateCard from './ListStateCard';
import NoBucketsState from './NoBucketsState';
import {
  FILES_DOCS_URL,
  bucketHref,
  bucketProviderOptions,
  filterBuckets,
  summarizeBuckets,
  type BucketStatusFilter,
} from './bucketListModel';
import { canManageProviders } from './providerModel';
import { useBucketListFilters } from './useBucketListFilters';

export default function BucketListPage() {
  const t = useTranslations('files.list');
  const tCommon = useTranslations('files.common');
  const tBucket = useTranslations('files.bucket');
  const locale = useLocale();
  const { push: navigate } = useNavigationFeedback();
  const { canWrite } = useFilesAccess();
  const role = useDashboardUser()?.role;
  const manageProviders = canManageProviders(role);

  const bucketsQuery = useBuckets();
  const updateBucket = useUpdateBucket();
  const { filters, setQuery, setProvider, setStatus, clear } = useBucketListFilters();
  const [createOpen, setCreateOpen] = useState(false);

  const buckets = useMemo(() => bucketsQuery.data ?? [], [bucketsQuery.data]);
  const visible = useMemo(() => filterBuckets(buckets, filters), [buckets, filters]);
  const summary = useMemo(() => summarizeBuckets(buckets), [buckets]);
  const providerOptions = useMemo(() => bucketProviderOptions(buckets), [buckets]);

  const busyKey = updateBucket.isPending ? updateBucket.variables?.bucketKey : undefined;

  const toggleStatus = (bucket: BucketListItem) => {
    const next = bucket.status === 'disabled' ? 'active' : 'disabled';
    updateBucket.mutate(
      { bucketKey: bucket.key, patch: { status: next } },
      {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            title: next === 'active' ? t('toggle.enabledTitle') : t('toggle.disabledTitle'),
            message:
              next === 'active'
                ? t('toggle.enabledMessage', { name: bucket.name })
                : t('toggle.disabledMessage', { name: bucket.name }),
          });
        },
        onError: (error) => {
          notifications.show({
            color: 'red',
            title: tBucket('refusalTitleUpdate'),
            // A bucket an agent keeps its files in is refused with the agents named.
            message: error.code === 'bucket_in_use' ? bucketRefusalMessage(error) : filesErrorMessage(error, tCommon),
            autoClose: 12000,
          });
        },
      },
    );
  };

  /** What went wrong with the list, in a sentence the person can act on. */
  const loadErrorText = (error: unknown): string => {
    if (isFilesApiError(error) && error.status > 0 && error.status !== 403) {
      return t('error.status', { status: error.status });
    }
    return filesErrorMessage(error, tCommon);
  };

  const columns: DataGridColumn<BucketListItem>[] = [
    {
      key: 'name',
      label: t('columns.bucket'),
      render: (bucket) => (
        <div className="ds-col" style={{ gap: 2, minWidth: 0 }}>
          {/* A real link: Cmd/Ctrl-click and middle-click open the bucket in a new tab. */}
          <Link
            href={bucketHref(bucket.key)}
            prefetch={false}
            style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)', overflowWrap: 'anywhere' }}
          >
            {bucket.name}
          </Link>
          <span className="ds-faint ds-mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
            {bucket.key}
          </span>
        </div>
      ),
    },
    {
      key: 'provider',
      label: t('columns.provider'),
      render: (bucket) => <BucketProviderCell bucket={bucket} canManageProviders={manageProviders} />,
    },
    {
      key: 'files',
      label: t('columns.files'),
      align: 'right',
      render: (bucket) => <span className="ds-mono">{formatCount(bucket.stats?.fileCount, locale)}</span>,
    },
    {
      key: 'size',
      label: t('columns.size'),
      align: 'right',
      render: (bucket) => <span className="ds-mono">{formatBytes(bucket.stats?.totalBytes)}</span>,
    },
    {
      key: 'status',
      label: t('columns.status'),
      render: (bucket) => <BucketStatusBadge status={bucket.status} deleting={bucket.deleting} />,
    },
    {
      key: 'updated',
      label: t('columns.updated'),
      render: (bucket) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          <RelativeTime value={bucket.updatedAt ?? bucket.createdAt} />
        </span>
      ),
    },
    {
      key: 'actions',
      label: <VisuallyHidden>{t('columns.actions')}</VisuallyHidden>,
      align: 'right',
      width: 56,
      render: (bucket) => (
        <BucketRowActions
          bucket={bucket}
          canWrite={canWrite}
          busy={busyKey === bucket.key}
          onNavigate={navigate}
          onToggleStatus={toggleStatus}
        />
      ),
    },
  ];

  // A provider in the address that none of the buckets is on any more still shows in the select, as what it is.
  const providerChoices = [
    { value: '', label: t('filters.allProviders') },
    ...providerOptions,
    ...(filters.provider && !providerOptions.some((option) => option.value === filters.provider)
      ? [{ value: filters.provider, label: filters.provider }]
      : []),
  ];

  const gridFilters: DataGridFilter[] = [
    {
      value: filters.provider,
      onChange: setProvider,
      ariaLabel: t('filters.providerLabel'),
      width: 180,
      options: providerChoices,
    },
    {
      value: filters.status,
      onChange: (value) => setStatus(value as BucketStatusFilter),
      ariaLabel: t('filters.statusLabel'),
      width: 150,
      options: [
        { value: 'all', label: t('filters.anyStatus') },
        { value: 'active', label: tCommon('bucketStatus.active') },
        { value: 'disabled', label: tCommon('bucketStatus.disabled') },
      ],
    },
  ];

  const loadFailed = bucketsQuery.isError && bucketsQuery.data === undefined;
  const refreshFailed = bucketsQuery.isError && bucketsQuery.data !== undefined;

  const actions = (
    <>
      <Button
        component="a"
        href={FILES_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        variant="default"
        size="sm"
        leftSection={<IconBook size={14} stroke={1.7} />}
      >
        {t('actions.docs')}
      </Button>
      {canWrite ? (
        <Button color="teal" size="sm" leftSection={<IconPlus size={14} stroke={1.7} />} onClick={() => setCreateOpen(true)}>
          {t('actions.create')}
        </Button>
      ) : null}
    </>
  );

  let content;
  if (bucketsQuery.isPending) {
    content = (
      <>
        <StatGridSkeleton count={4} delta style={{ marginBottom: 16 }} />
        <DataGrid<BucketListItem>
          records={[]}
          loading
          rowKey={(bucket) => bucket.key}
          columns={columns}
          search={{ value: filters.q, onChange: setQuery, placeholder: t('filters.search') }}
          filters={gridFilters}
        />
      </>
    );
  } else if (loadFailed) {
    content = (
      <ListStateCard
        tone="error"
        icon={<IconCloudOff size={26} stroke={1.7} />}
        title={t('error.title')}
        description={loadErrorText(bucketsQuery.error)}
      >
        <Button variant="default" size="sm" loading={bucketsQuery.isFetching} onClick={() => void bucketsQuery.refetch()}>
          {t('error.retry')}
        </Button>
      </ListStateCard>
    );
  } else if (buckets.length === 0) {
    content = (
      <NoBucketsState canWrite={canWrite} canManageProviders={manageProviders} onCreate={() => setCreateOpen(true)} />
    );
  } else {
    content = (
      <>
        <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
          <StatTile
            label={t('tiles.buckets')}
            icon={<IconFolder size={14} stroke={1.7} />}
            value={formatCount(summary.buckets, locale)}
          />
          <StatTile
            label={t('tiles.active')}
            icon={<IconCheck size={14} stroke={1.7} />}
            value={formatCount(summary.active, locale)}
          />
          <StatTile
            label={t('tiles.disabled')}
            icon={<IconBan size={14} stroke={1.7} />}
            value={formatCount(summary.disabled, locale)}
          />
          <StatTile
            label={t('tiles.files')}
            icon={<IconFiles size={14} stroke={1.7} />}
            value={formatCount(summary.files, locale)}
            delta={t('tiles.filesSize', { size: formatBytes(summary.bytes) })}
          />
        </div>
        <DataGrid<BucketListItem>
          records={visible}
          rowKey={(bucket) => bucket.key}
          rowHref={(bucket) => bucketHref(bucket.key)}
          columns={columns}
          search={{ value: filters.q, onChange: setQuery, placeholder: t('filters.search') }}
          filters={gridFilters}
          onRefresh={() => void bucketsQuery.refetch()}
          refreshing={bucketsQuery.isRefetching}
          empty={{
            icon: <IconSearchOff size={26} stroke={1.7} />,
            title: t('empty.filteredTitle'),
            description: t('empty.filteredDescription'),
            extra: (
              <Button variant="default" size="sm" mt="sm" onClick={clear}>
                {t('filters.clear')}
              </Button>
            ),
          }}
          footerLeft={t('footer', { shown: formatCount(visible.length, locale), total: formatCount(buckets.length, locale) })}
        />
      </>
    );
  }

  return (
    <PageContainer>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} subtitle={t('subtitle')} actions={actions} />

      {!canWrite ? (
        <div style={{ marginBottom: 16 }}>
          <ReadOnlyHint variant="banner" />
        </div>
      ) : null}

      {refreshFailed ? (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          title={t('error.refreshTitle')}
          mb="md"
        >
          <div className="ds-row ds-gap-sm" style={{ flexWrap: 'wrap' }}>
            <span>{loadErrorText(bucketsQuery.error)} {t('error.staleNote')}</span>
            <Button variant="default" size="compact-sm" loading={bucketsQuery.isFetching} onClick={() => void bucketsQuery.refetch()}>
              {t('error.retry')}
            </Button>
          </div>
        </Alert>
      ) : null}

      {content}

      <CreateFileBucketForm
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(bucket) => {
          setCreateOpen(false);
          navigate(bucketHref(bucket.key));
        }}
      />
    </PageContainer>
  );
}
