'use client';

/**
 * The flow's steps, in order — and, while a test run is being watched, what
 * each one did.
 *
 * One list rather than two. A step and its last result are the same thing
 * seen from two sides, and putting the run's outcome anywhere but on the step
 * itself makes "which step broke" a lookup instead of a glance. Order is the
 * information here, so this is a ledger, not a card grid.
 */

import { ActionIcon, Badge, Code, Group, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconArrowDown,
  IconArrowUp,
  IconBolt,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconLoader2,
  IconPencil,
  IconPlayerPlay,
  IconTrash,
} from '@tabler/icons-react';
import type { IBrowserFlowStep, IBrowserFlowStepResult } from '@/lib/database';
import { describeAction } from '../../../_workbench/actions';
import classes from '../../../_workbench/workbench.module.css';

export default function StepsPanel({
  steps,
  results,
  running,
  cursor,
  onCursor,
  onMove,
  onRemove,
  onEdit,
  onParametrize,
  onRunTo,
  executedThrough = -1,
  replayingTo,
  saving,
}: {
  steps: IBrowserFlowStep[];
  results?: Array<IBrowserFlowStepResult | undefined>;
  running?: boolean;
  cursor: number;
  onCursor: (index: number) => void;
  onMove: (index: number, delta: number) => void;
  onRemove: (index: number) => void;
  onEdit: (index: number) => void;
  onParametrize: (index: number) => void;
  /** Put the live session into the state after this step. Absent = not authoring. */
  onRunTo?: (index: number) => void;
  /** Last step the live session has actually executed. */
  executedThrough?: number;
  /** Step currently being replayed, so the row can say so. */
  replayingTo?: number | null;
  saving: boolean;
}) {
  if (steps.length === 0) {
    return (
      <Text size="xs" c="dimmed" fs="italic" p="sm">
        No steps yet. Start an authoring session and act on the page — each action lands here — or
        add one by hand.
      </Text>
    );
  }

  const executedLabel = executedThrough >= 0
    ? `The live session is at step ${executedThrough + 1}. ▶ on a later step runs the ones in between; ▶ on an earlier one replays from the top.`
    : null;

  const insertMark = (index: number) => (
    <button
      type="button"
      className={`${classes.insertMark} ${cursor === index ? classes.insertMarkActive : ''}`}
      aria-label={`Insert recorded steps at position ${index + 1}`}
      onClick={() => onCursor(index)}
    >
      {cursor === index ? 'next step lands here' : ''}
    </button>
  );

  return (
    <Stack gap={0}>
      {executedLabel ? (
        <Text size="xs" c="dimmed" px="xs" pt={6} pb={2}>{executedLabel}</Text>
      ) : null}
      {insertMark(0)}
      {steps.map((step, index) => {
        const result = results?.[index];
        const pending = (running && !result && index === (results?.length ?? 0))
          || replayingTo === index;
        const icon = result?.status === 'succeeded'
          ? <IconCircleCheck size={13} className={classes.okIcon} />
          : result?.status === 'skipped'
            ? <IconCircleDashed size={13} style={{ color: 'var(--ds-text-dimmed, #999)' }} />
            : result?.status === 'failed'
              ? <IconCircleX size={13} className={classes.errIcon} />
              : pending
                ? <IconLoader2 size={13} className={classes.spin} />
                : <IconCircleDashed size={13} style={{ opacity: 0.35 }} />;

        const action = step.action as Record<string, unknown>;
        const parametrized = JSON.stringify(action).includes('{{input.');
        const executed = index <= executedThrough;

        return (
          <div key={step.id || index}>
            <div
              className={[
                classes.stepRow,
                result?.status === 'failed' ? classes.stepRowFailed : '',
                executed ? classes.stepRowExecuted : '',
              ].filter(Boolean).join(' ')}
              style={{ cursor: 'default' }}
            >
              {results || running ? icon : (
                <Text size="xs" c="dimmed" ff="monospace" w={18} style={{ flex: 'none' }}>{index + 1}</Text>
              )}

              <div style={{ minWidth: 0, flex: 1 }}>
                <Group gap={6} wrap="nowrap">
                  <Text size="xs" truncate>{step.label || describeAction(action)}</Text>
                  {step.captureAs ? (
                    <Badge size="xs" variant="light" color="teal">→ {step.captureAs}</Badge>
                  ) : null}
                  {parametrized ? (
                    <Badge size="xs" variant="light" color="violet">param</Badge>
                  ) : null}
                  {step.policy?.optional ? <Badge size="xs" variant="light">optional</Badge> : null}
                </Group>
                <Code style={{ fontSize: 10, wordBreak: 'break-all' }}>{JSON.stringify(action)}</Code>
                {result?.errorMessage ? (
                  <Text size="xs" c="red" lineClamp={2}>{result.errorMessage}</Text>
                ) : null}
              </div>

              {result ? (
                <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 'none' }}>
                  {result.attempts > 1 ? `${result.attempts}× · ` : ''}{result.durationMs ?? 0}ms
                </Text>
              ) : null}

              <Group gap={0} wrap="nowrap" style={{ flex: 'none' }}>
                {onRunTo ? (
                  <Tooltip
                    label={
                      index > executedThrough
                        ? `Run steps ${executedThrough + 2}–${index + 1} here`
                        : `Replay from the top through step ${index + 1}`
                    }
                  >
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="teal"
                      loading={replayingTo === index}
                      disabled={saving || replayingTo != null}
                      aria-label={`Run through step ${index + 1}`}
                      onClick={() => onRunTo(index)}
                    >
                      <IconPlayerPlay size={13} />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
                <Tooltip label="Parametrize a value">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="violet"
                    disabled={saving}
                    aria-label={`Parametrize step ${index + 1}`}
                    onClick={() => onParametrize(index)}
                  >
                    <IconBolt size={13} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Edit">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    disabled={saving}
                    aria-label={`Edit step ${index + 1}`}
                    onClick={() => onEdit(index)}
                  >
                    <IconPencil size={13} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Move up">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    disabled={index === 0 || saving}
                    aria-label={`Move step ${index + 1} up`}
                    onClick={() => onMove(index, -1)}
                  >
                    <IconArrowUp size={13} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Move down">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    disabled={index === steps.length - 1 || saving}
                    aria-label={`Move step ${index + 1} down`}
                    onClick={() => onMove(index, 1)}
                  >
                    <IconArrowDown size={13} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Remove">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="red"
                    disabled={saving}
                    aria-label={`Remove step ${index + 1}`}
                    onClick={() => onRemove(index)}
                  >
                    <IconTrash size={13} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </div>
            {insertMark(index + 1)}
          </div>
        );
      })}
    </Stack>
  );
}
