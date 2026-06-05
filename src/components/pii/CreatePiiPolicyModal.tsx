'use client';

import { useState } from 'react';
import { TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconShieldLock } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';

interface PiiPolicyView {
  id: string;
  name: string;
  key: string;
}

type DefaultAction = 'detect' | 'redact' | 'mask' | 'block' | 'tokenize';

interface Props {
  opened: boolean;
  onClose: () => void;
  onCreated: (p: PiiPolicyView) => void;
}

export default function CreatePiiPolicyModal({ opened, onClose, onCreated }: Props) {
  const t = useTranslations('pii');
  const tAct = useTranslations('pii.actions');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [defaultAction, setDefaultAction] = useState<DefaultAction>('detect');
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const validName = name.trim().length > 0;

  const checklist = [
    { id: 1, label: t('detail.basics.name'), done: validName },
    { id: 2, label: t('detail.basics.defaultAction'), done: Boolean(defaultAction) },
  ];

  const reset = () => {
    setName('');
    setDescription('');
    setDefaultAction('detect');
    setEnabled(true);
  };

  const submit = async () => {
    if (!validName) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/pii/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          defaultAction,
          enabled,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed to create');
      }
      const data = await res.json();
      notifications.show({
        title: t('notifications.created'),
        message: data.policy.name,
        color: 'teal',
      });
      onCreated(data.policy);
      reset();
      onClose();
    } catch (err) {
      notifications.show({
        title: t('notifications.saveError'),
        message: err instanceof Error ? err.message : '',
        color: 'red',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const summary = (
    <>
      <SummaryGroup title={t('detail.basics.name')}>
        <SummaryKV
          label={t('detail.basics.name')}
          value={name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label={t('detail.basics.defaultAction')}
          value={
            <span className="ds-badge ds-badge-info">
              {tAct(defaultAction)}
            </span>
          }
        />
        <SummaryKV
          label={t('detail.basics.enabled')}
          value={
            <span
              className={`ds-badge ${enabled ? 'ds-badge-ok' : 'ds-badge-warn'}`}
            >
              {enabled ? 'on' : 'off'}
            </span>
          }
        />
      </SummaryGroup>
      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconShieldLock size={16} />}
      title={t('page.newPolicy')}
      subtitle="Define a new PII policy that will be applied across configured surfaces."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: t('page.newPolicy'),
        loading: submitting,
        disabled: !validName,
        onClick: submit,
      }}
      secondaryAction={{
        label: t('deleteModal.cancel'),
        onClick: onClose,
      }}
    >
      <FormSection
        number={1}
        title={t('detail.basics.name')}
        description="How the policy is identified across the console."
        done={validName}
      >
        <FormRow cols={1}>
          <FormField label={t('detail.basics.name')} required>
            <TextInput
              placeholder={t('detail.basics.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              data-autofocus
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('detail.basics.description')} optional>
            <Textarea
              placeholder={t('detail.basics.descriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              minRows={2}
              autosize
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title={t('detail.basics.defaultAction')}
        description="What should happen when the policy detects PII."
        done
      >
        <ChipPicker<DefaultAction>
          options={[
            { value: 'detect', label: tAct('detect') },
            { value: 'redact', label: tAct('redact') },
            { value: 'mask', label: tAct('mask') },
            { value: 'tokenize', label: tAct('tokenize') },
            { value: 'block', label: tAct('block') },
          ]}
          value={defaultAction}
          onChange={(v) => setDefaultAction(v as DefaultAction)}
        />
      </FormSection>

      <FormSection number={3} title={t('detail.basics.enabled')} done>
        <ToggleList>
          <ToggleRow
            label={t('detail.basics.enabled')}
            description="Disabled policies are skipped at evaluation time."
            checked={enabled}
            onChange={setEnabled}
          />
        </ToggleList>
      </FormSection>
    </FormShell>
  );
}
