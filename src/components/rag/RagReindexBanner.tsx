'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Loader, Progress, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import type { IRagReindexRun } from '@/lib/database/provider/types.domain';

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
  const [runs, setRuns] = useState<IRagReindexRun[]>([]);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const settledRef = useRef(onSettled);

  useEffect(() => {
    settledRef.current = onSettled;
  }, [onSettled]);

  const refresh = useCallback(async (silent = false) => {
    if (!moduleKey) return;
    try {
      const res = await fetch(`/api/rag/modules/${encodeURIComponent(moduleKey)}/reindex`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load re-index runs');
      const data = await res.json() as { runs?: IRagReindexRun[] };
      setRuns(data.runs ?? []);
    } catch (err) {
      if (!silent) {
        notifications.show({
          color: 'red',
          title: 'Unable to load re-index runs',
          message: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    }
  }, [moduleKey]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const activeRun = runs.find((run) => isActive(run.status)) ?? null;
  const latestRun = runs[0] ?? null;

  // A run that was active on the previous poll and is not any more has just
  // rewritten every chunk of every document; whatever the page is showing is stale.
  useEffect(() => {
    const previous = activeKeyRef.current;
    activeKeyRef.current = activeRun?.key ?? null;
    if (previous && !activeRun) settledRef.current?.();
  }, [activeRun]);

  useEffect(() => {
    if (activeRun) {
      pollRef.current = setInterval(() => { void refresh(true); }, POLL_INTERVAL_MS);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeRun, refresh]);

  const start = useCallback(async () => {
    if (!moduleKey) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/rag/modules/${encodeURIComponent(moduleKey)}/reindex`, { method: 'POST' });
      const data = await res.json().catch(() => ({ error: 'Unknown error' }));
      if (!res.ok) throw new Error(data.error ?? 'Failed to start re-index');
      notifications.show({
        color: 'teal',
        title: 'Re-index started',
        message: 'Every document in this module is being re-chunked and re-embedded.',
      });
      await refresh();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Unable to start re-index',
        message: err instanceof Error ? err.message : 'Unexpected error',
      });
    } finally {
      setBusy(false);
    }
  }, [moduleKey, refresh]);

  const cancel = useCallback(async () => {
    if (!moduleKey || !activeRun) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/rag/modules/${encodeURIComponent(moduleKey)}/reindex/${encodeURIComponent(activeRun.key)}/cancel`,
        { method: 'POST' },
      );
      const data = await res.json().catch(() => ({ error: 'Unknown error' }));
      if (!res.ok) throw new Error(data.error ?? 'Failed to cancel re-index');
      notifications.show({
        color: 'yellow',
        title: 'Re-index cancelled',
        message: 'Documents already rebuilt keep the new configuration; the rest keep the old one.',
      });
      await refresh();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Unable to cancel re-index',
        message: err instanceof Error ? err.message : 'Unexpected error',
      });
    } finally {
      setBusy(false);
    }
  }, [moduleKey, activeRun, refresh]);

  return { activeRun, latestRun, busy, start, cancel, refresh };
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
    const total = activeRun.totalDocuments;
    const percent = total > 0 ? Math.min(100, Math.round((activeRun.processedDocuments / total) * 100)) : 0;
    return (
      <Alert color="blue" variant="light" icon={<Loader size={16} />} mb="md">
        <Stack gap="xs">
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" fw={600}>
              Re-indexing {activeRun.processedDocuments} of {total || '?'} document(s)
              {activeRun.failedDocuments > 0 ? ` — ${activeRun.failedDocuments} failed` : ''}
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
