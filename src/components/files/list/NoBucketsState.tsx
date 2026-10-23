'use client';

import Link from 'next/link';
import { Button, Skeleton, Text } from '@mantine/core';
import { IconFolder, IconPlugConnected, IconPlus } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { ReadOnlyHint } from '../shared';
import { useFileProviders } from '../useFilesQueries';
import ListStateCard from './ListStateCard';
import { FILE_PROVIDERS_HREF, hasUsableProvider } from './providerModel';

export interface NoBucketsStateProps {
  /** The person may create buckets (the button is not drawn for someone who can only read). */
  canWrite: boolean;
  /** The person may open the Providers area: the empty state can take them straight there. */
  canManageProviders: boolean;
  onCreate: () => void;
}

/**
 * The list when the project has no bucket at all. What it offers depends on what is missing: without a file
 * provider (or with every provider switched off) a bucket cannot be created, so the way on is to add one; with a
 * provider the way on is to create the first bucket.
 *
 * Mounted only when there are no buckets, which is the only time the providers are asked for here.
 */
export default function NoBucketsState({ canWrite, canManageProviders, onCreate }: NoBucketsStateProps) {
  const t = useTranslations('files.list');
  const providers = useFileProviders();

  if (providers.isSuccess && !hasUsableProvider(providers.data)) {
    const none = providers.data.length === 0;
    return (
      <ListStateCard
        icon={<IconPlugConnected size={26} stroke={1.7} />}
        title={none ? t('noProvider.title') : t('noUsableProvider.title')}
        description={none ? t('noProvider.description') : t('noUsableProvider.description')}
      >
        {canManageProviders ? (
          <Button
            component={Link}
            href={FILE_PROVIDERS_HREF}
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
          >
            {none ? t('noProvider.add') : t('noUsableProvider.manage')}
          </Button>
        ) : (
          <Text size="sm" c="dimmed" ta="center" maw={460}>
            {none ? t('noProvider.askAdmin') : t('noUsableProvider.askAdmin')}
          </Text>
        )}
      </ListStateCard>
    );
  }

  return (
    <ListStateCard
      icon={<IconFolder size={26} stroke={1.7} />}
      title={t('empty.title')}
      description={t('empty.description')}
    >
      {providers.isPending && canWrite ? (
        // The button waits for the providers: it would otherwise flip to "add a provider" a moment after it appeared.
        <Skeleton height={36} width={150} radius="sm" aria-hidden="true" />
      ) : canWrite ? (
        <Button color="teal" size="sm" leftSection={<IconPlus size={14} stroke={1.7} />} onClick={onCreate}>
          {t('actions.create')}
        </Button>
      ) : (
        <ReadOnlyHint />
      )}
    </ListStateCard>
  );
}
