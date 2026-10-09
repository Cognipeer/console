'use client';

import { useEffect, useState } from 'react';
import { Group, Loader, Stack, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import ResourceUsagePanel from '@/components/resources/ResourceUsagePanel';
import { fetchResourceUsage, totalUses, type ResourceUsageResponse } from './resourceUsage';

export interface ResourceUsageSectionProps {
  /** Registry type id, e.g. 'agent'. */
  type: string;
  id: string;
  /** Also list what this resource uses (agents: their default execution role...). */
  showUses?: boolean;
  /** Bump to refetch after something on the page changed. */
  refreshKey?: string | number;
}

/**
 * Self-fetching "Used by" (and optionally "Uses") section for detail pages.
 * A failed load shows a short note instead of breaking the page.
 */
export default function ResourceUsageSection({ type, id, showUses = false, refreshKey }: ResourceUsageSectionProps) {
  const t = useTranslations('common.confirm.usage');
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error' }
    | { status: 'ready'; usage: ResourceUsageResponse }
  >({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchResourceUsage(type, id, controller.signal)
      .then((usage) => setState({ status: 'ready', usage }))
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [type, id, refreshKey]);

  if (state.status === 'loading') {
    return (
      <Group gap={8} role="status" aria-live="polite">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">{t('loading')}</Text>
      </Group>
    );
  }
  if (state.status === 'error') {
    return <Text size="sm" c="dimmed">{t('loadFailed')}</Text>;
  }

  const { usage } = state;
  const uses = usage.uses ?? [];
  const hasAnything = totalUses(usage) > 0 || (showUses && uses.length > 0);

  if (!hasAnything) {
    return <Text size="sm" c="dimmed">{t('none')}</Text>;
  }

  return (
    <Stack gap="xs">
      <ResourceUsagePanel usedBy={usage.usedBy} uses={uses} hideUses={!showUses} />
      {usage.usedByTruncated ? <Text size="xs" c="dimmed">{t('truncated')}</Text> : null}
      {usage.hiddenUsedByCount > 0 ? (
        <Text size="sm" c="dimmed">{t('hiddenUses', { count: usage.hiddenUsedByCount })}</Text>
      ) : null}
    </Stack>
  );
}
