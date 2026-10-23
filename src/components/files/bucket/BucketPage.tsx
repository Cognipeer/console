'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ActionIcon, Alert, Button, Group, Loader, Menu } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBan,
  IconBucket,
  IconCheck,
  IconCloudDownload,
  IconDots,
  IconFolderOff,
  IconRefresh,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import DetailShell, { type DetailShellTab } from '@/components/common/ui/DetailShell';
import PageContainer from '@/components/common/ui/PageContainer';
import { DetailSkeleton } from '@/components/common/ui/Skeletons';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import { useLocale, useTranslations } from '@/lib/i18n';
import { FileDetailDrawer } from '../detail/FileDetailDrawer';
import { UploadFilesForm } from '../upload/UploadFilesForm';
import {
  BucketStatusBadge,
  filesErrorMessage,
  formatBytes,
  formatCount,
  ProviderHealthChip,
  providerHref,
  ReadOnlyHint,
  useNow,
} from '../shared';
import { useFilesAccess } from '../useFilesAccess';
import { useBucket, useFilesInvalidation, useUpdateBucket } from '../useFilesQueries';
import { BucketApiTab } from './BucketApiTab';
import { BucketFilesTab } from './BucketFilesTab';
import { BucketSettingsTab } from './BucketSettingsTab';
import DeleteBucketDialog from './DeleteBucketDialog';
import ImportFromStorageDialog from './ImportFromStorageDialog';
import StateCard from './StateCard';
import styles from './bucket.module.css';
import { bucketErrorMessage, isBucketGone } from './bucketErrors';
import {
  hrefWithQuery,
  parseFilesTabState,
  readOpenFile,
  resolveBucketTab,
  withFilesTabState,
  type BucketTab,
} from './filesTabState';
import { deleteRules, driverNameOf, mayOpenProviders } from './settingsModel';

/** The bucket list. */
const LIST_HREF = '/dashboard/files';

export interface BucketPageProps {
  bucketKey: string;
}

/**
 * The bucket page: a header with the bucket's name, status, provider health and size, the actions (Upload, Refresh
 * and a menu), the Files / Settings / API tabs (`?tab=`, Files by default), and the notices that explain why a
 * bucket cannot be changed. The file drawer, the upload screen and the import dialog are hosted here so every tab
 * and the header can open them.
 */
export default function BucketPage({ bucketKey }: BucketPageProps) {
  const t = useTranslations('files.bucket');
  const tc = useTranslations('files.common');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const paramsText = searchParams?.toString() ?? '';
  const user = useDashboardUser();
  const { canWrite } = useFilesAccess();
  const invalidation = useFilesInvalidation();
  const updateBucket = useUpdateBucket();

  const bucketQuery = useBucket(bucketKey);
  const bucket = bucketQuery.data;
  const gone = isBucketGone(bucketQuery.error);
  // A deletion that has been running for long enough is offered again: the page keeps a clock while one runs.
  const now = useNow(30_000, bucket?.deleting === true);

  const params = new URLSearchParams(paramsText);
  const tab = resolveBucketTab(params.get('tab'));
  const currentFolder = tab === 'files' ? parseFilesTabState(params).path : '';
  // The file drawer belongs to the Files tab: the address of another tab names no open file.
  const fileKey = tab === 'files' ? readOpenFile(params) : null;

  const [refreshing, setRefreshing] = useState(false);
  const [uploadFolder, setUploadFolder] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // A bucket that vanishes while its files were being deleted is the job finishing: go back to the list.
  const sawDeleting = useRef(false);
  const lastName = useRef(bucketKey);
  useEffect(() => {
    if (!bucket) return;
    lastName.current = bucket.name;
    if (bucket.deleting) sawDeleting.current = true;
  }, [bucket]);
  useEffect(() => {
    if (!gone || !sawDeleting.current) return;
    sawDeleting.current = false;
    notifications.show({ color: 'green', message: t('delete.deleted', { name: lastName.current }) });
    router.replace(LIST_HREF);
  }, [gone, router, t]);

  const changeTab = (id: string) => {
    router.replace(hrefWithQuery(pathname, withFilesTabState(paramsText, { tab: id as BucketTab, file: null })), { scroll: false });
  };

  // The open file is in the address (`?file=<key>`), so a link to a file opens its drawer. Opening one adds a
  // history entry, so Back closes the drawer; closing it from the drawer takes that entry off again instead of
  // stacking a second, identical one. A drawer that came with the address (a shared link, a reload) has no entry
  // of ours to take off: it is simply dropped from the address.
  const openedWithEntry = useRef(false);
  useEffect(() => {
    if (fileKey === null) openedWithEntry.current = false;
  }, [fileKey]);

  const openFile = (key: string) => {
    openedWithEntry.current = true;
    router.push(hrefWithQuery(pathname, withFilesTabState(paramsText, { file: key })), { scroll: false });
  };

  const closeFile = () => {
    if (openedWithEntry.current) {
      openedWithEntry.current = false;
      router.back();
      return;
    }
    router.replace(hrefWithQuery(pathname, withFilesTabState(paramsText, { file: null })), { scroll: false });
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await invalidation.bucketContent(bucketKey);
    } finally {
      setRefreshing(false);
    }
  };

  const changeStatus = (status: 'active' | 'disabled', kept = false) => {
    if (!bucket) return;
    updateBucket.mutate(
      { bucketKey, patch: { status } },
      {
        onSuccess: () =>
          notifications.show({
            color: 'green',
            message: kept
              ? t('actions.kept', { name: bucket.name })
              : status === 'active'
                ? t('actions.enabled', { name: bucket.name })
                : t('actions.disabledDone', { name: bucket.name }),
          }),
        // A bucket an agent keeps its session files in cannot be disabled: the refusal names the agents.
        onError: (error) =>
          notifications.show({ color: 'red', title: t('refusalTitleUpdate'), message: bucketErrorMessage(error, tc), autoClose: 12000 }),
      },
    );
  };

  /* ── States that replace the page ────────────────────────────────────── */

  if (bucketQuery.isPending) {
    return <DetailSkeleton tabs={3} actions={[96, 120, 34]} aside={false} label={t('state.loading')} />;
  }

  if (gone || !bucket) {
    return (
      <PageContainer>
        <StateCard
          tone={gone ? 'neutral' : 'error'}
          icon={gone ? <IconFolderOff size={22} stroke={1.6} /> : <IconAlertTriangle size={22} stroke={1.6} />}
          title={gone ? t('state.notFoundTitle') : t('state.errorTitle')}
          description={gone ? t('state.notFoundBody') : filesErrorMessage(bucketQuery.error, tc)}
        >
          <Group gap="xs" justify="center">
            {gone ? null : (
              <Button size="sm" variant="default" loading={bucketQuery.isFetching} onClick={() => void bucketQuery.refetch()}>
                {t('state.retry')}
              </Button>
            )}
            <Button component={Link} href={LIST_HREF} size="sm" variant="default" leftSection={<IconArrowLeft size={14} stroke={1.7} />}>
              {t('state.backToList')}
            </Button>
          </Group>
        </StateCard>
      </PageContainer>
    );
  }

  /* ── The page ────────────────────────────────────────────────────────── */

  const rules = deleteRules(bucket, now);
  const deleting = rules.deleting;
  const disabled = bucket.status !== 'active';
  // Changes need someone who may write, and a bucket that is not being deleted.
  const canChange = canWrite && !deleting;
  const canUpload = canChange && !disabled;
  const canImport = canUpload;
  const provider = bucket.provider;
  const providerLink = mayOpenProviders(user?.role) ? providerHref(provider) : null;
  const fileCount = bucket.stats?.fileCount ?? 0;
  const size = formatBytes(bucket.stats?.totalBytes);

  const tabs: DetailShellTab[] = [
    { id: 'files', label: t('tabs.files') },
    { id: 'settings', label: t('tabs.settings') },
    // "API" reads the same in every language.
    { id: 'api', label: 'API' },
  ];

  const actions = (
    <>
      <Button
        variant="default"
        size="sm"
        leftSection={<IconRefresh size={14} stroke={1.7} />}
        loading={refreshing}
        onClick={() => void refresh()}
      >
        {t('actions.refresh')}
      </Button>
      {canUpload ? (
        <Button size="sm" color="teal" leftSection={<IconUpload size={14} stroke={1.7} />} onClick={() => setUploadFolder(currentFolder)}>
          {t('actions.upload')}
        </Button>
      ) : null}
      {canChange ? (
        <Menu withinPortal position="bottom-end" withArrow>
          <Menu.Target>
            <ActionIcon variant="default" radius="md" size="lg" aria-label={t('actions.more')}>
              <IconDots size={15} stroke={1.7} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={disabled ? <IconCheck size={14} /> : <IconBan size={14} />}
              disabled={updateBucket.isPending}
              onClick={() => changeStatus(disabled ? 'active' : 'disabled')}
            >
              {disabled ? t('actions.enable') : t('actions.disable')}
            </Menu.Item>
            {canImport ? (
              <Menu.Item leftSection={<IconCloudDownload size={14} />} onClick={() => setImportOpen(true)}>
                {t('actions.import')}
              </Menu.Item>
            ) : null}
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => setDeleteOpen(true)}>
              {t('actions.delete')}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      ) : null}
    </>
  );

  const notices = [
    !canWrite ? <ReadOnlyHint key="read-only" variant="banner" /> : null,
    deleting ? (
      rules.stalled ? (
        <Alert key="deleting-stalled" variant="light" color="yellow" icon={<IconAlertTriangle size={16} />} role="status">
          <Group justify="space-between" gap="sm" wrap="wrap">
            <span>{t('banner.deletingStalled')}</span>
            {canWrite ? (
              <Button size="xs" color="red" onClick={() => setDeleteOpen(true)}>
                {t('banner.deleteAgain')}
              </Button>
            ) : null}
          </Group>
        </Alert>
      ) : (
        <Alert key="deleting" color="blue" icon={<Loader size={14} />} role="status">
          {t('banner.deleting')}
        </Alert>
      )
    ) : rules.lastError !== null ? (
      <Alert key="delete-failed" variant="light" color="red" icon={<IconAlertTriangle size={16} />} title={t('banner.deleteFailedTitle')} role="alert">
        <div style={{ overflowWrap: 'anywhere' }}>{rules.lastError}</div>
        <div className="ds-muted" style={{ marginTop: 4 }}>
          {t('banner.deleteFailedHint')}
        </div>
        {canWrite ? (
          <Group gap="xs" mt="xs">
            <Button size="xs" color="red" onClick={() => setDeleteOpen(true)}>
              {t('banner.deleteRetry')}
            </Button>
            <Button size="xs" variant="default" loading={updateBucket.isPending} onClick={() => changeStatus('active', true)}>
              {t('banner.keep')}
            </Button>
          </Group>
        ) : null}
      </Alert>
    ) : disabled ? (
      <Alert key="disabled" variant="light" color="yellow" icon={<IconBan size={16} />} role="note">
        <Group justify="space-between" gap="sm" wrap="wrap">
          <span>{t('banner.disabled')}</span>
          {canChange ? (
            <Button size="xs" color="teal" loading={updateBucket.isPending} onClick={() => changeStatus('active')}>
              {t('banner.enable')}
            </Button>
          ) : null}
        </Group>
      </Alert>
    ) : null,
  ].filter(Boolean);

  return (
    <div className={styles.page}>
      <DetailShell
        backHref={LIST_HREF}
        backLabel={t('header.back')}
        icon={
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 10,
              background: 'var(--ds-accent-soft)',
              color: 'var(--ds-accent)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <IconBucket size={22} stroke={1.7} aria-hidden="true" />
          </div>
        }
        title={
          <>
            <h1 className="ds-h2" style={{ margin: 0, overflowWrap: 'anywhere' }}>
              {bucket.name}
            </h1>
            <BucketStatusBadge status={bucket.status} deleting={deleting} deleteError={rules.lastError} />
          </>
        }
        meta={
          <div className={styles.facts}>
            <div className={styles.factsRow}>
              <span className={`${styles.fact} ${styles.factBare} ds-mono`}>{bucket.key}</span>
              {provider ? (
                <span className={styles.fact}>
                  {provider.label}
                  <span className="ds-faint">{` · ${driverNameOf(provider)}`}</span>
                </span>
              ) : null}
              {bucket.providerHealth ? (
                <span className={`${styles.fact} ${styles.factBare}`}>
                  <ProviderHealthChip health={bucket.providerHealth} href={providerLink} />
                </span>
              ) : null}
              <span className={styles.fact}>
                {fileCount === 1
                  ? t('header.statsOne', { size })
                  : t('header.statsMany', { count: formatCount(fileCount, locale), size })}
              </span>
            </div>
          </div>
        }
        actions={actions}
        tabs={tabs}
        activeTab={tab}
        onTabChange={changeTab}
      >
        {notices.length > 0 ? <div className="ds-col ds-gap-sm">{notices}</div> : null}

        {tab === 'files' ? (
          <BucketFilesTab
            bucket={bucket}
            canWrite={canWrite}
            onOpenUpload={setUploadFolder}
            onOpenFile={openFile}
            onOpenImport={canImport ? () => setImportOpen(true) : undefined}
          />
        ) : null}
        {tab === 'settings' ? <BucketSettingsTab bucket={bucket} canWrite={canWrite} /> : null}
        {tab === 'api' ? <BucketApiTab bucket={bucket} canWrite={canWrite} /> : null}

        <FileDetailDrawer
          bucket={bucket}
          fileKey={fileKey}
          onClose={closeFile}
          onChanged={() => void invalidation.bucketContent(bucketKey)}
          // The delete itself has refreshed the lists (`useDeleteObject`): the page only closes the drawer.
          onDeleted={closeFile}
        />
        <UploadFilesForm
          opened={uploadFolder !== null}
          onClose={() => setUploadFolder(null)}
          bucket={bucket}
          folder={uploadFolder ?? ''}
          // The upload screen refreshes the lists itself when its queue finishes.
          onUploaded={() => undefined}
        />
        <ImportFromStorageDialog bucket={bucket} opened={importOpen} onClose={() => setImportOpen(false)} />
        <DeleteBucketDialog bucket={bucket} opened={deleteOpen} onClose={() => setDeleteOpen(false)} />
      </DetailShell>
    </div>
  );
}
