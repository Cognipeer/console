'use client';

import { useCallback, useEffect, useRef } from 'react';
import { Alert, Button, Group, Loader, Progress, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import type { IRagReindexRun } from '@/lib/database/provider/types.domain';
import { errorMessage } from '@/lib/api/client';
import { useCancelRagReindex, useRagReindexRuns, useStartRagReindex } from '@/lib/api/queries/rag';

const POLL_INTERVAL_MS = 2500;

/**
 * Not finished yet — the background job owns the record. `pending` counts:
 * a run created by saving the edit form is visible before the queue picks it up.
 */
function isActive(status: IRagReindexRun['status']): boolean {
  return status === 'pending' || status === 'queued' || status === 'running';
}

const REASON_LABEL: Record<NonNullable<IRagReindexRun['reason']>, string> = {
  'chunk-config': 'the chunking configuration changed',
  'embedding-model': 'the embedding model changed',
  manual: 'started by hand',
};

export interface RagReindexState {
  activeRun: IRagReindexRun | null;
  latestRun: IRagReindexRun | null;
  busy: boolean;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  refresh: (silent?: boolean) => Promise<void>;
}

/**
 * Owns the module's re-index runs: the record is the source of truth, so the
 * list is polled while a run is active rather than assumed from what we sent.
 * `onSettled` fires once a run leaves the active states, which is when the
 * documents and the module counters are worth reloading.
 */
export function useRagReindex(
  moduleKey: string | undefined,
  onSettled?: () => void,
): RagReindexState {
  const runsQuery = useRagReindexRuns(moduleKey, POLL_INTERVAL_MS);
  const startMutation = useStartRagReindex(moduleKey ?? '');
  const cancelMutation = useCancelRagReindex(moduleKey ?? '');
  const activeKeyRef = useRef<string | null>(null);
  const settledRef = useRef(onSettled);
  const runs = runsQuery.data;
  const { refetch: refetchRuns } = runsQuery;

  useEffect(() => {
    settledRef.current = onSettled;
  }, [onSettled]);

  const refresh = useCallback(
    async (silent = false) => {
      if (!moduleKey) return;
      const result = await refetchRuns();
      if (result.isError && !silent) {
        notifications.show({
          color: 'red',
          title: 'Unable to load re-index runs',
          message: errorMessage(result.error, 'Unexpected error'),
        });
      }
    },
    [moduleKey, refetchRuns],
  );

  const activeRun = runs?.find((run) => isActive(run.status)) ?? null;
  const latestRun = runs?.[0] ?? null;

  // A run that was active on the previous poll and is not any more has just
  // rewritten every chunk of every document; whatever the page is showing is stale.
  useEffect(() => {
    const previous = activeKeyRef.current;
    activeKeyRef.current = activeRun?.key ?? null;
    if (previous && !activeRun) settledRef.current?.();
  }, [activeRun]);

  const start = useCallback(async () => {
    if (!moduleKey) return;
    try {
      await startMutation.mutateAsync(undefined);
      notifications.show({
        color: 'teal',
        title: 'Re-index started',
        message: 'Every document in this module is being re-chunked and re-embedded.',
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Unable to start re-index',
        message: errorMessage(err, 'Unexpected error'),
      });
    }
  }, [moduleKey, startMutation]);

  const cancel = useCallback(async () => {
    if (!moduleKey || !activeRun) return;
    try {
      await cancelMutation.mutateAsync(activeRun.key);
      notifications.show({
        color: 'yellow',
        title: 'Re-index cancelled',
        message: 'Documents already rebuilt keep the new configuration; the rest keep the old one.',
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Unable to cancel re-index',
        message: errorMessage(err, 'Unexpected error'),
      });
    }
  }, [moduleKey, activeRun, cancelMutation]);

  return {
    activeRun,
    latestRun,
    busy: startMutation.isPending || cancelMutation.isPending,
    start,
    cancel,
    refresh,
  };
}

interface RagReindexBannerProps extends RagReindexState {
  /** The module's stored vectors no longer match its configuration. */
  reindexRequired: boolean;
}

export default function RagReindexBanner({
  activeRun,
  latestRun,
  busy,
  start,
  cancel,
  reindexRequired,
}: RagReindexBannerProps) {
  if (activeRun) {
    // With access control on, a reader whose reads are checked gets no module total, and one who does not manage
    // the knowledge base no counts at all.
    const total = typeof activeRun.totalDocuments === 'number' ? activeRun.totalDocuments : undefined;
    const processed = typeof activeRun.processedDocuments === 'number' ? activeRun.processedDocuments : undefined;
    const failed = activeRun.failedDocuments ?? 0;
    const percent = total !== undefined && processed !== undefined
      ? (total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0)
      : 100;
    let heading = 'Re-indexing documents';
    if (processed !== undefined) {
      heading = total !== undefined
        ? `Re-indexing ${processed} of ${total || '?'} document(s)`
        : `Re-indexing — ${processed} document(s) rebuilt`;
    }
    return (
      <Alert color="blue" variant="light" icon={<Loader size={16} />} mb="md">
        <Stack gap="xs">
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" fw={600}>
              {heading}
              {failed > 0 ? ` — ${failed} failed` : ''}
            </Text>
            <Button
              size="xs"
              variant="light"
              color="yellow"
              leftSection={<IconPlayerStop size={14} />}
              onClick={() => void cancel()}
              loading={busy}
            >
              Cancel
            </Button>
          </Group>
          <Progress value={percent} size="sm" radius="xl" color="blue" animated />
          <Text size="xs" c="dimmed">
            Started because {REASON_LABEL[activeRun.reason ?? 'manual']}. Queries keep answering
            from the current vectors until the run finishes.
          </Text>
        </Stack>
      </Alert>
    );
  }

  if (reindexRequired) {
    return (
      <Alert
        color="yellow"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        title="Stored vectors no longer match this configuration"
        mb="md"
      >
        <Group justify="space-between" wrap="nowrap">
          <Text size="sm">
            Chunking or the embedding model changed since these documents were indexed.
            Queries still work, but they answer from the old vectors.
          </Text>
          <Button
            size="xs"
            leftSection={<IconRefresh size={14} />}
            onClick={() => void start()}
            loading={busy}
          >
            Re-index now
          </Button>
        </Group>
      </Alert>
    );
  }

  if (latestRun?.status === 'failed') {
    return (
      <Alert
        color="red"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        title="The last re-index failed"
        mb="md"
      >
        <Group justify="space-between" wrap="nowrap">
          <Text size="sm">
            {latestRun.errorMessage ?? 'No error was recorded.'}
            {latestRun.processedDocuments > 0
              ? ` ${latestRun.processedDocuments} document(s) had already been rebuilt.`
              : ''}
          </Text>
          <Button
            size="xs"
            color="red"
            leftSection={<IconRefresh size={14} />}
            onClick={() => void start()}
            loading={busy}
          >
            Retry
          </Button>
        </Group>
      </Alert>
    );
  }

  return null;
}
