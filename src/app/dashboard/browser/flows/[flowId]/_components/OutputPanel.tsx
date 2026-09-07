'use client';

/**
 * What the flow returns — declared here, and shown as the JSON the selected
 * run actually produced.
 *
 * The two halves belong on one screen: a declaration you cannot check against
 * a real run is a guess, and a run's JSON with nothing to compare it to does
 * not tell you whether the flow is finished. A flow that declares nothing
 * returns its raw captures, which is shown as such rather than as an empty
 * state, because that IS the return value — just an unstable one.
 */

import { ActionIcon, Badge, Button, Code, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconPencil, IconPlus, IconTargetArrow, IconTrash } from '@tabler/icons-react';
import type { BrowserFlowRunView } from '@/lib/services/browser';
import type { IBrowserFlowOutput } from '@/lib/database';
import classes from '../../../_workbench/workbench.module.css';

export default function OutputPanel({
  outputs,
  captureNames,
  run,
  onAdd,
  onEdit,
  onRemove,
  onPickFromPage,
  picking,
  saving,
}: {
  outputs: IBrowserFlowOutput[];
  captureNames: string[];
  run: BrowserFlowRunView | null;
  onAdd: () => void;
  onEdit: (name: string) => void;
  onRemove: (name: string) => void;
  /** Arm the Elements list: the next pick is read into a new output. */
  onPickFromPage?: () => void;
  picking?: boolean;
  saving: boolean;
}) {
  const missingCapture = (source: string) => {
    const match = source.match(/\{\{\s*step\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g) ?? [];
    return match
      .map((token) => token.replace(/[^A-Za-z0-9_.]/g, '').replace('step.', ''))
      .filter((name) => !captureNames.includes(name));
  };

  const produced = run?.outputs ?? {};
  const hasProduced = Object.keys(produced).length > 0;

  return (
    <Stack gap={0}>
      <Group justify="space-between" p="xs" wrap="nowrap" align="flex-start">
        <Text size="xs" c="dimmed">
          The JSON a run hands back to an agent or an API caller.
        </Text>
        <Group gap={4} wrap="nowrap">
          {onPickFromPage ? (
            <Tooltip label="Click an element in the Elements list; it becomes a read step and this field">
              <Button
                size="compact-xs"
                variant={picking ? 'filled' : 'light'}
                color="blue"
                leftSection={<IconTargetArrow size={12} />}
                onClick={onPickFromPage}
              >
                {picking ? 'Pick one…' : 'From page'}
              </Button>
            </Tooltip>
          ) : null}
          <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={onAdd}>
            Add
          </Button>
        </Group>
      </Group>

      {onPickFromPage ? null : (
        <Text size="xs" c="dimmed" px="xs" pb={4}>
          Start an authoring session to read a field straight off the page into an output.
        </Text>
      )}

      {outputs.length === 0 ? (
        <Text size="xs" c="dimmed" fs="italic" px="sm" pb="xs">
          Nothing declared, so the run returns its raw captures — every <b>Capture result as</b> name,
          whatever they happen to be. Declare fields to give callers a shape that survives the steps
          being rearranged.
        </Text>
      ) : (
        outputs.map((item) => {
          const broken = missingCapture(item.source);
          return (
            <Group
              key={item.name}
              gap={8}
              wrap="nowrap"
              px="xs"
              py={7}
              style={{ borderTop: '1px solid var(--ds-border)' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <Group gap={6} wrap="nowrap">
                  <Text size="xs" fw={600}>{item.name}</Text>
                  <Badge size="xs" variant="light" color="gray">{item.type ?? 'as captured'}</Badge>
                  {item.required ? <Badge size="xs" variant="light" color="blue">required</Badge> : null}
                  {broken.length > 0 ? (
                    <Tooltip label={`Nothing captures ${broken.join(', ')}`}>
                      <IconAlertTriangle size={13} style={{ color: 'var(--ds-warn, #d97706)' }} />
                    </Tooltip>
                  ) : null}
                </Group>
                <Code style={{ fontSize: 10, wordBreak: 'break-all' }}>{item.source}</Code>
              </div>
              <Tooltip label="Edit">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  disabled={saving}
                  aria-label={`Edit ${item.name}`}
                  onClick={() => onEdit(item.name)}
                >
                  <IconPencil size={13} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Remove">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  disabled={saving}
                  aria-label={`Remove ${item.name}`}
                  onClick={() => onRemove(item.name)}
                >
                  <IconTrash size={13} />
                </ActionIcon>
              </Tooltip>
            </Group>
          );
        })
      )}

      <div style={{ borderTop: '1px solid var(--ds-border)', padding: 10 }}>
        <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb={6}>
          {run ? `Returned by run ${run.id.slice(0, 8)}` : 'Returned'}
        </Text>
        {!run ? (
          <Text size="xs" c="dimmed" fs="italic">Run the flow to see what it returns.</Text>
        ) : (
          <>
            <pre className={classes.jsonBlock}>
              {hasProduced ? JSON.stringify(produced, null, 2) : '{}'}
            </pre>
            {!hasProduced && run.status === 'succeeded' ? (
              <Text size="xs" c="dimmed" mt={6}>
                The run produced nothing. A step needs a <b>Capture result as</b> name before an
                output can read from it.
              </Text>
            ) : null}
            {run.captures && Object.keys(run.captures).length > 0 && outputs.length > 0 ? (
              <>
                <Text size="xs" fw={600} tt="uppercase" c="dimmed" mt={12} mb={6}>Raw captures</Text>
                <pre className={classes.jsonBlock}>{JSON.stringify(run.captures, null, 2)}</pre>
              </>
            ) : null}
          </>
        )}
      </div>
    </Stack>
  );
}
