'use client';

/**
 * Add or edit one step by hand.
 *
 * The composer beside the live page is the fast path — this is the one for
 * everything it cannot express: a step written before the page exists, a
 * target that needs a `testId` because role+name is ambiguous, a retry policy,
 * a `when` guard. It is a form rather than a live action, so nothing here
 * touches the browser: it edits the flow.
 */

import { useEffect, useRef, useState } from 'react';
import { NumberInput, Select, Switch, Text, TextInput } from '@mantine/core';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type { IBrowserFlowStep } from '@/lib/database';
import { ACTION_TYPES, TARGETED } from '../../../_workbench/actions';

export interface StepDraft {
  type: string;
  role: string;
  name: string;
  testId: string;
  label: string;
  placeholder: string;
  selector: string;
  nth: string;
  url: string;
  key: string;
  value: string;
  ms: string;
  waitText: string;
  scrollY: string;
  checked: boolean;
  captureAs: string;
  when: string;
  retries: number;
  timeoutMs: string;
  optional: boolean;
}

export const EMPTY_STEP: StepDraft = {
  type: 'click',
  role: '', name: '', testId: '', label: '', placeholder: '', selector: '', nth: '',
  url: '', key: '', value: '', ms: '', waitText: '', scrollY: '', checked: true,
  captureAs: '', when: '', retries: 0, timeoutMs: '', optional: false,
};

const str = (value: unknown) => (value === undefined || value === null ? '' : String(value));

/** Read an existing step back into the flat draft the form edits. */
export function stepToDraft(step: IBrowserFlowStep): StepDraft {
  const action = step.action as Record<string, unknown>;
  const type = str(action.type) || 'click';
  return {
    ...EMPTY_STEP,
    type,
    role: str(action.role),
    name: str(action.name),
    testId: str(action.testId),
    label: str(action.label),
    placeholder: str(action.placeholder),
    selector: str(action.selector),
    nth: str(action.nth),
    url: str(action.url),
    key: str(action.key),
    value: type === 'type'
      ? str(action.text)
      : type === 'select'
        ? str(Array.isArray(action.labels) ? action.labels[0] : action.values)
        : '',
    ms: str(action.ms),
    waitText: type === 'wait' ? str(action.text) : '',
    scrollY: str(action.y),
    checked: action.checked !== false,
    captureAs: step.captureAs ?? '',
    when: step.when ?? '',
    retries: step.policy?.retries ?? 0,
    timeoutMs: str(step.policy?.timeoutMs),
    optional: step.policy?.optional ?? false,
  };
}

/** Turn the flat draft into the action payload the API accepts. */
export function draftToAction(draft: StepDraft): Record<string, unknown> {
  const action: Record<string, unknown> = { type: draft.type };

  if (TARGETED.has(draft.type)) {
    if (draft.role.trim()) action.role = draft.role.trim();
    if (draft.name.trim()) action.name = draft.name.trim();
    if (draft.testId.trim()) action.testId = draft.testId.trim();
    if (draft.label.trim()) action.label = draft.label.trim();
    if (draft.placeholder.trim()) action.placeholder = draft.placeholder.trim();
    if (draft.selector.trim()) action.selector = draft.selector.trim();
    if (draft.nth.trim()) action.nth = Number(draft.nth);
  }

  if (draft.type === 'goto') action.url = draft.url.trim();
  if (draft.type === 'press') action.key = draft.key.trim();
  if (draft.type === 'type') action.text = draft.value;
  if (draft.type === 'select') action.labels = [draft.value];
  if (draft.type === 'check') action.checked = draft.checked;
  if (draft.type === 'scroll' && draft.scrollY.trim()) action.y = Number(draft.scrollY);
  if (draft.type === 'wait') {
    if (draft.waitText.trim()) action.text = draft.waitText.trim();
    else if (draft.ms.trim()) action.ms = Number(draft.ms);
    else if (draft.selector.trim()) action.selector = draft.selector.trim();
  }

  return action;
}

export function draftToStep(draft: StepDraft, existing?: IBrowserFlowStep): IBrowserFlowStep {
  return {
    id: existing?.id ?? '',
    label: existing?.label,
    action: draftToAction(draft),
    captureAs: draft.captureAs.trim() || undefined,
    when: draft.when.trim() || undefined,
    policy: {
      ...(draft.retries ? { retries: draft.retries } : {}),
      ...(draft.timeoutMs.trim() ? { timeoutMs: Number(draft.timeoutMs) } : {}),
      ...(draft.optional ? { optional: true } : {}),
    },
  };
}

export default function StepDialog({
  open,
  initial,
  editing,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initial: StepDraft;
  editing: boolean;
  saving: boolean;
  onClose: () => void;
  onSubmit: (draft: StepDraft) => void;
}) {
  const [draft, setDraft] = useState<StepDraft>(initial);
  // Seed on OPEN only — reseeding on every render would wipe each keystroke.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setDraft(initial);
    wasOpen.current = open;
  }, [open, initial]);

  const set = (patch: Partial<StepDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const targeted = TARGETED.has(draft.type);

  return (
    <FormShell
      open={open}
      onClose={onClose}
      title={editing ? 'Edit step' : 'Add a step'}
      subtitle="Values may reference {{input.name}} and {{step.captureAs}}."
      primaryAction={{
        label: editing ? 'Save step' : 'Add step',
        color: 'teal',
        loading: saving,
        onClick: () => onSubmit(draft),
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <FormSection number={1} title="What it does">
        <FormRow cols={2}>
          <FormField label="Action" required>
            <Select
              data={ACTION_TYPES}
              value={draft.type}
              onChange={(value) => value && set({ type: value })}
            />
          </FormField>
          {draft.type === 'goto' ? (
            <FormField label="URL" required>
              <TextInput
                placeholder="https://example.com/{{input.path}}"
                value={draft.url}
                onChange={(event) => set({ url: event.currentTarget.value })}
              />
            </FormField>
          ) : null}
          {draft.type === 'type' || draft.type === 'select' ? (
            <FormField
              label={draft.type === 'type' ? 'Text' : 'Option label'}
              hint="A literal here is stored in the flow — use {{input.x}} for anything per-run or secret."
            >
              <TextInput
                placeholder="{{input.username}}"
                value={draft.value}
                onChange={(event) => set({ value: event.currentTarget.value })}
              />
            </FormField>
          ) : null}
          {draft.type === 'press' ? (
            <FormField label="Key" required>
              <TextInput
                placeholder="Enter"
                value={draft.key}
                onChange={(event) => set({ key: event.currentTarget.value })}
              />
            </FormField>
          ) : null}
          {draft.type === 'check' ? (
            <FormField label="State">
              <Switch
                label={draft.checked ? 'Check it' : 'Uncheck it'}
                checked={draft.checked}
                onChange={(event) => set({ checked: event.currentTarget.checked })}
              />
            </FormField>
          ) : null}
          {draft.type === 'scroll' ? (
            <FormField label="Scroll down (px)">
              <TextInput
                placeholder="600"
                value={draft.scrollY}
                onChange={(event) => set({ scrollY: event.currentTarget.value })}
              />
            </FormField>
          ) : null}
        </FormRow>

        {draft.type === 'wait' ? (
          <FormRow cols={2}>
            <FormField label="Until text appears" optional>
              <TextInput
                value={draft.waitText}
                onChange={(event) => set({ waitText: event.currentTarget.value })}
              />
            </FormField>
            <FormField label="Or wait (ms)" optional>
              <TextInput
                placeholder="1000"
                value={draft.ms}
                onChange={(event) => set({ ms: event.currentTarget.value })}
              />
            </FormField>
          </FormRow>
        ) : null}
      </FormSection>

      {targeted ? (
        <FormSection
          number={2}
          title="Which element"
          description="Role and accessible name first — they survive a redesign that a CSS selector does not."
        >
          <FormRow cols={2}>
            <FormField label="Role" optional>
              <TextInput
                placeholder="button"
                value={draft.role}
                onChange={(event) => set({ role: event.currentTarget.value })}
              />
            </FormField>
            <FormField label="Accessible name" optional>
              <TextInput
                placeholder="Sign in"
                value={draft.name}
                onChange={(event) => set({ name: event.currentTarget.value })}
              />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label="Test id" optional>
              <TextInput
                placeholder="submit-btn"
                value={draft.testId}
                onChange={(event) => set({ testId: event.currentTarget.value })}
              />
            </FormField>
            <FormField label="Form label" optional>
              <TextInput
                placeholder="Username"
                value={draft.label}
                onChange={(event) => set({ label: event.currentTarget.value })}
              />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label="Placeholder" optional>
              <TextInput
                value={draft.placeholder}
                onChange={(event) => set({ placeholder: event.currentTarget.value })}
              />
            </FormField>
            <FormField label="Nth match" optional hint="Only when the target above matches several elements.">
              <TextInput
                placeholder="0"
                value={draft.nth}
                onChange={(event) => set({ nth: event.currentTarget.value })}
              />
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label="CSS selector" optional hint="Last resort — it encodes markup nobody promised to keep.">
              <TextInput
                placeholder="#submit"
                value={draft.selector}
                onChange={(event) => set({ selector: event.currentTarget.value })}
              />
            </FormField>
          </FormRow>
        </FormSection>
      ) : null}

      <FormSection number={targeted ? 3 : 2} title="Result and recovery" collapsible defaultOpen={false}>
        <FormRow cols={2}>
          <FormField
            label="Capture result as"
            optional
            hint="Names the value for {{step.x}} and for the flow's declared outputs."
          >
            <TextInput
              placeholder="total"
              value={draft.captureAs}
              onChange={(event) => set({ captureAs: event.currentTarget.value })}
            />
          </FormField>
          <FormField label="Run only when" optional hint="Skipped unless this resolves to something truthy.">
            <TextInput
              placeholder="{{input.withReceipt}}"
              value={draft.when}
              onChange={(event) => set({ when: event.currentTarget.value })}
            />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField label="Retries" hint="Delay doubles between attempts.">
            <NumberInput
              min={0}
              max={10}
              value={draft.retries}
              onChange={(value) => set({ retries: Number(value) || 0 })}
            />
          </FormField>
          <FormField label="Timeout (ms)" optional>
            <TextInput
              placeholder="15000"
              value={draft.timeoutMs}
              onChange={(event) => set({ timeoutMs: event.currentTarget.value })}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Optional" hint="A failing optional step is recorded and skipped instead of aborting the run.">
            <Switch
              checked={draft.optional}
              onChange={(event) => set({ optional: event.currentTarget.checked })}
            />
          </FormField>
        </FormRow>
        <Text size="xs" c="dimmed">
          A step may not store a snapshot `ref`. Targets picked from the Elements list are already
          converted to their durable form.
        </Text>
      </FormSection>
    </FormShell>
  );
}
