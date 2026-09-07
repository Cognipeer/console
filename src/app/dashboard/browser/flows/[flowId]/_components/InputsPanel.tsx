'use client';

/**
 * The flow's declared inputs, and whether the steps agree with them.
 *
 * Two disagreements are worth surfacing, because both fail silently at run
 * time: a placeholder no input declares (it is left in the payload verbatim
 * and typed into the page as `{{input.x}}`), and an input nothing references
 * (someone renamed a step's placeholder and the parameter is now dead weight
 * on the run form).
 */

import { useMemo } from 'react';
import { ActionIcon, Badge, Button, Code, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import type { IBrowserFlowInput, IBrowserFlowStep } from '@/lib/database';

/** Every `{{input.x}}` a step references, in order of first appearance. */
export function referencedInputs(steps: IBrowserFlowStep[]): string[] {
  const found: string[] = [];
  for (const step of steps) {
    const haystack = `${JSON.stringify(step.action)} ${step.when ?? ''}`;
    for (const match of haystack.matchAll(/\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
      if (!found.includes(match[1])) found.push(match[1]);
    }
  }
  return found;
}

export default function InputsPanel({
  inputs,
  steps,
  values,
  onValue,
  onAdd,
  onEdit,
  onRemove,
  onDeclare,
  saving,
}: {
  inputs: IBrowserFlowInput[];
  steps: IBrowserFlowStep[];
  /** What `{{input.x}}` resolves to while authoring. Never saved. */
  values: Record<string, string>;
  onValue: (name: string, value: string) => void;
  onAdd: () => void;
  onEdit: (name: string) => void;
  onRemove: (name: string) => void;
  onDeclare: (name: string) => void;
  saving: boolean;
}) {
  const referenced = useMemo(() => referencedInputs(steps), [steps]);
  const declared = inputs.map((item) => item.name);
  const undeclared = referenced.filter((name) => !declared.includes(name));

  const usage = (name: string) => steps.filter(
    (step) => `${JSON.stringify(step.action)} ${step.when ?? ''}`.includes(`input.${name}`),
  ).length;

  return (
    <Stack gap={0}>
      <Group justify="space-between" p="xs">
        <Text size="xs" c="dimmed">
          Supplied per run, referenced from steps as <Code style={{ fontSize: 10 }}>{'{{input.name}}'}</Code>.
        </Text>
        <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={onAdd}>
          Add
        </Button>
      </Group>

      {undeclared.map((name) => (
        <Group key={name} gap={8} wrap="nowrap" px="xs" py={6} style={{ borderTop: '1px solid var(--ds-border)' }}>
          <IconAlertTriangle size={14} style={{ color: 'var(--ds-warn, #d97706)', flex: 'none' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Code style={{ fontSize: 11 }}>{`{{input.${name}}}`}</Code>
            <Text size="xs" c="dimmed">Referenced by a step, but not declared — it will not resolve.</Text>
          </div>
          <Button size="compact-xs" variant="light" color="orange" onClick={() => onDeclare(name)}>
            Declare
          </Button>
        </Group>
      ))}

      {inputs.length === 0 && undeclared.length === 0 ? (
        <Text size="xs" c="dimmed" fs="italic" p="sm">
          No inputs. Recording adds one for every value that was typed, so nothing is baked into the
          steps — and the ⚡ on a step lifts any other literal out into one.
        </Text>
      ) : null}

      {inputs.length > 0 ? (
        <Text size="xs" c="dimmed" px="xs" pt={8} pb={0}>
          Values below are used when you run steps here. They are never saved to the flow — a run
          from the API or an agent supplies its own.
        </Text>
      ) : null}

      {inputs.map((item) => {
        const uses = usage(item.name);
        return (
          <div key={item.name} style={{ borderTop: '1px solid var(--ds-border)' }}>
          <Group
            gap={8}
            wrap="nowrap"
            px="xs"
            py={7}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <Group gap={6} wrap="nowrap">
                <Code style={{ fontSize: 11 }}>{`{{input.${item.name}}}`}</Code>
                <Badge size="xs" variant="light" color={item.type === 'secret' ? 'orange' : 'gray'}>
                  {item.type}
                </Badge>
                {item.required ? <Badge size="xs" variant="light" color="blue">required</Badge> : null}
                {item.default !== undefined ? (
                  <Badge size="xs" variant="light" color="gray">= {String(item.default).slice(0, 20)}</Badge>
                ) : null}
              </Group>
              <Text size="xs" c={uses === 0 ? 'orange' : 'dimmed'} lineClamp={1}>
                {uses === 0
                  ? 'No step references it.'
                  : `${uses} step${uses > 1 ? 's' : ''}${item.description ? ` · ${item.description}` : ''}`}
              </Text>
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
          <TextInput
            size="xs"
            mx="xs"
            mb={8}
            type={item.type === 'secret' ? 'password' : 'text'}
            placeholder={
              item.type === 'secret'
                ? 'Value for this session — kept in the browser'
                : item.default !== undefined
                  ? `Defaults to “${String(item.default).slice(0, 30)}”`
                  : 'Value for this session'
            }
            value={values[item.name] ?? ''}
            aria-label={`Authoring value for ${item.name}`}
            onChange={(event) => {
              const value = event.currentTarget.value;
              onValue(item.name, value);
            }}
          />
          </div>
        );
      })}
    </Stack>
  );
}
