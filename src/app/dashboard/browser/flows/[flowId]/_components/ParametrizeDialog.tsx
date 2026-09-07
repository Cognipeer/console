'use client';

/**
 * Turn a literal inside a step into a flow input.
 *
 * This is the move that makes a recorded flow reusable: the run that produced
 * it typed one username into one field, and the flow is only worth keeping if
 * the next run can type a different one. Doing it here — pick the field, name
 * the parameter — beats hand-editing `{{input.x}}` into a JSON payload,
 * because the dialog also declares the input, and a placeholder with no
 * declaration behind it resolves to nothing at 3am.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Code, Group, Radio, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type { IBrowserFlowInput, IBrowserFlowStep } from '@/lib/database';

/** Fields that address the element rather than carry a value. */
const TARGET_FIELDS = new Set(['type', 'ref', 'role', 'nth']);

export interface ParametrizableField {
  /** Key on the action, or `labels[0]` for the one array we support. */
  path: string;
  value: string;
}

/** The string fields of a step worth offering as parameters. */
export function parametrizableFields(step: IBrowserFlowStep): ParametrizableField[] {
  const action = step.action as Record<string, unknown>;
  const fields: ParametrizableField[] = [];

  for (const [key, value] of Object.entries(action)) {
    if (TARGET_FIELDS.has(key)) continue;
    if (typeof value === 'string' && value.length > 0) fields.push({ path: key, value });
    // `select` carries its option under `labels`, and that is exactly the kind
    // of value that changes per run.
    if (key === 'labels' && Array.isArray(value) && typeof value[0] === 'string') {
      fields.push({ path: 'labels[0]', value: value[0] });
    }
  }
  return fields;
}

/** Write `replacement` into the action at `path`, leaving everything else alone. */
export function applyToAction(
  action: Record<string, unknown>,
  path: string,
  replacement: string,
): Record<string, unknown> {
  if (path === 'labels[0]') {
    const labels = Array.isArray(action.labels) ? [...(action.labels as unknown[])] : [];
    labels[0] = replacement;
    return { ...action, labels };
  }
  return { ...action, [path]: replacement };
}

/** A name that reads like the thing it holds, and is a valid identifier. */
function suggestName(step: IBrowserFlowStep, path: string, taken: string[]): string {
  const action = step.action as Record<string, unknown>;
  const base = String(action.name ?? action.label ?? action.placeholder ?? action.testId ?? path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'value';
  const safe = /^[a-z_]/.test(base) ? base : `f_${base}`;
  let candidate = safe;
  let n = 2;
  while (taken.includes(candidate)) {
    candidate = `${safe}_${n}`;
    n += 1;
  }
  return candidate;
}

/** A field that looks like a credential should default to `secret`. */
function looksSecret(step: IBrowserFlowStep, path: string): boolean {
  const action = step.action as Record<string, unknown>;
  const haystack = `${action.name ?? ''} ${action.label ?? ''} ${action.placeholder ?? ''} ${action.testId ?? ''} ${path}`
    .toLowerCase();
  return /pass|şifre|sifre|secret|token|otp|pin|cvv/.test(haystack);
}

export default function ParametrizeDialog({
  open,
  step,
  inputs,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean;
  step: IBrowserFlowStep | null;
  inputs: IBrowserFlowInput[];
  saving: boolean;
  onClose: () => void;
  onSubmit: (change: {
    path: string;
    placeholder: string;
    newInput?: IBrowserFlowInput;
  }) => void;
}) {
  const fields = useMemo(() => (step ? parametrizableFields(step) : []), [step]);
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState('');
  const [type, setType] = useState<IBrowserFlowInput['type']>('string');
  const [required, setRequired] = useState(true);
  const [keepDefault, setKeepDefault] = useState(false);
  const [existing, setExisting] = useState('');

  // Seed on OPEN only. The parent rebuilds `inputs`/`fields` as it renders,
  // so an effect keyed on them runs constantly — and one that reseeds the
  // form would erase the name as it was being typed.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current && step) {
      setPath(fields[0]?.path ?? '');
      setMode('new');
      setExisting(inputs[0]?.name ?? '');
      setKeepDefault(false);
    }
    wasOpen.current = open;
  }, [open, step, fields, inputs]);

  // Re-suggest when the chosen FIELD changes — the name should describe the
  // value being lifted out, not whichever field was highlighted first. Guarded
  // the same way, so it never overwrites a name the user has edited.
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      lastPath.current = null;
      return;
    }
    if (!step || !path || lastPath.current === path) return;
    lastPath.current = path;
    setName(suggestName(step, path, inputs.map((item) => item.name)));
    setType(looksSecret(step, path) ? 'secret' : 'string');
    setRequired(true);
  }, [open, step, path, inputs]);

  const current = fields.find((field) => field.path === path);
  const literal = current?.value ?? '';
  const alreadyBound = literal.includes('{{');

  const submit = () => {
    if (!path) return;
    if (mode === 'existing') {
      if (!existing) return;
      onSubmit({ path, placeholder: `{{input.${existing}}}` });
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit({
      path,
      placeholder: `{{input.${trimmed}}}`,
      newInput: {
        name: trimmed,
        type,
        required,
        // A default on a secret would put the credential in the flow document.
        ...(keepDefault && type !== 'secret' ? { default: literal } : {}),
        description: `Value for ${path} of “${step?.label ?? 'step'}”.`,
      },
    });
  };

  return (
    <FormShell
      open={open}
      onClose={onClose}
      title="Parametrize a value"
      subtitle="The literal moves out of the flow and becomes something each run supplies."
      primaryAction={{ label: 'Parametrize', color: 'teal', loading: saving, onClick: submit }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <FormSection number={1} title="Which value">
        {fields.length === 0 ? (
          <Text size="sm" c="dimmed">This step carries no literal value to lift out.</Text>
        ) : (
          <Radio.Group value={path} onChange={setPath}>
            <Stack gap={6}>
              {fields.map((field) => (
                <Radio
                  key={field.path}
                  value={field.path}
                  label={(
                    <Group gap={8} wrap="nowrap">
                      <Badge size="xs" variant="light">{field.path}</Badge>
                      <Code style={{ fontSize: 11 }}>{field.value.slice(0, 80)}</Code>
                    </Group>
                  )}
                />
              ))}
            </Stack>
          </Radio.Group>
        )}
        {alreadyBound ? (
          <Text size="xs" c="orange">
            This field already references an input. Parametrizing it again replaces that reference.
          </Text>
        ) : null}
      </FormSection>

      <FormSection number={2} title="Bind it to">
        <Radio.Group value={mode} onChange={(value) => setMode(value as 'new' | 'existing')}>
          <Group gap="lg">
            <Radio value="new" label="A new input" />
            <Radio value="existing" label="An existing input" disabled={inputs.length === 0} />
          </Group>
        </Radio.Group>

        {mode === 'existing' ? (
          <FormRow cols={1}>
            <FormField label="Input" required>
              <Select
                data={inputs.map((item) => ({ value: item.name, label: `${item.name} · ${item.type}` }))}
                value={existing || null}
                onChange={(value) => setExisting(value ?? '')}
              />
            </FormField>
          </FormRow>
        ) : (
          <>
            <FormRow cols={2}>
              <FormField label="Name" required hint="Referenced as {{input.name}}.">
                <TextInput value={name} onChange={(event) => setName(event.currentTarget.value)} />
              </FormField>
              <FormField label="Type" required hint="A secret is never written to the run record.">
                <Select
                  data={[
                    { value: 'string', label: 'Text' },
                    { value: 'number', label: 'Number' },
                    { value: 'boolean', label: 'Boolean' },
                    { value: 'secret', label: 'Secret' },
                  ]}
                  value={type}
                  onChange={(value) => value && setType(value as IBrowserFlowInput['type'])}
                />
              </FormField>
            </FormRow>
            <FormRow cols={2}>
              <FormField label="Required">
                <Switch
                  checked={required}
                  onChange={(event) => setRequired(event.currentTarget.checked)}
                />
              </FormField>
              <FormField
                label="Keep this value as the default"
                hint={type === 'secret' ? 'Not available for secrets.' : 'A run that supplies nothing uses it.'}
              >
                <Switch
                  disabled={type === 'secret'}
                  checked={keepDefault && type !== 'secret'}
                  onChange={(event) => setKeepDefault(event.currentTarget.checked)}
                />
              </FormField>
            </FormRow>
          </>
        )}
      </FormSection>
    </FormShell>
  );
}
