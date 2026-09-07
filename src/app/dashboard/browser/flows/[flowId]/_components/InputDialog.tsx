'use client';

/** Declare or edit one flow input — the values a run supplies. */

import { useEffect, useRef, useState } from 'react';
import { Select, Switch, TextInput, Textarea } from '@mantine/core';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type { IBrowserFlowInput } from '@/lib/database';

export const EMPTY_INPUT: IBrowserFlowInput = { name: '', type: 'string', required: true };

export default function InputDialog({
  open,
  initial,
  editing,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initial: IBrowserFlowInput;
  editing: boolean;
  saving: boolean;
  onClose: () => void;
  onSubmit: (input: IBrowserFlowInput) => void;
}) {
  const [draft, setDraft] = useState<IBrowserFlowInput>(initial);
  // Seed on OPEN only — reseeding on every render would wipe each keystroke.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setDraft(initial);
    wasOpen.current = open;
  }, [open, initial]);

  const set = (patch: Partial<IBrowserFlowInput>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <FormShell
      open={open}
      onClose={onClose}
      title={editing ? 'Edit input' : 'Add flow input'}
      subtitle="Inputs are supplied per run and referenced from steps as {{input.name}}."
      primaryAction={{
        label: editing ? 'Save input' : 'Add input',
        color: 'teal',
        loading: saving,
        onClick: () => onSubmit({ ...draft, name: draft.name.trim() }),
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <FormSection title="Definition">
        <FormRow cols={2}>
          <FormField label="Name" required hint="Used as {{input.name}}. Letters, digits and underscores.">
            <TextInput
              placeholder="reference"
              value={draft.name}
              onChange={(event) => set({ name: event.currentTarget.value })}
            />
          </FormField>
          <FormField label="Type" required hint="A secret is never written to the run record.">
            <Select
              data={[
                { value: 'string', label: 'Text' },
                { value: 'number', label: 'Number' },
                { value: 'boolean', label: 'Boolean' },
                { value: 'secret', label: 'Secret' },
              ]}
              value={draft.type}
              onChange={(value) => value && set({
                type: value as IBrowserFlowInput['type'],
                // A default on a secret would be a credential stored in the
                // flow document, readable by anyone who can see the flow.
                default: value === 'secret' ? undefined : draft.default,
              })}
            />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField label="Required">
            <Switch
              checked={draft.required ?? false}
              onChange={(event) => set({ required: event.currentTarget.checked })}
            />
          </FormField>
          <FormField label="Default" optional hint={draft.type === 'secret' ? 'Not available for secrets.' : undefined}>
            <TextInput
              disabled={draft.type === 'secret'}
              value={draft.default === undefined ? '' : String(draft.default)}
              onChange={(event) => set({ default: event.currentTarget.value || undefined })}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Label" optional hint="Shown instead of the name on the run form.">
            <TextInput
              value={draft.label ?? ''}
              onChange={(event) => set({ label: event.currentTarget.value || undefined })}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              autosize
              minRows={2}
              value={draft.description ?? ''}
              onChange={(event) => set({ description: event.currentTarget.value || undefined })}
            />
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}
