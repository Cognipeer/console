'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { NumberInput, Select, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconArrowRight, IconTransfer } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { VectorIndexRecord, VectorProviderView } from '@/lib/services/vector';
import type { IVectorMigration } from '@/lib/database/provider/types.base';

export interface CreateVectorMigrationModalProps {
  opened: boolean;
  onClose: () => void;
  providers: VectorProviderView[];
  indexesByProvider: Record<string, VectorIndexRecord[]>;
  onCreated: (migration: IVectorMigration) => void;
}

interface FormValues {
  name: string;
  description: string;
  sourceProviderKey: string;
  sourceIndexKey: string;
  destinationProviderKey: string;
  destinationIndexKey: string;
  batchSize: number | '';
}

export default function CreateVectorMigrationModal({
  opened,
  onClose,
  providers,
  indexesByProvider,
  onCreated,
}: CreateVectorMigrationModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const wasOpenedRef = useRef(false);

  const activeProviders = useMemo(
    () => providers.filter((p) => p.status !== 'disabled'),
    [providers],
  );

  const providerOptions = useMemo(
    () =>
      activeProviders.map((p) => ({
        value: p.key,
        label: p.label,
      })),
    [activeProviders],
  );

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      sourceProviderKey: activeProviders[0]?.key ?? '',
      sourceIndexKey: '',
      destinationProviderKey: activeProviders[0]?.key ?? '',
      destinationIndexKey: '',
      batchSize: 100,
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      sourceProviderKey: (v) => (!v ? 'Select a source provider' : null),
      sourceIndexKey: (v) => (!v ? 'Select a source index' : null),
      destinationProviderKey: (v) => (!v ? 'Select a destination provider' : null),
      destinationIndexKey: (v) => (!v ? 'Select a destination index' : null),
    },
  });

  const { values: formValues, setFieldValue, reset } = form;

  const sourceIndexOptions = useMemo(
    () =>
      (indexesByProvider[formValues.sourceProviderKey] ?? []).map((idx) => ({
        value: idx.key,
        label: idx.name,
      })),
    [indexesByProvider, formValues.sourceProviderKey],
  );

  const destinationIndexOptions = useMemo(
    () =>
      (indexesByProvider[formValues.destinationProviderKey] ?? []).map((idx) => ({
        value: idx.key,
        label: idx.name,
      })),
    [indexesByProvider, formValues.destinationProviderKey],
  );

  // Reset source index when source provider changes
  useEffect(() => {
    setFieldValue('sourceIndexKey', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formValues.sourceProviderKey]);

  // Reset destination index when destination provider changes
  useEffect(() => {
    setFieldValue('destinationIndexKey', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formValues.destinationProviderKey]);

  useEffect(() => {
    if (!opened) {
      if (wasOpenedRef.current) {
        reset();
        wasOpenedRef.current = false;
      }
    } else {
      wasOpenedRef.current = true;
      if (!formValues.sourceProviderKey && activeProviders.length > 0) {
        setFieldValue('sourceProviderKey', activeProviders[0].key);
      }
      if (!formValues.destinationProviderKey && activeProviders.length > 0) {
        setFieldValue('destinationProviderKey', activeProviders[0].key);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, activeProviders]);

  const sourceProvider = useMemo(
    () => activeProviders.find((p) => p.key === formValues.sourceProviderKey) ?? null,
    [activeProviders, formValues.sourceProviderKey],
  );
  const destinationProvider = useMemo(
    () => activeProviders.find((p) => p.key === formValues.destinationProviderKey) ?? null,
    [activeProviders, formValues.destinationProviderKey],
  );

  const sourceIndex = useMemo(
    () =>
      (indexesByProvider[formValues.sourceProviderKey] ?? []).find(
        (idx) => idx.key === formValues.sourceIndexKey,
      ) ?? null,
    [indexesByProvider, formValues.sourceProviderKey, formValues.sourceIndexKey],
  );
  const destinationIndex = useMemo(
    () =>
      (indexesByProvider[formValues.destinationProviderKey] ?? []).find(
        (idx) => idx.key === formValues.destinationIndexKey,
      ) ?? null,
    [indexesByProvider, formValues.destinationProviderKey, formValues.destinationIndexKey],
  );

  const validIdentity = Boolean(formValues.name.trim());
  const validSource = Boolean(formValues.sourceProviderKey && formValues.sourceIndexKey);
  const validDestination = Boolean(
    formValues.destinationProviderKey && formValues.destinationIndexKey,
  );
  const sameEndpoints =
    formValues.sourceProviderKey === formValues.destinationProviderKey &&
    formValues.sourceIndexKey === formValues.destinationIndexKey &&
    Boolean(formValues.sourceIndexKey);

  const checklist = [
    { id: 1, label: 'Migration name set', done: validIdentity },
    { id: 2, label: 'Source provider & index', done: validSource },
    { id: 3, label: 'Destination provider & index', done: validDestination },
    { id: 4, label: 'Source ≠ Destination', done: validSource && validDestination && !sameEndpoints },
  ];

  const submit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    if (
      values.sourceProviderKey === values.destinationProviderKey &&
      values.sourceIndexKey === values.destinationIndexKey
    ) {
      form.setErrors({ destinationIndexKey: 'Source and destination indexes cannot be the same' });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/vector/migrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || undefined,
          sourceProviderKey: values.sourceProviderKey,
          sourceIndexKey: values.sourceIndexKey,
          destinationProviderKey: values.destinationProviderKey,
          destinationIndexKey: values.destinationIndexKey,
          batchSize: values.batchSize || undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to create migration');
      }

      const data = await response.json();
      notifications.show({
        color: 'teal',
        title: 'Migration created',
        message: `"${values.name}" is ready to start.`,
      });
      onCreated(data.migration as IVectorMigration);
      onClose();
      reset();
    } catch (error: unknown) {
      notifications.show({
        color: 'red',
        title: 'Unable to create migration',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    validIdentity && validSource && validDestination && !sameEndpoints && activeProviders.length > 0;

  const summary = (
    <>
      <SummaryGroup title="Migration">
        <SummaryKV
          label="Name"
          value={formValues.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Batch size"
          value={formValues.batchSize ? String(formValues.batchSize) : '100'}
          mono
        />
      </SummaryGroup>

      <SummaryGroup title="Source">
        <SummaryKV
          label="Provider"
          value={sourceProvider?.label || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Index"
          value={sourceIndex?.name || <span className="ds-faint">—</span>}
        />
        {sourceProvider ? (
          <SummaryKV label="Driver" value={sourceProvider.driver} mono />
        ) : null}
      </SummaryGroup>

      <SummaryGroup title="Destination">
        <SummaryKV
          label="Provider"
          value={destinationProvider?.label || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Index"
          value={destinationIndex?.name || <span className="ds-faint">—</span>}
        />
        {destinationProvider ? (
          <SummaryKV label="Driver" value={destinationProvider.driver} mono />
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
      icon={<IconTransfer size={16} />}
      title="Create vector migration"
      subtitle="Move vectors between indexes — runs as a background job you can monitor in real time."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Create migration',
        icon: <IconArrowRight size={13} />,
        loading: submitting,
        disabled: !canSubmit,
        onClick: submit,
      }}
    >
      <FormSection
        number={1}
        title="Identity"
        description="How this migration is identified in the dashboard."
        done={validIdentity}
      >
        <FormRow cols={1}>
          <FormField label="Migration name" required>
            <TextInput
              placeholder="e.g. Migrate documents to new index"
              {...form.getInputProps('name')}
            />
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

      <FormSection
        number={2}
        title="Source"
        description="Where vectors are read from."
        done={validSource}
      >
        <FormRow cols={2}>
          <FormField label="Source provider" required>
            <Select
              placeholder="Select provider"
              data={providerOptions}
              value={formValues.sourceProviderKey}
              onChange={(v) => setFieldValue('sourceProviderKey', v ?? '')}
              searchable
              error={form.errors.sourceProviderKey}
            />
          </FormField>
          <FormField label="Source index" required>
            <Select
              placeholder={sourceIndexOptions.length === 0 ? 'No indexes available' : 'Select index'}
              data={sourceIndexOptions}
              value={formValues.sourceIndexKey}
              onChange={(v) => setFieldValue('sourceIndexKey', v ?? '')}
              disabled={sourceIndexOptions.length === 0}
              error={form.errors.sourceIndexKey}
              searchable
            />
          </FormField>
        </FormRow>
        {sourceProvider ? (
          <div
            className="ds-card ds-card-pad-sm"
            style={{ marginTop: 12, background: 'var(--ds-surface-1)' }}
          >
            <div className="ds-row ds-gap-sm" style={{ marginBottom: 4 }}>
              <span style={{ fontWeight: 600 }}>{sourceProvider.label}</span>
              <span
                className={`ds-badge ${sourceProvider.status === 'active' ? 'ds-badge-ok' : 'ds-badge-warn'}`}
              >
                {sourceProvider.status}
              </span>
            </div>
            <div className="ds-faint" style={{ fontSize: 11.5 }}>
              driver: <span className="ds-mono">{sourceProvider.driver}</span>
            </div>
          </div>
        ) : null}
      </FormSection>

      <FormSection
        number={3}
        title="Destination"
        description="Where vectors are written to."
        done={validDestination}
      >
        <FormRow cols={2}>
          <FormField label="Destination provider" required>
            <Select
              placeholder="Select provider"
              data={providerOptions}
              value={formValues.destinationProviderKey}
              onChange={(v) => setFieldValue('destinationProviderKey', v ?? '')}
              searchable
              error={form.errors.destinationProviderKey}
            />
          </FormField>
          <FormField label="Destination index" required>
            <Select
              placeholder={destinationIndexOptions.length === 0 ? 'No indexes available' : 'Select index'}
              data={destinationIndexOptions}
              value={formValues.destinationIndexKey}
              onChange={(v) => setFieldValue('destinationIndexKey', v ?? '')}
              disabled={destinationIndexOptions.length === 0}
              error={form.errors.destinationIndexKey}
              searchable
            />
          </FormField>
        </FormRow>
        {destinationProvider ? (
          <div
            className="ds-card ds-card-pad-sm"
            style={{ marginTop: 12, background: 'var(--ds-surface-1)' }}
          >
            <div className="ds-row ds-gap-sm" style={{ marginBottom: 4 }}>
              <span style={{ fontWeight: 600 }}>{destinationProvider.label}</span>
              <span
                className={`ds-badge ${destinationProvider.status === 'active' ? 'ds-badge-ok' : 'ds-badge-warn'}`}
              >
                {destinationProvider.status}
              </span>
            </div>
            <div className="ds-faint" style={{ fontSize: 11.5 }}>
              driver: <span className="ds-mono">{destinationProvider.driver}</span>
            </div>
          </div>
        ) : null}
      </FormSection>

      <FormSection
        number={4}
        title="Options"
        description="Tuning parameters for the migration job."
      >
        <FormRow cols={1}>
          <FormField
            label="Batch size"
            hint="Number of vectors to migrate per batch (default: 100)."
          >
            <NumberInput
              placeholder="100"
              min={1}
              max={10000}
              {...form.getInputProps('batchSize')}
            />
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}
