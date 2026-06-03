'use client';

import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { AnalysisDefinitionView, AnalysisFieldType, ModelOption } from './types';

interface CreateDefinitionModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (definition: AnalysisDefinitionView) => void;
  models?: ModelOption[];
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

export default function CreateDefinitionModal({ opened, onClose, onCreated, models = [] }: CreateDefinitionModalProps) {
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) {
      setName(''); setDescription(''); setInstructions('');
      setFields([emptyField()]); setExtractionModelKey('');
      setModeStore(true); setModeAccuracy(false); setModeJudge(false);
      setJudgeRubric(''); setJudgeModelKey(''); setError(null);
    }
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
      const res = await fetch('/api/analysis/definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description || undefined,
          fieldSet,
          extractionInstructions: instructions || undefined,
          modes,
          extractionModelKey,
          judgeModelKey: modeJudge ? judgeModelKey : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create definition');
      }
      const data = await res.json();
      notifications.show({ title: 'Definition created', message: `"${data.definition.name}" was created`, color: 'teal' });
      onCreated(data.definition);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to create', color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="New analysis definition" centered size="xl">
      <Stack gap="md">
        <TextInput label="Name" placeholder="e.g. Call intent & resolution" withAsterisk value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Textarea label="Description" placeholder="What does this analysis capture?" autosize minRows={1} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />

        <Divider label="Fields to extract" labelPosition="left" />
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

        <Textarea label="Extraction instructions" placeholder="Extra guidance for the extractor (optional)" autosize minRows={1} value={instructions} onChange={(e) => setInstructions(e.currentTarget.value)} />
        <Select label="Extraction model" placeholder="Select a model…" data={models} searchable withAsterisk value={extractionModelKey} onChange={(v) => setExtractionModelKey(v ?? '')} />

        <Divider label="Modes" labelPosition="left" />
        <Checkbox label="Store — write extracted fields back onto each conversation" checked={modeStore} onChange={(e) => setModeStore(e.currentTarget.checked)} />
        <Checkbox label="Accuracy — compare extracted fields against each conversation's reference fields" checked={modeAccuracy} onChange={(e) => setModeAccuracy(e.currentTarget.checked)} />
        <Checkbox label="Judge — grade conversation quality against a rubric" checked={modeJudge} onChange={(e) => setModeJudge(e.currentTarget.checked)} />
        {modeJudge && (
          <>
            <Textarea label="Judge rubric" placeholder="What does a good conversation look like?" autosize minRows={2} withAsterisk value={judgeRubric} onChange={(e) => setJudgeRubric(e.currentTarget.value)} />
            <Select label="Judge model" placeholder="Select a model…" data={models} searchable withAsterisk value={judgeModelKey} onChange={(v) => setJudgeModelKey(v ?? '')} />
          </>
        )}

        {error && <Text c="red" size="sm">{error}</Text>}
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button color="teal" loading={loading} onClick={handleSubmit}>Create definition</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
