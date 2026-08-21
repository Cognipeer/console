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
  /** Retrieval scorers — all embedding-backed, all need a Knowledge Engine target. */
  useContextRecall: boolean;
  useContextPrecision: boolean;
  useGroundedness: boolean;
  embeddingModelKey: string;
  turnMode: 'single' | 'perTurn';
}

/** Scorers that grade retrieval, and so need a target that reports its chunks. */
function usesRetrieval(v: Pick<FormValues, 'useContextRecall' | 'useContextPrecision' | 'useGroundedness'>): boolean {
  return v.useContextRecall || v.useContextPrecision || v.useGroundedness;
}

/** Scorers that compare embeddings, and so need an embedding model. */
function usesEmbedding(v: Pick<FormValues, 'useSemantic' | 'useContextRecall' | 'useContextPrecision' | 'useGroundedness'>): boolean {
  return v.useSemantic || usesRetrieval(v);
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
      useContextRecall: false,
      useContextPrecision: false,
      useGroundedness: false,
      embeddingModelKey: '',
      turnMode: 'single',
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      targetKey: (v) => (!v ? 'A target is required' : null),
      datasetKey: (v) => (!v ? 'A dataset is required' : null),
      rubric: (v, values) => (values.useJudge && !v.trim() ? 'A rubric is required for the LLM judge' : null),
      judgeModelKey: (v, values) => (values.useJudge && !v ? 'A judge model is required for the LLM judge' : null),
      embeddingModelKey: (v, values) => (usesEmbedding(values) && !v ? 'An embedding model is required for embedding-backed scoring' : null),
      useAssertion: (v, values) => (
        !v && !values.useJudge && !values.useJsonShape && !usesEmbedding(values) ? 'Select at least one scorer' : null
      ),
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
        useContextRecall: editing.scorers.some((s) => s.type === 'context-recall'),
        useContextPrecision: editing.scorers.some((s) => s.type === 'context-precision'),
        useGroundedness: editing.scorers.some((s) => s.type === 'groundedness'),
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
    if (v.useContextRecall) scorers.push({ type: 'context-recall' });
    if (v.useContextPrecision) scorers.push({ type: 'context-precision' });
    if (v.useGroundedness) scorers.push({ type: 'groundedness' });
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
            embeddingModelKey: usesEmbedding(v) ? v.embeddingModelKey : undefined,
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
  const needsEmbedding = usesEmbedding(v);
  const validName = v.name.trim().length > 0;
  const validBinding = Boolean(v.targetKey) && Boolean(v.datasetKey);
  const anyScorer = v.useAssertion || v.useJudge || v.useJsonShape || needsEmbedding;
  const judgeOk = !v.useJudge || (v.rubric.trim().length > 0 && Boolean(v.judgeModelKey));
  const embeddingOk = !needsEmbedding || Boolean(v.embeddingModelKey);
  const validScorers = anyScorer && judgeOk && embeddingOk;
  // A retrieval scorer needs a target that reports the chunks it retrieved;
  // pointed at anything else every item errors out at run time.
  const targetKind = targets.find((t) => t.key === v.targetKey)?.kind;
  const retrievalTargetMismatch = usesRetrieval(v) && Boolean(v.targetKey) && targetKind !== 'rag';
  // Retrieval answers one query per item — there is no conversation to walk,
  // and the run would pay for a query per turn to grade only the last one.
  const isRetrievalTarget = targetKind === 'rag';
  const turnModeConflict = isRetrievalTarget && v.turnMode === 'perTurn';
  const canSubmit = validName && validBinding && validScorers && !turnModeConflict;

  const scorerLabels = [
    v.useAssertion ? 'assertion' : null,
    v.useJsonShape ? 'json-shape' : null,
    v.useJudge ? 'llm-judge' : null,
    v.useSemantic ? 'semantic' : null,
    v.useContextRecall ? 'context-recall' : null,
    v.useContextPrecision ? 'context-precision' : null,
    v.useGroundedness ? 'groundedness' : null,
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
          <Checkbox
            label="Context recall — is the expected answer covered by the retrieved passages?"
            description="Retrieval targets. Each claim in the gold answer is scored by its closest retrieved passage, so a half-covered answer reads as half recalled."
            {...form.getInputProps('useContextRecall', { type: 'checkbox' })}
          />
          <Checkbox
            label="Context precision — how much of what was retrieved was relevant, weighted by rank"
            description="Retrieval targets. A relevant passage at rank 1 counts for more than the same passage at rank 10 — that is the one the generator actually reads."
            {...form.getInputProps('useContextPrecision', { type: 'checkbox' })}
          />
          <Checkbox
            label="Groundedness — is the answer supported by the retrieved passages?"
            description="Retrieval targets. Perfect context still produces a hallucination when the generator answers from its own weights instead."
            {...form.getInputProps('useGroundedness', { type: 'checkbox' })}
          />
          {form.errors.useAssertion ? <div style={{ color: 'var(--mantine-color-red-6)', fontSize: 12 }}>{form.errors.useAssertion}</div> : null}
        </Stack>

        {retrievalTargetMismatch && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />} mt="sm">
            The retrieval scorers grade the passages a target retrieved, and the selected target does not retrieve.
            Point this suite at a Knowledge Engine target, or drop those scorers — otherwise every item records a
            scorer error.
          </Alert>
        )}

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

        {needsEmbedding && (
          <>
            <FormField label="Embedding model" required hint="Backs every scorer that compares meaning instead of characters — semantic similarity and all three retrieval scorers.">
              <Select placeholder="Select an embedding model…" data={embeddingModels} searchable {...form.getInputProps('embeddingModelKey')} />
            </FormField>
            {(v.useSemantic || v.useContextRecall || v.useContextPrecision) && (
              <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
                These scorers need a gold answer per item: set <strong>expected.reference</strong> on your dataset items
                (the &quot;Expected answer&quot; column / field in the dataset editor).
              </Alert>
            )}
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
              disabled={isRetrievalTarget}
              label="Turn by turn — replay the conversation, feeding the model its own answers back"
              description="The only mode that catches drift: an agent can answer every turn correctly in isolation and still lose the thread once it is reading its own output. Costs one model call per user turn."
            />
          </Stack>
        </Radio.Group>
        {turnModeConflict && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />} mt="sm">
            This suite is set to replay turn by turn, which a Knowledge Engine target does not support. Switch to a
            single call to save it.
          </Alert>
        )}
        <Text size="xs" c="dimmed" mt="xs">
          {isRetrievalTarget
            ? 'A Knowledge Engine target answers one query per item, so turn-by-turn replay does not apply — runs that ask for it are rejected.'
            : 'Single-turn datasets behave identically under both. Only the final answer is graded either way, so scores stay comparable.'}
        </Text>
      </FormSection>
    </FormShell>
  );
}
