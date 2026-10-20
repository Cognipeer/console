'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import { Alert, Button, Skeleton, Text } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconPlus, IconRefresh } from '@tabler/icons-react';
import { SkeletonRegion } from '@/components/common/ui/Skeletons';
import { useTranslations } from '@/lib/i18n';
import type { FilesApiError, FileProviderListItem } from '../filesApi';
import { FILE_PROVIDERS_HREF, hasUsableProvider, isLocalDiskProvider, isProviderUsable } from '../list/providerModel';
import { filesErrorMessage } from '../shared';
import { ProviderCards } from './ProviderCards';

export interface ProviderSectionProps {
  query: UseQueryResult<FileProviderListItem[], FilesApiError>;
  /** The key of the provider chosen; `''` = none. */
  value: string;
  onChange: (providerKey: string) => void;
  /** The person may open the Providers area. */
  canManageProviders: boolean;
  /** The reason the server refused the choice. */
  error: string | null;
}

/** Opens the Providers area in a new tab: the form keeps what was typed. */
function AddProviderLink({ label }: { label: string }) {
  return (
    <Button
      component="a"
      href={FILE_PROVIDERS_HREF}
      target="_blank"
      rel="noopener noreferrer"
      variant="subtle"
      size="compact-sm"
      leftSection={<IconPlus size={14} stroke={1.7} />}
    >
      {label}
    </Button>
  );
}

/**
 * The "Storage provider" section: the provider cards, or what stands in for them while the providers load, when
 * they could not be loaded, and when the project has none. Also the way to add a provider without leaving the form.
 */
export function ProviderSection({ query, value, onChange, canManageProviders, error }: ProviderSectionProps) {
  const t = useTranslations('files.create');
  const tCommon = useTranslations('files.common');

  if (query.isPending) {
    return (
      <SkeletonRegion>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 250px), 1fr))', gap: 10 }}>
          <Skeleton height={92} radius="md" />
          <Skeleton height={92} radius="md" />
        </div>
      </SkeletonRegion>
    );
  }

  if (!query.data) {
    return (
      <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title={t('provider.loadFailedTitle')}>
        <div className="ds-row ds-gap-sm" style={{ flexWrap: 'wrap' }}>
          <span>{filesErrorMessage(query.error, tCommon)}</span>
          <Button variant="default" size="compact-sm" loading={query.isFetching} onClick={() => void query.refetch()}>
            {t('provider.retry')}
          </Button>
        </div>
      </Alert>
    );
  }

  const providers = query.data;

  if (providers.length === 0) {
    return (
      <div className="ds-card ds-card-pad" style={{ background: 'var(--ds-surface-1)' }}>
        <div className="ds-h4" style={{ marginBottom: 4 }}>
          {t('provider.noneTitle')}
        </div>
        <Text size="sm" c="dimmed" mb="sm">
          {t('provider.noneDescription')}
        </Text>
        {canManageProviders ? <AddProviderLink label={t('provider.add')} /> : <Text size="sm">{t('provider.askAdmin')}</Text>}
      </div>
    );
  }

  const selected = providers.find((provider) => provider.key === value && isProviderUsable(provider));

  return (
    <div className="ds-col" style={{ gap: 10 }}>
      <ProviderCards
        providers={providers}
        value={value}
        onChange={onChange}
        canManageProviders={canManageProviders}
        error={error}
      />

      {!hasUsableProvider(providers) ? (
        <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
          {canManageProviders ? t('provider.noneUsable') : t('provider.noneUsableAskAdmin')}
        </Alert>
      ) : null}

      {selected && isLocalDiskProvider(selected) ? (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} title={t('provider.localWarningTitle')}>
          {t('provider.localWarning')}
        </Alert>
      ) : null}

      <div className="ds-row ds-gap-sm" style={{ flexWrap: 'wrap' }}>
        {canManageProviders ? <AddProviderLink label={t('provider.add')} /> : null}
        <Button
          variant="subtle"
          color="gray"
          size="compact-sm"
          leftSection={<IconRefresh size={14} stroke={1.7} />}
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t('provider.refresh')}
        </Button>
      </div>
    </div>
  );
}
