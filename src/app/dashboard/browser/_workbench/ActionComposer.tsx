'use client';

/**
 * The form that turns "click that button" into an action payload.
 *
 * Kept small and field-per-type on purpose: the composer sits beside a live
 * page, and every extra field is one more thing between seeing something and
 * doing it. The element slot is read-only — a target arrives by clicking the
 * Elements list, never by typing a selector here, because a target you typed
 * is a target nobody verified against the page in front of you.
 */

import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { IconChevronRight, IconX } from '@tabler/icons-react';
import {
  ACTION_TYPES,
  TARGETED,
  WAIT_UNTIL_OPTIONS,
  describeTarget,
  type ActionDraft,
} from './actions';
import classes from './workbench.module.css';

export default function ActionComposer({
  draft,
  onChange,
  onSubmit,
  busy,
  disabled,
  submitLabel = 'Run step',
  submitColor = 'teal',
  hint,
}: {
  draft: ActionDraft;
  onChange: (next: ActionDraft) => void;
  onSubmit: () => void;
  busy?: boolean;
  disabled?: boolean;
  submitLabel?: string;
  submitColor?: string;
  hint?: string;
}) {
  const set = (patch: Partial<ActionDraft>) => onChange({ ...draft, ...patch });
  const targetLabel = Object.keys(draft.target).length > 0 ? describeTarget(draft.target) : null;

  return (
    <Stack gap="xs" p="sm">
      <Select
        size="xs"
        label="Step"
        data={ACTION_TYPES}
        value={draft.type}
        onChange={(next) => next && set({ type: next })}
      />

      {draft.type === 'goto' ? (
        <>
          <TextInput
            size="xs"
            label="URL"
            placeholder="https://example.com"
            value={draft.url}
            onChange={(event) => set({ url: event.currentTarget.value })}
            onKeyDown={(event) => { if (event.key === 'Enter') onSubmit(); }}
          />
          <Select
            size="xs"
            label="Wait until"
            data={WAIT_UNTIL_OPTIONS}
            value={draft.waitUntil}
            onChange={(value) => set({ waitUntil: (value as ActionDraft['waitUntil']) ?? 'domcontentloaded' })}
          />
        </>
      ) : null}

      {draft.type === 'type' || draft.type === 'select' ? (
        <TextInput
          size="xs"
          label={draft.type === 'type' ? 'Text' : 'Option label'}
          value={draft.value}
          onChange={(event) => set({ value: event.currentTarget.value })}
        />
      ) : null}

      {draft.type === 'press' ? (
        <TextInput
          size="xs"
          label="Key"
          placeholder="Enter"
          value={draft.key}
          onChange={(event) => set({ key: event.currentTarget.value })}
        />
      ) : null}

      {draft.type === 'check' ? (
        <Switch
          size="sm"
          label={draft.checked ? 'Check it' : 'Uncheck it'}
          checked={draft.checked}
          onChange={(event) => set({ checked: event.currentTarget.checked })}
        />
      ) : null}

      {draft.type === 'scroll' ? (
        <TextInput
          size="xs"
          label="Scroll down (px)"
          value={draft.scrollY}
          onChange={(event) => set({ scrollY: event.currentTarget.value })}
        />
      ) : null}

      {draft.type === 'wait' ? (
        <>
          <TextInput
            size="xs"
            label="Until text appears"
            placeholder="Leave empty for a fixed delay"
            value={draft.waitText}
            onChange={(event) => set({ waitText: event.currentTarget.value })}
          />
          {!draft.waitText.trim() ? (
            <TextInput
              size="xs"
              label="Delay (ms)"
              value={draft.waitMs}
              onChange={(event) => set({ waitMs: event.currentTarget.value })}
            />
          ) : null}
        </>
      ) : null}

      {TARGETED.has(draft.type) ? (
        <div className={classes.targetSlot}>
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb={4}>Element</Text>
          {targetLabel ? (
            <Group gap="xs" wrap="nowrap">
              <Badge size="sm" variant="light" color="teal" style={{ maxWidth: '100%' }}>
                {targetLabel}
              </Badge>
              <ActionIcon size="xs" variant="subtle" aria-label="Clear element" onClick={() => set({ target: {} })}>
                <IconX size={12} />
              </ActionIcon>
            </Group>
          ) : (
            <Text size="xs" c="dimmed" fs="italic">
              Pick one from the Elements list →
            </Text>
          )}
        </div>
      ) : null}

      <Button
        size="xs"
        color={submitColor}
        loading={busy}
        disabled={disabled}
        leftSection={<IconChevronRight size={14} />}
        onClick={onSubmit}
      >
        {submitLabel}
      </Button>

      {hint ? <Text size="xs" c="dimmed">{hint}</Text> : null}
    </Stack>
  );
}
