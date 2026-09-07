'use client';

/**
 * Declare one field of the JSON the flow returns.
 *
 * `source` offers the flow's captures as a dropdown and still accepts a
 * hand-written template, because the two cases are genuinely different: most
 * fields are one capture verbatim, and the rest are assembled from several —
 * and a flow that has to add a step just to join two strings is a worse flow.
 */

import { useEffect, useRef, useState } from 'react';
import { Select, Switch, Text, TextInput, Textarea } from '@mantine/core';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type { IBrowserFlowOutput } from '@/lib/database';

export const EMPTY_OUTPUT: IBrowserFlowOutput = { name: '', source: '', required: false };

const CUSTOM = '__custom__';

export default function OutputDialog({
  open,
  initial,
  editing,
  saving,
  captureNames,
  inputNames,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initial: IBrowserFlowOutput;
  editing: boolean;
  saving: boolean;
  captureNames: string[];
  inputNames: string[];
  onClose: () => void;
  onSubmit: (output: IBrowserFlowOutput) => void;
}) {
  const [draft, setDraft] = useState<IBrowserFlowOutput>(initial);
  const [custom, setCustom] = useState(false);

  // Seed the form when the dialog OPENS, not whenever it re-renders. The
  // props that describe the flow (`captureNames`, `inputNames`) are rebuilt
  // by the parent on every render, so an effect that depends on them fires
  // constantly — and one that reseeds the draft would wipe each keystroke as
  // it was typed.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(initial);
      // A source that is exactly one placeholder came from the dropdown;
      // anything else was hand-written and reopens as a custom template.
      setCustom(Boolean(initial.source) && !/^\{\{\s*(step|input)\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/.test(initial.source));
    }
    wasOpen.current = open;
  }, [open, initial]);

  const set = (patch: Partial<IBrowserFlowOutput>) => setDraft((current) => ({ ...current, ...patch }));

  const sourceOptions = [
    ...(captureNames.length > 0
      ? [{
        group: 'Captured by a step',
        items: captureNames.map((name) => ({ value: `{{step.${name}}}`, label: name })),
      }]
      : []),
    ...(inputNames.length > 0
      ? [{
        group: 'Flow input',
        items: inputNames.map((name) => ({ value: `{{input.${name}}}`, label: name })),
      }]
      : []),
    { group: ' ', items: [{ value: CUSTOM, label: 'Custom template…' }] },
  ];

  return (
    <FormShell
      open={open}
      onClose={onClose}
      title={editing ? 'Edit output' : 'Add an output'}
      subtitle="Declared outputs are what a run returns — to an agent, to the API, to whoever called it."
      primaryAction={{
        label: editing ? 'Save output' : 'Add output',
        color: 'teal',
        loading: saving,
        onClick: () => onSubmit({
          ...draft,
          name: draft.name.trim(),
          source: draft.source.trim(),
        }),
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <FormSection title="Field">
        <FormRow cols={2}>
          <FormField label="Name" required hint="The key in the returned JSON.">
            <TextInput
              placeholder="total"
              value={draft.name}
              onChange={(event) => set({ name: event.currentTarget.value })}
            />
          </FormField>
          <FormField
            label="Type"
            optional
            hint="Left off, the value is returned exactly as captured."
          >
            <Select
              clearable
              placeholder="As captured"
              data={[
                { value: 'string', label: 'Text' },
                { value: 'number', label: 'Number' },
                { value: 'boolean', label: 'Boolean' },
                { value: 'json', label: 'JSON' },
              ]}
              value={draft.type ?? null}
              onChange={(value) => set({ type: (value as IBrowserFlowOutput['type']) ?? undefined })}
            />
          </FormField>
        </FormRow>

        <FormRow cols={1}>
          <FormField label="Value" required hint="Where the field reads from.">
            <Select
              data={sourceOptions}
              value={custom ? CUSTOM : (draft.source || null)}
              placeholder={captureNames.length === 0 ? 'No step captures a value yet' : 'Pick a captured value'}
              onChange={(value) => {
                if (value === CUSTOM) {
                  setCustom(true);
                  return;
                }
                setCustom(false);
                set({ source: value ?? '' });
              }}
            />
          </FormField>
        </FormRow>

        {custom ? (
          <FormRow cols={1}>
            <FormField label="Template" required hint="Mix literals with {{step.x}} and {{input.y}}.">
              <TextInput
                placeholder="{{step.first}} {{step.last}}"
                value={draft.source}
                onChange={(event) => set({ source: event.currentTarget.value })}
              />
            </FormField>
          </FormRow>
        ) : null}

        <FormRow cols={1}>
          <FormField
            label="Required"
            hint="A run that cannot resolve this field fails, even if every step passed."
          >
            <Switch
              checked={draft.required ?? false}
              onChange={(event) => set({ required: event.currentTarget.checked })}
            />
          </FormField>
        </FormRow>

        <FormRow cols={1}>
          <FormField label="Description" optional hint="Shown to an agent choosing between flows.">
            <Textarea
              autosize
              minRows={2}
              value={draft.description ?? ''}
              onChange={(event) => set({ description: event.currentTarget.value || undefined })}
            />
          </FormField>
        </FormRow>

        {captureNames.length === 0 ? (
          <Text size="xs" c="dimmed">
            Nothing is captured yet. Add a “Read value” step with a <b>Capture result as</b> name,
            then point an output at it.
          </Text>
        ) : null}
      </FormSection>
    </FormShell>
  );
}
