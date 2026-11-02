'use client';

import { useState } from 'react';
import { Select, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconRobot } from '@tabler/icons-react';
import FormShell, { FormField, FormSection } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { useFlowAgentCreate } from '@/components/enterprise/EnterpriseFlowAgentUi';

interface ModelOption {
  key: string;
  name: string;
  modelId: string;
}

interface CreateAgentModalProps {
  opened: boolean;
  onClose: () => void;
  models: ModelOption[];
  /** `flowId` is set for a FlowBase agent: the page then opens that flow's editor. */
  onCreated: (agentId: string, created?: { flowId?: string }) => void;
}

export default function CreateAgentModal({
  opened,
  onClose,
  models,
  onCreated,
}: CreateAgentModalProps) {
  const t = useTranslations('agents');
  // The FlowBase choice, where Flows are available (Enterprise): null otherwise.
  const flowCreate = useFlowAgentCreate();
  const [submitting, setSubmitting] = useState(false);
  const form = useForm({
    initialValues: { name: '', description: '', modelKey: '' },
    validate: {
      name: (v) => (!v.trim() ? t('validation.nameRequired') : null),
    },
  });

  const handleClose = () => {
    form.reset();
    flowCreate?.reset();
    onClose();
  };

  const submit = async () => {
    const validation = form.validate();
    // The model only matters for a Smart Agent, so it is checked here rather than in the form's rules.
    const modelMissing = flowCreate?.kind !== 'flow' && !form.values.modelKey;
    if (modelMissing) form.setFieldError('modelKey', t('validation.modelRequired'));
    if (validation.hasErrors || modelMissing || submitting) return;
    setSubmitting(true);
    const values = form.values;
    try {
      let agentId: string;
      let flowId: string | undefined;
      if (flowCreate?.kind === 'flow') {
        const created = await flowCreate.create({ name: values.name, description: values.description || undefined });
        agentId = created.agentId;
        flowId = created.flowId;
      } else {
        const res = await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: values.name,
            description: values.description || undefined,
            config: { kind: 'native', modelKey: values.modelKey, temperature: 0.7 },
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || t('notifications.createFailed'));
        }
        const data = await res.json();
        agentId = data.agent._id;
      }
      notifications.show({
        title: t('notifications.created'),
        message: t('notifications.createdDesc', { name: values.name }),
        color: 'teal',
      });
      form.reset();
      flowCreate?.reset();
      onCreated(agentId, flowId ? { flowId } : undefined);
    } catch (error) {
      notifications.show({
        title: t('notifications.error'),
        message: error instanceof Error ? error.message : 'Error',
        color: 'red',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const flowBase = flowCreate?.kind === 'flow';
  const canSubmit = Boolean(form.values.name.trim() && (flowBase || form.values.modelKey));

  return (
    <FormShell
      open={opened}
      onClose={handleClose}
      icon={<IconRobot size={16} />}
      title={t('createModal.title')}
      subtitle={flowBase && flowCreate ? flowCreate.subtitle : t('createModal.subtitle')}
      primaryAction={{
        label: t('createModal.create'),
        icon: <IconPlus size={13} />,
        loading: submitting,
        disabled: !canSubmit,
        onClick: submit,
      }}
      secondaryAction={{ label: t('createModal.cancel'), onClick: handleClose }}
    >
      {flowCreate?.typeSection ?? null}

      <FormSection
        number={flowCreate ? 2 : 1}
        title={t('createModal.identitySection')}
        description={t('createModal.identityDesc')}
        done={Boolean(form.values.name.trim())}
      >
        <FormField label={t('createModal.name')} required>
          <TextInput
            placeholder={t('createModal.namePlaceholder')}
            {...form.getInputProps('name')}
          />
        </FormField>
        <FormField label={t('createModal.description')} optional>
          <Textarea
            placeholder={t('createModal.descriptionPlaceholder')}
            rows={2}
            {...form.getInputProps('description')}
          />
        </FormField>
      </FormSection>

      {flowBase && flowCreate ? (
        flowCreate.startSection
      ) : (
        <FormSection
          number={flowCreate ? 3 : 2}
          title={t('createModal.modelSection')}
          description={t('createModal.modelDesc')}
          done={Boolean(form.values.modelKey)}
        >
          <FormField label={t('createModal.model')} required>
            <Select
              placeholder={t('createModal.modelPlaceholder')}
              data={models.map((m) => ({ value: m.key, label: `${m.name} (${m.modelId})` }))}
              searchable
              {...form.getInputProps('modelKey')}
            />
          </FormField>
        </FormSection>
      )}
    </FormShell>
  );
}
