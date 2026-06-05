'use client';

import { useEffect, useState } from 'react';
import { Alert, Select, Textarea, TextInput } from '@mantine/core';
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
  kind: 'agent' | 'model' | 'external';
  modelKey: string;
  agentKey: string;
}

const KIND_OPTIONS = [
  { value: 'model', label: 'Model — a registered model' },
  { value: 'agent', label: 'Agent — a registered agent' },
  { value: 'external', label: 'External — an HTTP endpoint' },
];

const KIND_LABEL: Record<string, string> = { model: 'Model', agent: 'Agent', external: 'External' };

export default function CreateTargetModal({ opened, onClose, onCreated, models = [], editing = null }: CreateTargetModalProps) {
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<{ value: string; label: string }[]>([]);
  const isEdit = Boolean(editing);
  const form = useForm<FormValues>({
    initialValues: { name: '', description: '', kind: 'model', modelKey: '', agentKey: '' },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      modelKey: (v, values) => (values.kind === 'model' && !v ? 'A model is required for model targets' : null),
      agentKey: (v, values) => (values.kind === 'agent' && !v.trim() ? 'An agent key is required for agent targets' : null),
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
  const validRef = kind === 'model' ? Boolean(v.modelKey) : kind === 'agent' ? v.agentKey.trim().length > 0 : true;
  const canSubmit = validName && validRef;

  const checklist = [
    { id: 'name', label: 'Name provided', done: validName },
    { id: 'ref', label: kind === 'external' ? 'External endpoint (coming soon)' : `${KIND_LABEL[kind]} selected`, done: validRef },
  ];

  const summary = (
    <SummaryGroup title="Target">
      <SummaryKV label="Name" value={v.name || '—'} />
      <SummaryKV label="Kind" value={KIND_LABEL[kind]} />
      <SummaryKV label={kind === 'agent' ? 'Agent' : 'Model'} value={(kind === 'agent' ? v.agentKey : v.modelKey) || '—'} />
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
        {kind === 'external' && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
            External HTTP endpoint configuration is coming soon. The target will be created, but runs against it are
            recorded as per-item errors until the adapter ships.
          </Alert>
        )}
      </FormSection>
    </FormShell>
  );
}
