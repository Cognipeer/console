'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconClipboardText, IconPlus, IconTrash } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { AnalysisDefinitionView, AnalysisFieldType, ModelOption } from './types';

interface CreateDefinitionModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (definition: AnalysisDefinitionView) => void;
  models?: ModelOption[];
  /** When set, the modal edits this definition (PATCH) instead of creating one. */
  editing?: AnalysisDefinitionView | null;
}

interface FieldRow {
  key: string;
  type: AnalysisFieldType;
  required: boolean;
  enumValues: string;
}

const TYPE_OPTIONS = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'enum', label: 'Enum' },
];

const emptyField = (): FieldRow => ({ key: '', type: 'string', required: false, enumValues: '' });

export default function CreateDefinitionModal({ opened, onClose, onCreated, models = [], editing = null }: CreateDefinitionModalProps) {
  const isEdit = Boolean(editing);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [fields, setFields] = useState<FieldRow[]>([emptyField()]);
  const [extractionModelKey, setExtractionModelKey] = useState('');
  const [modeStore, setModeStore] = useState(true);
  const [modeAccuracy, setModeAccuracy] = useState(false);
  const [modeJudge, setModeJudge] = useState(false);
  const [judgeRubric, setJudgeRubric] = useState('');
  const [judgeModelKey, setJudgeModelKey] = useState('');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleCron, setScheduleCron] = useState('0 2 * * *');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) {
      setName(''); setDescription(''); setInstructions('');
      setFields([emptyField()]); setExtractionModelKey('');
      setModeStore(true); setModeAccuracy(false); setModeJudge(false);
      setJudgeRubric(''); setJudgeModelKey('');
      setScheduleEnabled(false); setScheduleCron('0 2 * * *'); setError(null);
      return;
    }
    if (editing) {
      setName(editing.name ?? '');
      setDescription(editing.description ?? '');
      setInstructions(editing.extractionInstructions ?? '');
      setFields(
        editing.fieldSet.length > 0
          ? editing.fieldSet.map((f) => ({
              key: f.key,
              type: f.type,
              required: Boolean(f.required),
              enumValues: (f.enumValues ?? []).join(', '),
            }))
          : [emptyField()],
      );
      setExtractionModelKey(editing.extractionModelKey ?? '');
      setModeStore(Boolean(editing.modes.store));
      setModeAccuracy(Boolean(editing.modes.accuracy));
      setModeJudge(Boolean(editing.modes.judge));
      setJudgeRubric(editing.modes.judge?.rubric ?? '');
      setJudgeModelKey(editing.judgeModelKey ?? '');
      setScheduleEnabled(Boolean(editing.schedule?.enabled));
      setScheduleCron(editing.schedule?.cron || '0 2 * * *');
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const updateField = (idx: number, patch: Partial<FieldRow>) => {
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };

  const handleSubmit = async () => {
    const cleanFields = fields.filter((f) => f.key.trim());
    if (!name.trim()) return setError('Name is required');
    if (cleanFields.length === 0) return setError('Add at least one field with a key');
    if (!extractionModelKey) return setError('An extraction model is required');
    if (modeJudge && !judgeRubric.trim()) return setError('A judge rubric is required when the judge mode is on');
    if (modeJudge && !judgeModelKey) return setError('A judge model is required when the judge mode is on');
    for (const f of cleanFields) {
      if (f.type === 'enum' && !f.enumValues.split(',').map((v) => v.trim()).filter(Boolean).length) {
        return setError(`Enum field "${f.key}" needs comma-separated values`);
      }
    }
    setError(null);
    setLoading(true);
    try {
      const fieldSet = cleanFields.map((f) => ({
        key: f.key.trim(),
        type: f.type,
        required: f.required || undefined,
        enumValues: f.type === 'enum' ? f.enumValues.split(',').map((v) => v.trim()).filter(Boolean) : undefined,
      }));
      const modes = {
        store: modeStore || undefined,
        accuracy: modeAccuracy || undefined,
        judge: modeJudge ? { rubric: judgeRubric.trim() } : undefined,
      };
      const res = await fetch(
        isEdit ? `/api/analysis/definitions/${editing!.id}` : '/api/analysis/definitions',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            description: description || undefined,
            fieldSet,
            extractionInstructions: instructions || undefined,
            modes,
            extractionModelKey,
            judgeModelKey: modeJudge ? judgeModelKey : undefined,
            schedule: scheduleEnabled ? { cron: scheduleCron.trim(), enabled: true } : { enabled: false, cron: scheduleCron.trim() },
          }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to ${isEdit ? 'update' : 'create'} definition`);
      }
      const data = await res.json();
      notifications.show({ title: isEdit ? 'Definition updated' : 'Definition created', message: `"${data.definition.name}" was ${isEdit ? 'updated' : 'created'}`, color: 'teal' });
      onCreated(data.definition);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to create', color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  const namedFields = useMemo(() => fields.filter((f) => f.key.trim()), [fields]);
  const validName = name.trim().length > 0;
  const validFields = namedFields.length > 0;
  const validModel = Boolean(extractionModelKey);
  const validJudge = !modeJudge || (judgeRubric.trim().length > 0 && Boolean(judgeModelKey));
  const canSubmit = validName && validFields && validModel && validJudge;

  const modeLabels = ['extract', modeStore ? 'store' : null, modeAccuracy ? 'accuracy' : null, modeJudge ? 'judge' : null]
    .filter(Boolean).join(', ');

  const checklist = [
    { id: 'name', label: 'Name provided', done: validName },
    { id: 'fields', label: `${namedFields.length} field(s) defined`, done: validFields },
    { id: 'model', label: 'Extraction model selected', done: validModel },
    { id: 'judge', label: modeJudge ? 'Judge rubric + model set' : 'Judge mode off', done: validJudge },
  ];

  const summary = (
    <SummaryGroup title="Definition">
      <SummaryKV label="Name" value={name || '—'} />
      <SummaryKV label="Fields" value={String(namedFields.length)} />
      <SummaryKV label="Modes" value={modeLabels} />
      <SummaryKV label="Model" value={extractionModelKey || '—'} />
      <SummaryKV label="Schedule" value={scheduleEnabled ? scheduleCron : 'manual'} />
      <Checklist items={checklist} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconClipboardText size={16} />}
      title={isEdit ? 'Edit analysis definition' : 'New analysis definition'}
      subtitle="Declare the fields to extract from conversations and which modes to apply."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Create definition',
        icon: <IconCheck size={13} />,
        loading,
        disabled: !canSubmit,
        onClick: () => void handleSubmit(),
      }}
    >
      <FormSection number={1} title="Identity" done={validName}>
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput placeholder="e.g. Call intent & resolution" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          </FormField>
          <FormField label="Description" optional>
            <Textarea placeholder="What does this analysis capture?" autosize minRows={1} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={2} title="Fields to extract" done={validFields}>
        <Stack gap="xs">
          {fields.map((f, idx) => (
            <Group key={idx} align="flex-end" gap="xs" wrap="nowrap">
              <TextInput label={idx === 0 ? 'Key' : undefined} placeholder="intent" style={{ flex: 1 }} value={f.key} onChange={(e) => updateField(idx, { key: e.currentTarget.value })} />
              <Select label={idx === 0 ? 'Type' : undefined} data={TYPE_OPTIONS} w={120} value={f.type} onChange={(v) => updateField(idx, { type: (v as AnalysisFieldType) ?? 'string' })} />
              {f.type === 'enum' && (
                <TextInput label={idx === 0 ? 'Values (comma-sep)' : undefined} placeholder="billing, support" style={{ flex: 1 }} value={f.enumValues} onChange={(e) => updateField(idx, { enumValues: e.currentTarget.value })} />
              )}
              <Checkbox label="Req" checked={f.required} onChange={(e) => updateField(idx, { required: e.currentTarget.checked })} mb={6} />
              <ActionIcon variant="subtle" color="red" mb={4} disabled={fields.length === 1} onClick={() => setFields((prev) => prev.filter((_, i) => i !== idx))}>
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          ))}
          <Button variant="light" size="xs" leftSection={<IconPlus size={14} />} onClick={() => setFields((prev) => [...prev, emptyField()])} style={{ alignSelf: 'flex-start' }}>
            Add field
          </Button>
        </Stack>
      </FormSection>

      <FormSection number={3} title="Extraction" done={validModel}>
        <FormField label="Extraction instructions" optional>
          <Textarea placeholder="Extra guidance for the extractor (optional)" autosize minRows={1} value={instructions} onChange={(e) => setInstructions(e.currentTarget.value)} />
        </FormField>
        <FormField label="Extraction model" required>
          <Select placeholder="Select a model…" data={models} searchable value={extractionModelKey} onChange={(v) => setExtractionModelKey(v ?? '')} />
        </FormField>
      </FormSection>

      <FormSection number={4} title="Modes" done={validJudge}>
        <Stack gap="xs">
          <Checkbox label="Store — write extracted fields back onto each conversation" checked={modeStore} onChange={(e) => setModeStore(e.currentTarget.checked)} />
          <Checkbox label="Accuracy — compare extracted fields against each conversation's reference fields" checked={modeAccuracy} onChange={(e) => setModeAccuracy(e.currentTarget.checked)} />
          <Checkbox label="Judge — grade conversation quality against a rubric" checked={modeJudge} onChange={(e) => setModeJudge(e.currentTarget.checked)} />
        </Stack>
        {modeJudge && (
          <>
            <FormField label="Judge rubric" required>
              <Textarea placeholder="What does a good conversation look like?" autosize minRows={2} value={judgeRubric} onChange={(e) => setJudgeRubric(e.currentTarget.value)} />
            </FormField>
            <FormField label="Judge model" required>
              <Select placeholder="Select a model…" data={models} searchable value={judgeModelKey} onChange={(v) => setJudgeModelKey(v ?? '')} />
            </FormField>
          </>
        )}
      </FormSection>

      <FormSection number={5} title="Schedule">
        <Checkbox label="Run automatically on a schedule" checked={scheduleEnabled} onChange={(e) => setScheduleEnabled(e.currentTarget.checked)} />
        {scheduleEnabled && (
          <FormField label="Cron expression (UTC)" hint="Standard 5-field cron, evaluated in UTC. Example: 0 2 * * * runs at 02:00 every day.">
            <TextInput placeholder="0 2 * * *" value={scheduleCron} onChange={(e) => setScheduleCron(e.currentTarget.value)} />
          </FormField>
        )}
        {error && <Alert color="red" variant="light" mt="sm">{error}</Alert>}
      </FormSection>
    </FormShell>
  );
}
