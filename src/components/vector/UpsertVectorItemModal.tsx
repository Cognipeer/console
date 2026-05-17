'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { TextInput, Textarea, Text } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconVectorTriangle, IconCheck } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';

interface UpsertVectorItemModalProps {
  opened: boolean;
  onClose: () => void;
  expectedDimension?: number;
  onSubmit: (payload: { id: string; values: number[]; metadata?: Record<string, unknown> }) => Promise<void>;
}

interface FormValues {
  id: string;
  vector: string;
  metadata: string;
}

export default function UpsertVectorItemModal({
  opened,
  onClose,
  expectedDimension,
  onSubmit,
}: UpsertVectorItemModalProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<FormValues>({
    initialValues: {
      id: '',
      vector: '',
      metadata: '',
    },
    validate: {
      id: (value) => (!value ? 'Item ID is required' : null),
      vector: (value) => (!value ? 'Vector values are required' : null),
    },
  });
  const { reset } = form;
  const wasOpenedRef = useRef(false);

  useEffect(() => {
    if (!opened) {
      if (wasOpenedRef.current) {
        reset();
        setErrorMessage(null);
        wasOpenedRef.current = false;
      }
      return;
    }

    wasOpenedRef.current = true;
  }, [opened, reset]);

  const parsedVectorInfo = useMemo(() => {
    const raw = form.values.vector;
    if (!raw.trim()) return { count: 0, valid: false };
    const parts = raw
      .split(',')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    const nums = parts.map((segment) => Number(segment));
    const valid = parts.length > 0 && !nums.some((n) => Number.isNaN(n));
    return { count: parts.length, valid };
  }, [form.values.vector]);

  const metadataValid = useMemo(() => {
    const raw = form.values.metadata.trim();
    if (!raw) return true;
    try {
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  }, [form.values.metadata]);

  const validId = form.values.id.trim().length > 0;
  const dimensionOk = !expectedDimension || parsedVectorInfo.count === expectedDimension;
  const validVector = parsedVectorInfo.valid && dimensionOk;

  const checklist = [
    { id: 1, label: 'Item ID provided', done: validId },
    {
      id: 2,
      label: expectedDimension
        ? `Vector has ${expectedDimension} numeric values`
        : 'Vector has numeric values',
      done: validVector,
    },
    { id: 3, label: 'Metadata is valid JSON (or empty)', done: metadataValid },
  ];

  const handleSubmit = async () => {
    setErrorMessage(null);
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    setSubmitting(true);
    try {
      const parsedValues = values.vector
        .split(',')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0)
        .map((segment) => Number(segment));

      if (parsedValues.length === 0 || parsedValues.some((number) => Number.isNaN(number))) {
        throw new Error('Vector must contain numeric values separated by commas.');
      }

      if (expectedDimension && parsedValues.length !== expectedDimension) {
        throw new Error(`Vector must contain exactly ${expectedDimension} values.`);
      }

      let metadata: Record<string, unknown> | undefined;
      if (values.metadata) {
        metadata = JSON.parse(values.metadata) as Record<string, unknown>;
      }

      await onSubmit({
        id: values.id,
        values: parsedValues,
        metadata,
      });
      onClose();
    } catch (error) {
      console.error(error);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to parse input');
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = validId && validVector && metadataValid;

  const summary = (
    <>
      <SummaryGroup title="Item">
        <SummaryKV
          label="ID"
          value={form.values.id || <span className="ds-faint">—</span>}
          mono
        />
        <SummaryKV
          label="Dimension"
          value={
            parsedVectorInfo.count > 0
              ? parsedVectorInfo.count
              : <span className="ds-faint">—</span>
          }
          mono
        />
        {expectedDimension ? (
          <SummaryKV
            label="Expected"
            value={expectedDimension}
            mono
          />
        ) : null}
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
      icon={<IconVectorTriangle size={16} />}
      title="Add vector item"
      subtitle="Upsert a single vector by ID, with optional metadata."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Upsert item',
        icon: <IconCheck size={13} />,
        loading: submitting,
        disabled: !canSubmit,
        onClick: () => {
          void handleSubmit();
        },
      }}
    >
      <FormSection
        number={1}
        title="Identity"
        description="A unique identifier for this vector item."
        done={validId}
      >
        <FormRow cols={1}>
          <FormField label="Item ID" required>
            <TextInput
              placeholder="Document or chunk identifier"
              {...form.getInputProps('id')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title="Vector"
        description={
          expectedDimension
            ? `Provide ${expectedDimension} numeric values separated by commas.`
            : 'Provide comma-separated numeric values.'
        }
        done={validVector}
      >
        <FormRow cols={1}>
          <FormField
            label="Vector values"
            required
            hint={
              parsedVectorInfo.count > 0
                ? `${parsedVectorInfo.count} value${parsedVectorInfo.count === 1 ? '' : 's'} detected${
                    expectedDimension
                      ? dimensionOk
                        ? ' · matches expected dimension'
                        : ` · expected ${expectedDimension}`
                      : ''
                  }`
                : undefined
            }
          >
            <Textarea
              placeholder="1.23, 4.56, ..."
              minRows={3}
              autosize
              {...form.getInputProps('vector')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={3}
        title="Metadata"
        description="Optional JSON object attached to the item."
        done={metadataValid}
      >
        <FormRow cols={1}>
          <FormField label="Metadata (JSON)" optional>
            <Textarea
              placeholder='{ "title": "Document name" }'
              minRows={2}
              autosize
              {...form.getInputProps('metadata')}
            />
          </FormField>
        </FormRow>
        {errorMessage ? (
          <Text size="sm" c="red.6">
            {errorMessage}
          </Text>
        ) : null}
      </FormSection>
    </FormShell>
  );
}
