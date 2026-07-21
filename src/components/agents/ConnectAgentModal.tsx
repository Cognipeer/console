'use client';

import { useEffect } from 'react';
import {
  ActionIcon,
  Button,
  Group,
  PasswordInput,
  Select,
  Switch,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconPlugConnected, IconPlus, IconTrash } from '@tabler/icons-react';
import FormShell, {
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';

type Protocol = 'a2a' | 'openai-chat' | 'openai-responses';

interface ProviderOption {
  key: string;
  label: string;
}

interface EditAgent {
  _id: string;
  name: string;
  description?: string;
  config?: {
    connection?: {
      protocol?: string;
      url?: string;
      model?: string;
      responsePath?: string;
      credentialProviderKey?: string;
      hasApiKey?: boolean;
      headers?: Record<string, string>;
      runtimeHeaders?: { allow?: boolean; allowedNames?: string[] };
    };
  };
}

interface ConnectAgentModalProps {
  opened: boolean;
  onClose: () => void;
  providers: ProviderOption[];
  onCreated: (agentId: string) => void;
  /** When provided, the modal edits this agent's connection (PATCH) instead of creating one. */
  editAgent?: EditAgent | null;
}

interface HeaderRow {
  key: string;
  value: string;
}

interface FormValues {
  name: string;
  description: string;
  protocol: Protocol;
  url: string;
  model: string;
  apiKey: string;
  credentialProviderKey: string;
  responsePath: string;
  headers: HeaderRow[];
  allowRuntimeHeaders: boolean;
}

export default function ConnectAgentModal({
  opened,
  onClose,
  providers,
  onCreated,
  editAgent,
}: ConnectAgentModalProps) {
  const t = useTranslations('agents');
  const isEdit = Boolean(editAgent);
  const hasExistingKey = Boolean(editAgent?.config?.connection?.hasApiKey);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      protocol: 'openai-chat',
      url: '',
      model: '',
      apiKey: '',
      credentialProviderKey: '',
      responsePath: '',
      headers: [],
      allowRuntimeHeaders: false,
    },
    validate: {
      name: (v) => (!v.trim() ? t('validation.nameRequired') : null),
      url: (v) => (!v.trim() ? t('validation.urlRequired') : null),
      model: (v, values) =>
        values.protocol !== 'a2a' && !v.trim()
          ? t('validation.externalModelRequired')
          : null,
    },
  });

  const isOpenAi = form.values.protocol !== 'a2a';

  // Populate the form when (re)opening: from the edited agent, or reset for create.
  useEffect(() => {
    if (!opened) return;
    if (editAgent) {
      const c = editAgent.config?.connection ?? {};
      form.setValues({
        name: editAgent.name ?? '',
        description: editAgent.description ?? '',
        protocol: (c.protocol as Protocol) ?? 'openai-chat',
        url: c.url ?? '',
        model: c.model ?? '',
        apiKey: '',
        credentialProviderKey: c.credentialProviderKey ?? '',
        responsePath: c.responsePath ?? '',
        headers: c.headers
          ? Object.entries(c.headers).map(([key, value]) => ({ key, value: String(value) }))
          : [],
        allowRuntimeHeaders: c.runtimeHeaders?.allow === true,
      });
    } else {
      form.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, editAgent]);

  const handleClose = () => {
    form.reset();
    onClose();
  };

  const submit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const v = form.values;

    const headers = v.headers
      .filter((h) => h.key.trim() && h.value.trim())
      .reduce<Record<string, string>>((acc, h) => {
        acc[h.key.trim()] = h.value.trim();
        return acc;
      }, {});

    try {
      const res = await fetch(
        isEdit ? `/api/agents/${editAgent!._id}` : '/api/agents',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: v.name,
            description: v.description || undefined,
            config: {
              kind: 'external',
              connection: {
                protocol: v.protocol,
                url: v.url.trim(),
                model: isOpenAi ? v.model.trim() : undefined,
                apiKey: v.apiKey.trim() || undefined,
                credentialProviderKey: v.credentialProviderKey || undefined,
                responsePath: v.responsePath.trim() || undefined,
                headers: Object.keys(headers).length ? headers : undefined,
                runtimeHeaders: v.allowRuntimeHeaders ? { allow: true } : undefined,
              },
            },
          }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || t('notifications.createFailed'));
      }
      const data = await res.json();
      notifications.show({
        title: isEdit ? t('notifications.saved') : t('notifications.created'),
        message: isEdit
          ? t('notifications.savedDesc')
          : t('notifications.createdDesc', { name: v.name }),
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

  const canSubmit = Boolean(
    form.values.name.trim()
    && form.values.url.trim()
    && (!isOpenAi || form.values.model.trim()),
  );

  const PROTOCOL_OPTIONS: Array<{ value: Protocol; label: string }> = [
    { value: 'a2a', label: t('connectModal.protocolA2a') },
    { value: 'openai-chat', label: t('connectModal.protocolOpenaiChat') },
    { value: 'openai-responses', label: t('connectModal.protocolOpenaiResponses') },
  ];

  return (
    <FormShell
      open={opened}
      onClose={handleClose}
      icon={<IconPlugConnected size={16} />}
      title={isEdit ? t('connectModal.editTitle') : t('connectModal.title')}
      subtitle={isEdit ? t('connectModal.editSubtitle') : t('connectModal.subtitle')}
      primaryAction={{
        label: isEdit ? t('connectModal.save') : t('connectModal.connect'),
        icon: <IconPlugConnected size={13} />,
        loading: form.submitting,
        disabled: !canSubmit,
        onClick: submit,
      }}
      secondaryAction={{ label: t('connectModal.cancel'), onClick: handleClose }}
    >
      <FormSection
        number={1}
        title={t('connectModal.identitySection')}
        description={t('connectModal.identityDesc')}
        done={Boolean(form.values.name.trim())}
      >
        <FormField label={t('connectModal.name')} required>
          <TextInput
            placeholder={t('connectModal.namePlaceholder')}
            {...form.getInputProps('name')}
          />
        </FormField>
        <FormField label={t('connectModal.description')} optional>
          <Textarea
            placeholder={t('connectModal.descriptionPlaceholder')}
            rows={2}
            {...form.getInputProps('description')}
          />
        </FormField>
      </FormSection>

      <FormSection
        number={2}
        title={t('connectModal.connectionSection')}
        description={t('connectModal.connectionDesc')}
        done={Boolean(form.values.url.trim() && (!isOpenAi || form.values.model.trim()))}
      >
        <FormField label={t('connectModal.protocol')} required>
          <ChipPicker<Protocol>
            options={PROTOCOL_OPTIONS}
            value={form.values.protocol}
            onChange={(v) => form.setFieldValue('protocol', v as Protocol)}
          />
        </FormField>
        <FormRow cols={isOpenAi ? 2 : 1}>
          <FormField label={t('connectModal.url')} required>
            <TextInput
              placeholder={
                isOpenAi
                  ? t('connectModal.urlPlaceholderOpenai')
                  : t('connectModal.urlPlaceholderA2a')
              }
              {...form.getInputProps('url')}
            />
          </FormField>
          {isOpenAi ? (
            <FormField label={t('connectModal.model')} required>
              <TextInput
                placeholder={t('connectModal.modelPlaceholder')}
                {...form.getInputProps('model')}
              />
            </FormField>
          ) : null}
        </FormRow>
      </FormSection>

      <FormSection
        number={3}
        title={t('connectModal.authSection')}
        description={t('connectModal.authDesc')}
      >
        <FormField
          label={t('connectModal.apiKey')}
          optional
          hint={hasExistingKey ? t('connectModal.apiKeyKeepHint') : t('connectModal.apiKeyHint')}
        >
          <PasswordInput
            placeholder={hasExistingKey ? '••••••••' : t('connectModal.apiKeyPlaceholder')}
            {...form.getInputProps('apiKey')}
          />
        </FormField>
        <FormField
          label={t('connectModal.credentialProvider')}
          optional
          hint={t('connectModal.credentialProviderHint')}
        >
          <Select
            placeholder={t('connectModal.credentialProviderPlaceholder')}
            data={providers.map((p) => ({ value: p.key, label: p.label }))}
            searchable
            clearable
            {...form.getInputProps('credentialProviderKey')}
          />
        </FormField>
      </FormSection>

      <FormSection
        number={4}
        title={t('connectModal.advancedSection')}
        description={t('connectModal.advancedDesc')}
      >
        <FormField label={t('connectModal.headers')} optional>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {form.values.headers.map((_, idx) => (
              <Group key={idx} gap="xs" wrap="nowrap">
                <TextInput
                  style={{ flex: 1 }}
                  placeholder={t('connectModal.headerKey')}
                  {...form.getInputProps(`headers.${idx}.key`)}
                />
                <TextInput
                  style={{ flex: 1 }}
                  placeholder={t('connectModal.headerValue')}
                  {...form.getInputProps(`headers.${idx}.value`)}
                />
                <ActionIcon
                  variant="subtle"
                  color="red"
                  onClick={() => form.removeListItem('headers', idx)}
                  aria-label="Remove header"
                >
                  <IconTrash size={15} />
                </ActionIcon>
              </Group>
            ))}
            <Button
              variant="default"
              size="xs"
              leftSection={<IconPlus size={13} />}
              onClick={() => form.insertListItem('headers', { key: '', value: '' })}
              style={{ alignSelf: 'flex-start' }}
            >
              {t('connectModal.addHeader')}
            </Button>
          </div>
        </FormField>
        <FormField
          label={t('connectModal.responsePath')}
          optional
          hint={t('connectModal.responsePathHint')}
        >
          <TextInput
            placeholder={t('connectModal.responsePathPlaceholder')}
            {...form.getInputProps('responsePath')}
          />
        </FormField>
        <FormField
          label={t('connectModal.runtimeHeaders')}
          optional
          hint={t('connectModal.runtimeHeadersHint')}
        >
          <Switch
            label={t('connectModal.runtimeHeadersToggle')}
            {...form.getInputProps('allowRuntimeHeaders', { type: 'checkbox' })}
          />
        </FormField>
      </FormSection>
    </FormShell>
  );
}
