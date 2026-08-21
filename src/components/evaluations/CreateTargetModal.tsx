'use client';

import { useEffect, useState } from 'react';
import { Alert, NumberInput, SegmentedControl, Select, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconInfoCircle, IconRobot } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { EvalTargetView, ModelOption } from './types';

interface CreateTargetModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (target: EvalTargetView) => void;
  models?: ModelOption[];
  /** When set, the modal edits this target (PATCH) instead of creating one. */
  editing?: EvalTargetView | null;
}

interface FormValues {
  name: string;
  description: string;
  kind: 'agent' | 'model' | 'external' | 'rag';
  modelKey: string;
  agentKey: string;
  /** Retrieval targets: which Knowledge Engine module to query, and how much. */
  ragModuleKey: string;
  retrievalTopK: number | '';
  retrievalMinScore: number | '';
  /** 'none' keeps whatever system turn the dataset items carry. */
  promptMode: 'none' | 'promptKey' | 'inline';
  promptKey: string;
  systemPrompt: string;
  /** Structured-output contract the target sends, mirroring production. */
  responseMode: 'none' | 'json_object' | 'json_schema';
  jsonSchema: string;
  maxTokens: number | '';
}

const KIND_OPTIONS = [
  { value: 'model', label: 'Model — a registered model' },
  { value: 'agent', label: 'Agent — a registered agent' },
  { value: 'rag', label: 'Knowledge Engine — retrieval from a module' },
  { value: 'external', label: 'External — an HTTP endpoint' },
];

const KIND_LABEL: Record<string, string> = { model: 'Model', agent: 'Agent', rag: 'Knowledge Engine module', external: 'External' };

/** What a target's primary reference is called, per kind. */
function referenceLabel(kind: FormValues['kind']): string {
  return kind === 'agent' ? 'Agent' : kind === 'rag' ? 'Knowledge Engine module' : 'Model';
}

/** The reference itself, for the summary panel. */
function referenceValue(v: FormValues): string {
  return (v.kind === 'agent' ? v.agentKey : v.kind === 'rag' ? v.ragModuleKey : v.modelKey) || '—';
}

/** Assemble the OpenAI-shaped response_format the target will send. */
function buildResponseFormat(v: FormValues): Record<string, unknown> | undefined {
  if (v.responseMode === 'none') return undefined;
  if (v.responseMode === 'json_object') return { type: 'json_object' };
  try {
    return { type: 'json_schema', json_schema: { name: 'evaluation_output', strict: true, schema: JSON.parse(v.jsonSchema) } };
  } catch {
    return undefined;
  }
}

export default function CreateTargetModal({ opened, onClose, onCreated, models = [], editing = null }: CreateTargetModalProps) {
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<{ value: string; label: string }[]>([]);
  const [prompts, setPrompts] = useState<{ value: string; label: string }[]>([]);
  const [ragModules, setRagModules] = useState<{ value: string; label: string }[]>([]);
  const isEdit = Boolean(editing);
  const form = useForm<FormValues>({
    initialValues: {
      name: '', description: '', kind: 'model', modelKey: '', agentKey: '',
      ragModuleKey: '', retrievalTopK: '', retrievalMinScore: '',
      promptMode: 'none', promptKey: '', systemPrompt: '',
      responseMode: 'none', jsonSchema: '', maxTokens: '',
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      modelKey: (v, values) => (values.kind === 'model' && !v ? 'A model is required for model targets' : null),
      agentKey: (v, values) => (values.kind === 'agent' && !v.trim() ? 'An agent key is required for agent targets' : null),
      ragModuleKey: (v, values) => (values.kind === 'rag' && !v ? 'A Knowledge Engine module is required for retrieval targets' : null),
      promptKey: (v, values) => (values.promptMode === 'promptKey' && !v ? 'Select a prompt' : null),
      systemPrompt: (v, values) => (values.promptMode === 'inline' && !v.trim() ? 'Enter a system prompt' : null),
      jsonSchema: (v, values) => {
        if (values.responseMode !== 'json_schema') return null;
        if (!v.trim()) return 'Paste the JSON schema';
        try { JSON.parse(v); return null; } catch { return 'Not valid JSON'; }
      },
    },
  });

  useEffect(() => {
    if (!opened) {
      form.reset();
      return;
    }
    if (editing) {
      form.setValues({
        name: editing.name ?? '',
        description: editing.description ?? '',
        kind: editing.kind,
        modelKey: editing.modelKey ?? '',
        agentKey: editing.agentKey ?? '',
        ragModuleKey: editing.ragModuleKey ?? '',
        retrievalTopK: editing.retrievalTopK ?? '',
        retrievalMinScore: editing.retrievalMinScore ?? '',
        promptMode: editing.promptKey ? 'promptKey' : editing.systemPrompt ? 'inline' : 'none',
        promptKey: editing.promptKey ?? '',
        systemPrompt: editing.systemPrompt ?? '',
        responseMode: (editing.responseFormat?.type as FormValues['responseMode']) ?? 'none',
        jsonSchema: editing.responseFormat?.json_schema
          ? JSON.stringify(editing.responseFormat.json_schema, null, 2)
          : '',
        maxTokens: editing.maxTokens ?? '',
      });
    }
    void (async () => {
      try {
        const res = await fetch('/api/agents', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setAgents(((data.agents ?? []) as Array<{ key: string; name: string }>).map((a) => ({ value: a.key, label: a.name })));
        }
      } catch {
        /* non-fatal — agent dropdown stays empty */
      }
      try {
        const res = await fetch('/api/prompts', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setPrompts(((data.prompts ?? []) as Array<{ key: string; name: string }>).map((p) => ({ value: p.key, label: p.name })));
        }
      } catch {
        /* non-fatal — prompt dropdown stays empty */
      }
      try {
        const res = await fetch('/api/rag/modules', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setRagModules(((data.modules ?? []) as Array<{ key: string; name: string }>).map((m) => ({ value: m.key, label: m.name })));
        }
      } catch {
        /* non-fatal — Knowledge Engine dropdown stays empty */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const handleSubmit = async () => {
    if (form.validate().hasErrors) return;
    const v = form.getValues();
    setLoading(true);
    try {
      const payload = {
        name: v.name.trim(),
        description: v.description || undefined,
        modelKey: v.kind === 'model' ? v.modelKey : undefined,
        agentKey: v.kind === 'agent' ? v.agentKey.trim() : undefined,
        ragModuleKey: v.kind === 'rag' ? v.ragModuleKey : undefined,
        // Left empty, the module's own defaultTopK / defaultMinScore apply —
        // which is what a suite should test unless it is testing the knobs.
        retrievalTopK: v.kind === 'rag' && typeof v.retrievalTopK === 'number' ? v.retrievalTopK : undefined,
        retrievalMinScore: v.kind === 'rag' && typeof v.retrievalMinScore === 'number' ? v.retrievalMinScore : undefined,
        // Override is model-only; sending it for an agent target would be
        // rejected at run time (an agent always runs its published prompt).
        promptKey: v.kind === 'model' && v.promptMode === 'promptKey' ? v.promptKey : undefined,
        systemPrompt: v.kind === 'model' && v.promptMode === 'inline' ? v.systemPrompt : undefined,
        responseFormat: v.kind === 'model' ? buildResponseFormat(v) : undefined,
        maxTokens: v.kind === 'model' && typeof v.maxTokens === 'number' ? v.maxTokens : undefined,
      };
      const res = await fetch(
        isEdit ? `/api/evaluation/targets/${editing!.id}` : '/api/evaluation/targets',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isEdit ? payload : { ...payload, kind: v.kind }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to ${isEdit ? 'update' : 'create'} target`);
      }
      const data = await res.json();
      notifications.show({ title: isEdit ? 'Target updated' : 'Target created', message: `"${data.target.name}" was ${isEdit ? 'updated' : 'created'}`, color: 'teal' });
      onCreated(data.target);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : `Failed to ${isEdit ? 'update' : 'create'} target`, color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  const v = form.getValues();
  const kind = v.kind;
  const validName = v.name.trim().length > 0;
  const validRef = kind === 'model' ? Boolean(v.modelKey)
    : kind === 'agent' ? v.agentKey.trim().length > 0
      : kind === 'rag' ? Boolean(v.ragModuleKey)
        : true;
  const validPrompt =
    v.promptMode === 'promptKey' ? Boolean(v.promptKey)
      : v.promptMode === 'inline' ? v.systemPrompt.trim().length > 0
        : true;
  const validSchema = v.responseMode !== 'json_schema' || (() => {
    try { JSON.parse(v.jsonSchema); return true; } catch { return false; }
  })();
  const canSubmit = validName && validRef && (kind !== 'model' || (validPrompt && validSchema));

  const checklist = [
    { id: 'name', label: 'Name provided', done: validName },
    { id: 'ref', label: kind === 'external' ? 'External endpoint (coming soon)' : `${KIND_LABEL[kind]} selected`, done: validRef },
  ];

  const summary = (
    <SummaryGroup title="Target">
      <SummaryKV label="Name" value={v.name || '—'} />
      <SummaryKV label="Kind" value={KIND_LABEL[kind]} />
      <SummaryKV label={referenceLabel(kind)} value={referenceValue(v)} />
      {kind === 'rag' && (
        <SummaryKV
          label="Retrieval"
          value={`top ${v.retrievalTopK === '' ? 'module default' : v.retrievalTopK} · min score ${v.retrievalMinScore === '' ? 'module default' : v.retrievalMinScore}`}
        />
      )}
      {kind === 'model' && (
        <SummaryKV label="Response format" value={v.responseMode === 'none' ? 'free text' : v.responseMode} />
      )}
      {kind === 'model' && (
        <SummaryKV
          label="System prompt"
          value={v.promptMode === 'promptKey' ? (v.promptKey || 'prompt not selected')
            : v.promptMode === 'inline' ? 'pasted'
              : 'from the dataset'}
        />
      )}
      <Checklist items={checklist} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconRobot size={16} />}
      title={isEdit ? 'Edit evaluation target' : 'New evaluation target'}
      subtitle="Define the agent, model, or endpoint under test."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Create target',
        icon: <IconCheck size={13} />,
        loading,
        disabled: !canSubmit,
        onClick: () => void handleSubmit(),
      }}
    >
      <FormSection number={1} title="Identity" done={validName}>
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput placeholder="e.g. GPT-4o production model" {...form.getInputProps('name')} />
          </FormField>
          <FormField label="Description" optional>
            <Textarea placeholder="What is this target?" autosize minRows={2} {...form.getInputProps('description')} />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={2} title="Target" done={validRef}>
        <FormField label="Kind" required hint={isEdit ? 'Kind cannot be changed after creation.' : undefined}>
          <Select data={KIND_OPTIONS} disabled={isEdit} {...form.getInputProps('kind')} />
        </FormField>

        {kind === 'model' && (
          <FormField label="Model" required>
            <Select placeholder="Select a model…" data={models} searchable {...form.getInputProps('modelKey')} />
          </FormField>
        )}
        {kind === 'agent' && (
          <FormField label="Agent" required>
            <Select
              placeholder={agents.length ? 'Select an agent…' : 'No registered agents found'}
              data={agents}
              searchable
              {...form.getInputProps('agentKey')}
            />
          </FormField>
        )}
        {kind === 'rag' && (
          <FormField label="Knowledge Engine module" required hint="Each dataset item's user message becomes a query against this module.">
            <Select
              placeholder={ragModules.length ? 'Select a module…' : 'No Knowledge Engine modules found'}
              data={ragModules}
              searchable
              nothingFoundMessage="No Knowledge Engine modules"
              {...form.getInputProps('ragModuleKey')}
            />
          </FormField>
        )}
        {kind === 'external' && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
            External HTTP endpoint configuration is coming soon. The target will be created, but runs against it are
            recorded as per-item errors until the adapter ships.
          </Alert>
        )}
      </FormSection>

      {kind === 'rag' && (
        <FormSection number={3} title="Retrieval" done>
          <FormRow cols={2}>
            <FormField
              label="Top K"
              optional
              hint="How many passages to retrieve per item. Left empty, the module's own default applies."
            >
              <NumberInput min={1} max={200} placeholder="module default" {...form.getInputProps('retrievalTopK')} />
            </FormField>
            <FormField
              label="Minimum score"
              optional
              hint="Passages below this retrieval score are discarded before scoring. A high floor trades recall for precision."
            >
              <NumberInput min={0} max={1} step={0.05} decimalScale={2} placeholder="module default" {...form.getInputProps('retrievalMinScore')} />
            </FormField>
          </FormRow>
          <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
            Retrieval is graded by the context-recall, context-precision and groundedness scorers, which compare
            embeddings rather than strings — a passage that answers the question in different words still counts as a
            hit. Each of them needs a gold answer per item (<strong>expected.reference</strong>).
          </Alert>
        </FormSection>
      )}

      {kind === 'model' && (
        <FormSection number={3} title="System prompt" done={v.promptMode === 'none' || validPrompt}>
          <FormField
            label="Prompt under test"
            hint="Datasets captured from live traffic embed the system prompt they were recorded with. Override it here to test a different prompt against the same traffic — the captured system turn is replaced, not stacked."
          >
            <SegmentedControl
              fullWidth
              value={v.promptMode}
              onChange={(value) => form.setFieldValue('promptMode', value as FormValues['promptMode'])}
              data={[
                { label: 'From the dataset', value: 'none' },
                { label: 'Managed prompt', value: 'promptKey' },
                { label: 'Paste', value: 'inline' },
              ]}
            />
          </FormField>

          {v.promptMode === 'promptKey' && (
            <FormField label="Prompt" required hint="Resolved per run — promote a new version and the next run tests it.">
              <Select
                placeholder={prompts.length ? 'Select a prompt…' : 'No prompts found'}
                data={prompts}
                searchable
                {...form.getInputProps('promptKey')}
              />
            </FormField>
          )}

          {v.promptMode === 'inline' && (
            <FormField label="System prompt" required>
              <Textarea
                autosize
                minRows={4}
                maxRows={14}
                placeholder="You are a careful support assistant…"
                styles={{ input: { fontFamily: 'var(--font-mono, monospace)', fontSize: 12 } }}
                {...form.getInputProps('systemPrompt')}
              />
            </FormField>
          )}
        </FormSection>
      )}

      {kind === 'model' && (
        <FormSection number={4} title="Response contract" done={v.responseMode === 'none' || validSchema}>
          <FormField
            label="Structured output"
            hint="Send the same response_format your production calls send. A suite that omits it tests a looser contract than the live system runs under — malformed-JSON failures then only show up in production."
          >
            <SegmentedControl
              fullWidth
              value={v.responseMode}
              onChange={(value) => form.setFieldValue('responseMode', value as FormValues['responseMode'])}
              data={[
                { label: 'None (free text)', value: 'none' },
                { label: 'JSON object', value: 'json_object' },
                { label: 'JSON schema (strict)', value: 'json_schema' },
              ]}
            />
          </FormField>

          {v.responseMode === 'json_schema' && (
            <FormField label="JSON schema" required hint="The schema body only — it is wrapped as response_format.json_schema with strict: true.">
              <Textarea
                autosize
                minRows={5}
                maxRows={16}
                placeholder={'{\n  "type": "object",\n  "properties": { "reply": { "type": "boolean" } },\n  "required": ["reply"]\n}'}
                styles={{ input: { fontFamily: 'var(--font-mono, monospace)', fontSize: 12 } }}
                {...form.getInputProps('jsonSchema')}
              />
            </FormField>
          )}

          <FormField
            label="Max output tokens"
            optional
            hint="Left empty, the provider's own default applies — a long structured answer can truncate mid-object and arrive as unparseable JSON."
          >
            <NumberInput min={1} max={200000} placeholder="provider default" {...form.getInputProps('maxTokens')} />
          </FormField>
        </FormSection>
      )}

      {kind === 'agent' && (
        <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />} mt="md">
          An agent target always runs its own published prompt, so there is no system-prompt override here. To evaluate a
          prompt change, use a model target — or change the agent&apos;s prompt and re-publish it.
        </Alert>
      )}
    </FormShell>
  );
}
