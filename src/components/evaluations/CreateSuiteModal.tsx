'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Group, Modal, Select, Stack, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle } from '@tabler/icons-react';
import type { EvalDatasetView, EvalScorerView, EvalSuiteView, EvalTargetView, ModelOption } from './types';

interface CreateSuiteModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (suite: EvalSuiteView) => void;
  targets: EvalTargetView[];
  datasets: EvalDatasetView[];
  models?: ModelOption[];
}

interface FormValues {
  name: string;
  description: string;
  targetKey: string;
  datasetKey: string;
  useAssertion: boolean;
  useJudge: boolean;
  rubric: string;
  judgeModelKey: string;
}

export default function CreateSuiteModal({ opened, onClose, onCreated, targets, datasets, models = [] }: CreateSuiteModalProps) {
  const [loading, setLoading] = useState(false);
  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      targetKey: '',
      datasetKey: '',
      useAssertion: true,
      useJudge: false,
      rubric: '',
      judgeModelKey: '',
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      targetKey: (v) => (!v ? 'A target is required' : null),
      datasetKey: (v) => (!v ? 'A dataset is required' : null),
      rubric: (v, values) => (values.useJudge && !v.trim() ? 'A rubric is required for the LLM judge' : null),
      judgeModelKey: (v, values) => (values.useJudge && !v ? 'A judge model is required for the LLM judge' : null),
      useAssertion: (v, values) => (!v && !values.useJudge ? 'Select at least one scorer' : null),
    },
  });

  useEffect(() => {
    if (!opened) form.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const handleSubmit = async () => {
    if (form.validate().hasErrors) return;
    const v = form.getValues();
    const scorers: EvalScorerView[] = [];
    if (v.useAssertion) scorers.push({ type: 'assertion' });
    if (v.useJudge) scorers.push({ type: 'llm-judge', rubric: v.rubric.trim() });
    setLoading(true);
    try {
      const res = await fetch('/api/evaluation/suites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: v.name.trim(),
          description: v.description || undefined,
          targetKey: v.targetKey,
          datasetKey: v.datasetKey,
          scorers,
          judgeModelKey: v.useJudge ? v.judgeModelKey : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create suite');
      }
      const data = await res.json();
      notifications.show({ title: 'Suite created', message: `"${data.suite.name}" was created`, color: 'teal' });
      onCreated(data.suite);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to create suite', color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  const targetOptions = targets.map((t) => ({ value: t.key, label: `${t.name} (${t.kind})` }));
  const datasetOptions = datasets.map((d) => ({ value: d.key, label: `${d.name} (${d.items.length} items)` }));
  const useJudge = form.getValues().useJudge;

  return (
    <Modal opened={opened} onClose={onClose} title="New evaluation suite" centered size="lg">
      <Stack gap="md">
        <TextInput label="Name" placeholder="e.g. FAQ accuracy suite" withAsterisk {...form.getInputProps('name')} />
        <Textarea label="Description" placeholder="What does this suite check?" autosize minRows={2} {...form.getInputProps('description')} />

        {targets.length === 0 || datasets.length === 0 ? (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
            Create at least one target and one dataset before defining a suite.
          </Alert>
        ) : null}

        <Select label="Target" placeholder="Select a target…" data={targetOptions} searchable withAsterisk {...form.getInputProps('targetKey')} />
        <Select label="Dataset" placeholder="Select a dataset…" data={datasetOptions} searchable withAsterisk {...form.getInputProps('datasetKey')} />

        <Checkbox
          label="Assertion scorer — checks expected values (contains / equals / regex / json-schema / json-path)"
          {...form.getInputProps('useAssertion', { type: 'checkbox' })}
        />
        <Checkbox
          label="LLM-judge scorer — grades output quality against a rubric"
          {...form.getInputProps('useJudge', { type: 'checkbox' })}
        />
        {form.errors.useAssertion ? <div style={{ color: 'var(--mantine-color-red-6)', fontSize: 12 }}>{form.errors.useAssertion}</div> : null}

        {useJudge && (
          <>
            <Textarea label="Judge rubric" placeholder="Describe what a good answer looks like." autosize minRows={3} withAsterisk {...form.getInputProps('rubric')} />
            <Select label="Judge model" placeholder="Select a model…" data={models} searchable withAsterisk {...form.getInputProps('judgeModelKey')} />
          </>
        )}

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button color="teal" loading={loading} onClick={handleSubmit}>Create suite</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
