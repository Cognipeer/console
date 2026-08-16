'use client';

import { useEffect, useState } from 'react';
import { Alert, Checkbox, Radio, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconChecklist, IconInfoCircle } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { EvalDatasetView, EvalScorerView, EvalSuiteView, EvalTargetView, ModelOption } from './types';

interface CreateSuiteModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (suite: EvalSuiteView) => void;
  targets: EvalTargetView[];
  datasets: EvalDatasetView[];
  models?: ModelOption[];
  /** When set, the modal edits this suite (PATCH) instead of creating one. */
  editing?: EvalSuiteView | null;
}

interface FormValues {
  name: string;
  description: string;
  targetKey: string;
  datasetKey: string;
  useAssertion: boolean;
  useJsonShape: boolean;
  useJudge: boolean;
  rubric: string;
  judgeModelKey: string;
  useSemantic: boolean;
  embeddingModelKey: string;
  turnMode: 'single' | 'perTurn';
}

export default function CreateSuiteModal({ opened, onClose, onCreated, targets, datasets, models = [], editing = null }: CreateSuiteModalProps) {
  const [loading, setLoading] = useState(false);
  const [embeddingModels, setEmbeddingModels] = useState<{ value: string; label: string }[]>([]);
  const isEdit = Boolean(editing);
  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      targetKey: '',
      datasetKey: '',
      useAssertion: true,
      useJsonShape: false,
      useJudge: false,
      rubric: '',
      judgeModelKey: '',
      useSemantic: false,
      embeddingModelKey: '',
      turnMode: 'single',
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      targetKey: (v) => (!v ? 'A target is required' : null),
      datasetKey: (v) => (!v ? 'A dataset is required' : null),
      rubric: (v, values) => (values.useJudge && !v.trim() ? 'A rubric is required for the LLM judge' : null),
      judgeModelKey: (v, values) => (values.useJudge && !v ? 'A judge model is required for the LLM judge' : null),
      embeddingModelKey: (v, values) => (values.useSemantic && !v ? 'An embedding model is required for semantic scoring' : null),
      useAssertion: (v, values) => (!v && !values.useJudge && !values.useSemantic && !values.useJsonShape ? 'Select at least one scorer' : null),
    },
  });

  useEffect(() => {
    if (!opened) {
      form.reset();
      return;
    }
    if (editing) {
      const judge = editing.scorers.find((s) => s.type === 'llm-judge');
      form.setValues({
        name: editing.name ?? '',
        description: editing.description ?? '',
        targetKey: editing.targetKey ?? '',
        datasetKey: editing.datasetKey ?? '',
        useAssertion: editing.scorers.some((s) => s.type === 'assertion'),
        useJsonShape: editing.scorers.some((s) => s.type === 'json-shape'),
        useJudge: Boolean(judge),
        rubric: judge?.rubric ?? '',
        judgeModelKey: editing.judgeModelKey ?? '',
        useSemantic: editing.scorers.some((s) => s.type === 'semantic'),
        embeddingModelKey: editing.embeddingModelKey ?? '',
        turnMode: editing.runConfig?.turnMode ?? 'single',
      });
    }
    void (async () => {
      try {
        const res = await fetch('/api/models?category=embedding', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setEmbeddingModels(((data.models ?? []) as Array<{ key: string; name: string }>).map((m) => ({ value: m.key, label: m.name })));
        }
      } catch {
        /* non-fatal */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const handleSubmit = async () => {
    if (form.validate().hasErrors) return;
    const v = form.getValues();
    const scorers: EvalScorerView[] = [];
    if (v.useAssertion) scorers.push({ type: 'assertion' });
    if (v.useJsonShape) scorers.push({ type: 'json-shape' });
    if (v.useJudge) scorers.push({ type: 'llm-judge', rubric: v.rubric.trim() });
    if (v.useSemantic) scorers.push({ type: 'semantic' });
    setLoading(true);
    try {
      const res = await fetch(
        isEdit ? `/api/evaluation/suites/${editing!.id}` : '/api/evaluation/suites',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: v.name.trim(),
            description: v.description || undefined,
            targetKey: v.targetKey,
            datasetKey: v.datasetKey,
            scorers,
            judgeModelKey: v.useJudge ? v.judgeModelKey : undefined,
            embeddingModelKey: v.useSemantic ? v.embeddingModelKey : undefined,
            runConfig: { turnMode: v.turnMode },
          }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to ${isEdit ? 'update' : 'create'} suite`);
      }
      const data = await res.json();
      notifications.show({ title: isEdit ? 'Suite updated' : 'Suite created', message: `"${data.suite.name}" was ${isEdit ? 'updated' : 'created'}`, color: 'teal' });
      onCreated(data.suite);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : `Failed to ${isEdit ? 'update' : 'create'} suite`, color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  const targetOptions = targets.map((t) => ({ value: t.key, label: `${t.name} (${t.kind})` }));
  const datasetOptions = datasets.map((d) => ({ value: d.key, label: `${d.name} (${d.itemCount} items)` }));

  const v = form.getValues();
  const useJudge = v.useJudge;
  const useSemantic = v.useSemantic;
  const validName = v.name.trim().length > 0;
  const validBinding = Boolean(v.targetKey) && Boolean(v.datasetKey);
  const anyScorer = v.useAssertion || v.useJudge || v.useSemantic || v.useJsonShape;
  const judgeOk = !v.useJudge || (v.rubric.trim().length > 0 && Boolean(v.judgeModelKey));
  const semanticOk = !v.useSemantic || Boolean(v.embeddingModelKey);
  const validScorers = anyScorer && judgeOk && semanticOk;
  const canSubmit = validName && validBinding && validScorers;

  const scorerLabels = [
    v.useAssertion ? 'assertion' : null,
    v.useJsonShape ? 'json-shape' : null,
    v.useJudge ? 'llm-judge' : null,
    v.useSemantic ? 'semantic' : null,
  ].filter(Boolean).join(', ') || '—';

  const checklist = [
    { id: 'name', label: 'Name provided', done: validName },
    { id: 'binding', label: 'Target + dataset selected', done: validBinding },
    { id: 'scorers', label: 'At least one scorer configured', done: validScorers },
  ];

  const summary = (
    <SummaryGroup title="Suite">
      <SummaryKV label="Name" value={v.name || '—'} />
      <SummaryKV label="Target" value={v.targetKey || '—'} />
      <SummaryKV label="Dataset" value={v.datasetKey || '—'} />
      <SummaryKV label="Scorers" value={scorerLabels} />
      <SummaryKV label="Replay" value={v.turnMode === 'perTurn' ? 'turn by turn' : 'single call'} />
      <Checklist items={checklist} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconChecklist size={16} />}
      title={isEdit ? 'Edit evaluation suite' : 'New evaluation suite'}
      subtitle="Bind a target to a dataset and pick the scorers that grade each result."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Create suite',
        icon: <IconCheck size={13} />,
        loading,
        disabled: !canSubmit,
        onClick: () => void handleSubmit(),
      }}
    >
      <FormSection number={1} title="Identity" done={validName}>
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput placeholder="e.g. FAQ accuracy suite" {...form.getInputProps('name')} />
          </FormField>
          <FormField label="Description" optional>
            <Textarea placeholder="What does this suite check?" autosize minRows={2} {...form.getInputProps('description')} />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={2} title="Target & dataset" done={validBinding}>
        {targets.length === 0 || datasets.length === 0 ? (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />} mb="sm">
            Create at least one target and one dataset before defining a suite.
          </Alert>
        ) : null}
        <FormRow cols={2}>
          <FormField label="Target" required>
            <Select placeholder="Select a target…" data={targetOptions} searchable {...form.getInputProps('targetKey')} />
          </FormField>
          <FormField label="Dataset" required>
            <Select placeholder="Select a dataset…" data={datasetOptions} searchable {...form.getInputProps('datasetKey')} />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={3} title="Scorers" done={validScorers}>
        <Stack gap="xs">
          <Checkbox
            label="Assertion scorer — checks expected values (contains / equals / regex / json-schema / json-path)"
            {...form.getInputProps('useAssertion', { type: 'checkbox' })}
          />
          <Checkbox
            label="LLM-judge scorer — grades output quality against a rubric"
            {...form.getInputProps('useJudge', { type: 'checkbox' })}
          />
          <Checkbox
            label="Semantic (vector) scorer — cosine similarity between the output and the expected reference answer"
            {...form.getInputProps('useSemantic', { type: 'checkbox' })}
          />
          <Checkbox
            label="JSON-shape scorer — when the reference answer is JSON, the output must have the same fields and types"
            description="Similarity scoring passes a reply that kept the gist but dropped required fields; this catches that."
            {...form.getInputProps('useJsonShape', { type: 'checkbox' })}
          />
          {form.errors.useAssertion ? <div style={{ color: 'var(--mantine-color-red-6)', fontSize: 12 }}>{form.errors.useAssertion}</div> : null}
        </Stack>

        {useJudge && (
          <>
            <FormField label="Judge rubric" required>
              <Textarea placeholder="Describe what a good answer looks like." autosize minRows={3} {...form.getInputProps('rubric')} />
            </FormField>
            <FormField label="Judge model" required>
              <Select placeholder="Select a model…" data={models} searchable {...form.getInputProps('judgeModelKey')} />
            </FormField>
          </>
        )}

        {useSemantic && (
          <>
            <FormField label="Embedding model" required hint="Used to embed both the output and the dataset item's expected reference for cosine similarity.">
              <Select placeholder="Select an embedding model…" data={embeddingModels} searchable {...form.getInputProps('embeddingModelKey')} />
            </FormField>
            <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
              Semantic scoring needs a gold answer per item: set <strong>expected.reference</strong> on your dataset items
              (the &quot;Expected answer&quot; column / field in the dataset editor).
            </Alert>
          </>
        )}
      </FormSection>

      <FormSection number={4} title="Replay" done>
        {/* The two modes measure different things, so this is a deliberate
            choice rather than a tuning knob — see EvaluationTurnMode. */}
        <Radio.Group {...form.getInputProps('turnMode')}>
          <Stack gap="sm">
            <Radio
              value="single"
              label="Single call — send the recorded conversation and grade one answer"
              description="Each decision is tested against the history production actually produced. Cheap, and the cleanest regression signal."
            />
            <Radio
              value="perTurn"
              label="Turn by turn — replay the conversation, feeding the model its own answers back"
              description="The only mode that catches drift: an agent can answer every turn correctly in isolation and still lose the thread once it is reading its own output. Costs one model call per user turn."
            />
          </Stack>
        </Radio.Group>
        <Text size="xs" c="dimmed" mt="xs">
          Single-turn datasets behave identically under both. Only the final answer is graded either way, so scores stay comparable.
        </Text>
      </FormSection>
    </FormShell>
  );
}
