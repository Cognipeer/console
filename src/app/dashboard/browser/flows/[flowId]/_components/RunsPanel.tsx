'use client';

/**
 * Run history. Selecting a run pins it: its step outcomes appear on the step
 * list, its JSON on the output tab, and its session in the preview — so a
 * failure from last night is inspected in the same three panes it would have
 * been watched in live.
 */

import { Badge, Group, Loader, Stack, Text } from '@mantine/core';
import type { BrowserFlowRunView } from '@/lib/services/browser';
import classes from '../../../_workbench/workbench.module.css';

const COLOR: Record<string, string> = {
  succeeded: 'teal',
  running: 'blue',
  pending: 'gray',
  failed: 'red',
  cancelled: 'gray',
};

export default function RunsPanel({
  runs,
  selectedId,
  onSelect,
}: {
  runs: BrowserFlowRunView[];
  selectedId?: string;
  onSelect: (run: BrowserFlowRunView) => void;
}) {
  if (runs.length === 0) {
    return <Text size="xs" c="dimmed" fs="italic" p="sm">Never run.</Text>;
  }

  return (
    <Stack gap={0}>
      {runs.map((run) => (
        <button
          key={run.id}
          type="button"
          className={`${classes.stepRow} ${selectedId === run.id ? classes.stepRowSelected : ''}`}
          onClick={() => onSelect(run)}
        >
          <Badge
            size="xs"
            variant="light"
            color={COLOR[run.status] ?? 'gray'}
            leftSection={run.status === 'running' ? <Loader size={8} color="blue" /> : undefined}
            style={{ flex: 'none' }}
          >
            {run.status}
          </Badge>
          <div style={{ minWidth: 0, flex: 1 }}>
            <Group gap={6} wrap="nowrap">
              <Text size="xs" c="dimmed">
                {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
              </Text>
              <Badge size="xs" variant="light" color="gray">{run.trigger}</Badge>
              <Text size="xs" c="dimmed" ff="monospace">v{run.flowVersion}</Text>
            </Group>
            <Text size="xs" c={run.status === 'failed' ? 'red' : 'dimmed'} lineClamp={1}>
              {run.status === 'failed'
                ? `${run.failedStepIndex === undefined ? '' : `step ${run.failedStepIndex + 1}: `}${run.errorMessage ?? 'failed'}`
                : `${run.stepResults?.length ?? 0} step(s)`}
            </Text>
          </div>
          <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 'none' }}>{run.durationMs ?? 0}ms</Text>
        </button>
      ))}
    </Stack>
  );
}
