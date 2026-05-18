'use client';

import { useEffect, useState } from 'react';
import { TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconDatabaseEdit, IconCheck } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';

interface EditVectorIndexModalProps {
  opened: boolean;
  onClose: () => void;
  initialName: string;
  initialDescription?: string;
  onSubmit: (values: { name: string; description?: string }) => Promise<void>;
}

export default function EditVectorIndexModal({
  opened,
  onClose,
  initialName,
  initialDescription,
  onSubmit,
}: EditVectorIndexModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const form = useForm({
    initialValues: {
      name: initialName,
      description: initialDescription ?? '',
    },
    validate: {
      name: (value) => (!value ? 'Name is required' : null),
    },
  });

  const { setValues } = form;

  useEffect(() => {
    if (opened) {
      setValues({
        name: initialName,
        description: initialDescription ?? '',
      });
    }
  }, [opened, initialName, initialDescription, setValues]);

  const validName = form.values.name.trim().length > 0;

  const checklist = [
    { id: 1, label: 'Name provided', done: validName },
  ];

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();
    setSubmitting(true);
    try {
      await onSubmit({
        name: values.name,
        description: values.description || undefined,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const summary = (
    <>
      <SummaryGroup title="Index">
        <SummaryKV
          label="Name"
          value={form.values.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Description"
          value={form.values.description || <span className="ds-faint">—</span>}
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
      icon={<IconDatabaseEdit size={16} />}
      title="Edit index"
      subtitle="Update the identity of this vector index."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Save changes',
        icon: <IconCheck size={13} />,
        loading: submitting,
        disabled: !validName,
        onClick: () => {
          void handleSubmit();
        },
      }}
    >
      <FormSection
        number={1}
        title="Identity"
        description="A human-readable name for this index."
        done={validName}
      >
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput {...form.getInputProps('name')} />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              placeholder="Optional description"
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}
