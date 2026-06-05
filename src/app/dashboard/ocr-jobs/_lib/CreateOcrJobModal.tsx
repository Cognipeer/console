'use client';

import { useState } from 'react';
import { Checkbox, Group, NumberInput, Select, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconFileText } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import SchemaBuilder from './SchemaBuilder';
import {
  ocrJobsApi,
  type BucketOption,
  type CreateOcrJobBody,
  type ModelOption,
  type OcrOutputKind,
} from './api';

interface CreateForm {
  name: string;
  bucketKey: string;
  ocrModelKey: string;
  llmModelKey: string;
  outputs: OcrOutputKind[];
  summaryPrompt: string;
  language: string;
  pdfMaxPages: number | '';
  callbackUrl: string;
  callbackSecret: string;
}

interface CreateOcrJobModalProps {
  opened: boolean;
  onClose: () => void;
  ocrModels: ModelOption[];
  llmModels: ModelOption[];
  buckets: BucketOption[];
  onCreated: (jobId: string) => void;
}

export default function CreateOcrJobModal({
  opened,
  onClose,
  ocrModels,
  llmModels,
  buckets,
  onCreated,
}: CreateOcrJobModalProps) {
  const [creating, setCreating] = useState(false);
  const [schema, setSchema] = useState<Record<string, unknown> | undefined>(undefined);

  const form = useForm<CreateForm>({
    initialValues: {
      name: '', bucketKey: '', ocrModelKey: '', llmModelKey: '',
      outputs: ['full_text'], summaryPrompt: '', language: '', pdfMaxPages: '',
      callbackUrl: '', callbackSecret: '',
    },
    validate: {
      ocrModelKey: (v) => (v ? null : 'OCR model is required'),
      bucketKey: (v) => (v ? null : 'A storage bucket is required'),
    },
  });

  const close = () => {
    form.reset();
    setSchema(undefined);
    onClose();
  };

  const handleCreate = form.onSubmit(async (values) => {
    const outputs = values.outputs.length ? values.outputs : (['full_text'] as OcrOutputKind[]);
    const needsLlm = outputs.includes('summary') || outputs.includes('structured');
    if (needsLlm && !values.llmModelKey) {
      notifications.show({ message: 'Select an LLM model for summary/structured outputs', color: 'red' });
      return;
    }
    if (outputs.includes('structured') && !schema) {
      notifications.show({ message: 'Define a structured schema (Builder or JSON)', color: 'red' });
      return;
    }
    const body: CreateOcrJobBody = {
      name: values.name || undefined,
      bucketKey: values.bucketKey,
      ocrModelKey: values.ocrModelKey,
      llmModelKey: needsLlm ? values.llmModelKey : undefined,
      outputs,
      summaryPrompt: values.summaryPrompt || undefined,
      structuredSchema: outputs.includes('structured') ? schema : undefined,
      language: values.language || undefined,
      pdfMaxPages: typeof values.pdfMaxPages === 'number' ? values.pdfMaxPages : undefined,
      callbackUrl: values.callbackUrl || undefined,
      callbackSecret: values.callbackSecret || undefined,
    };
    setCreating(true);
    try {
      const job = await ocrJobsApi.create(body);
      notifications.show({ message: 'OCR job created', color: 'green' });
      form.reset();
      setSchema(undefined);
      onCreated(job.id);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : 'Failed to create job', color: 'red' });
    } finally {
      setCreating(false);
    }
  });

  const v = form.values;
  const outputs = v.outputs;
  const needsLlm = outputs.includes('summary') || outputs.includes('structured');
  const validStore = Boolean(v.bucketKey && v.ocrModelKey);
  const validOutputs = (!needsLlm || Boolean(v.llmModelKey)) && (!outputs.includes('structured') || Boolean(schema));
  const canSubmit = validStore && validOutputs;

  const checklist = [
    { id: 'store', label: 'Bucket + OCR model selected', done: validStore },
    { id: 'outputs', label: needsLlm ? 'LLM model + schema ready' : 'Outputs configured', done: validOutputs },
  ];

  const summary = (
    <SummaryGroup title="OCR job">
      <SummaryKV label="Name" value={v.name || '—'} />
      <SummaryKV label="Bucket" value={v.bucketKey || '—'} />
      <SummaryKV label="OCR model" value={v.ocrModelKey || '—'} />
      <SummaryKV label="LLM model" value={needsLlm ? (v.llmModelKey || '—') : 'n/a'} />
      <SummaryKV label="Outputs" value={outputs.join(', ') || 'full_text'} />
      <Checklist items={checklist} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={close}
      icon={<IconFileText size={16} />}
      title="New OCR job"
      subtitle="Define rules + a bucket, then send documents to the job for OCR + extraction."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Create job',
        icon: <IconCheck size={13} />,
        loading: creating,
        disabled: !canSubmit,
        onClick: () => handleCreate(),
      }}
    >
      <FormSection number={1} title="Identity & storage" done={validStore}>
        <FormField label="Name" optional>
          <TextInput placeholder="Optional" {...form.getInputProps('name')} />
        </FormField>
        <FormField label="Storage bucket" required>
          <Select
            placeholder={buckets.length ? 'Select a bucket' : 'No buckets — create one in Document Store'}
            data={buckets}
            searchable
            {...form.getInputProps('bucketKey')}
          />
        </FormField>
      </FormSection>

      <FormSection number={2} title="Models" done={Boolean(v.ocrModelKey)}>
        <FormRow cols={2}>
          <FormField label="OCR model" required>
            <Select placeholder="Select OCR model" data={ocrModels} searchable {...form.getInputProps('ocrModelKey')} />
          </FormField>
          <FormField label="LLM model" required={needsLlm} hint="For summary / structured outputs">
            <Select placeholder="For summary / structured" data={llmModels} searchable clearable {...form.getInputProps('llmModelKey')} />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={3} title="Outputs" done={validOutputs}>
        <Checkbox.Group {...form.getInputProps('outputs')}>
          <Group mt="xs">
            <Checkbox value="full_text" label="Full text" />
            <Checkbox value="summary" label="Summary" />
            <Checkbox value="structured" label="Structured (JSON)" />
          </Group>
        </Checkbox.Group>

        {outputs.includes('summary') && (
          <FormField label="Summary prompt" optional>
            <Textarea placeholder="Optional instruction" autosize minRows={2} {...form.getInputProps('summaryPrompt')} />
          </FormField>
        )}

        {outputs.includes('structured') && (
          <FormField label="Structured schema" required>
            <SchemaBuilder value={schema} onChange={setSchema} />
          </FormField>
        )}
      </FormSection>

      <FormSection number={4} title="Options">
        <FormRow cols={2}>
          <FormField label="Language hint" optional>
            <TextInput placeholder="tr, en…" {...form.getInputProps('language')} />
          </FormField>
          <FormField label="PDF max pages" hint="empty = unlimited">
            <NumberInput min={0} {...form.getInputProps('pdfMaxPages')} />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={5} title="Callback">
        <FormRow cols={2}>
          <FormField label="Callback URL" optional>
            <TextInput placeholder="https://…/webhook" {...form.getInputProps('callbackUrl')} />
          </FormField>
          <FormField label="Callback secret" optional>
            <TextInput placeholder="HMAC secret" {...form.getInputProps('callbackSecret')} />
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}
