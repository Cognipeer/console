'use client';

import { Select, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconRobot } from '@tabler/icons-react';
import FormShell, {
  FormField,
  FormSection,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';

interface ModelOption {
  key: string;
  name: string;
  modelId: string;
}

interface CreateAgentModalProps {
  opened: boolean;
  onClose: () => void;
  models: ModelOption[];
  onCreated: (agentId: string) => void;
}

export default function CreateAgentModal({
  opened,
  onClose,
  models,
  onCreated,
}: CreateAgentModalProps) {
  const t = useTranslations('agents');
  const form = useForm({
    initialValues: { name: '', description: '', modelKey: '' },
    validate: {
      name: (v) => (!v.trim() ? t('validation.nameRequired') : null),
      modelKey: (v) => (!v ? t('validation.modelRequired') : null),
    },
  });

  const handleClose = () => {
    form.reset();
    onClose();
  };

  const submit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.values;
    try {
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
      notifications.show({
        title: t('notifications.created'),
        message: t('notifications.createdDesc', { name: values.name }),
        color: 'teal',
      });
      form.reset();
      onCreated(data.agent._id);
    } catch (error) {
      notifications.show({
        title: t('notifications.error'),
        message: error instanceof Error ? error.message : 'Error',
        color: 'red',
      });
    }
  };

  const canSubmit = Boolean(form.values.name.trim() && form.values.modelKey);

  return (
    <FormShell
      open={opened}
      onClose={handleClose}
      icon={<IconRobot size={16} />}
      title={t('createModal.title')}
      subtitle={t('createModal.subtitle')}
      primaryAction={{
        label: t('createModal.create'),
        icon: <IconPlus size={13} />,
        loading: form.submitting,
        disabled: !canSubmit,
        onClick: submit,
      }}
      secondaryAction={{ label: t('createModal.cancel'), onClick: handleClose }}
    >
      <FormSection
        number={1}
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

      <FormSection
        number={2}
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
    </FormShell>
  );
}
