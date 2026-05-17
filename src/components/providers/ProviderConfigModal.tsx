'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Center, Loader, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconPlug } from '@tabler/icons-react';
import type {
  ProviderDescriptor,
  ProviderFormField,
  ProviderFormSchema,
} from '@/lib/providers';
import type { ProviderDomain } from '@/lib/database';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';
import ProviderFormRenderer from './ProviderFormRenderer';
import {
  SERVICE_CATALOG,
  DOMAIN_LABELS,
  filterServiceCatalog,
  resolveServiceCatalogEntry,
  type ServiceCatalogEntry,
} from '@/lib/services/serviceCatalog';
import ServiceCard from '@/components/common/ui/ServiceCard';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';

type FormValues = Record<string, string | number | boolean | null | undefined> & {
  key: string;
  label: string;
  description?: string;
  driver: string;
  status: boolean;
};

export type ProviderConfigModalSubmitPayload = {
  providerId?: string;
  driver: string;
  values: {
    base: {
      key: string;
      label: string;
      description?: string;
      status: 'active' | 'disabled' | 'errored';
    };
    credentials: Record<string, unknown>;
    settings: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
};

export type ProviderConfigModalProps = {
  opened: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  drivers: ProviderDescriptor[];
  driversLoading?: boolean;
  provider?: ProviderConfigView;
  /** Currently selected domain (used in create mode). */
  domain?: ProviderDomain | null;
  /** Called when the user picks a domain in create mode. Parent should load drivers. */
  onDomainChange?: (domain: ProviderDomain) => void;
  onSubmit: (options: ProviderConfigModalSubmitPayload) => Promise<void>;
};

type FieldBuckets = {
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

function partitionValues(
  schema: ProviderFormSchema | null,
  values: Record<string, unknown>,
): FieldBuckets {
  const buckets: FieldBuckets = {
    credentials: {},
    settings: {},
    metadata: {},
  };

  if (!schema) return buckets;

  schema.sections.forEach((section) => {
    section.fields.forEach((field) => {
      const scope = field.scope ?? 'credentials';
      const value = values[field.name];
      if (
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim() === '')
      ) {
        return;
      }
      buckets[scope as keyof FieldBuckets][field.name] = value;
    });
  });

  return buckets;
}

function resolveInitialFieldValue(
  field: ProviderFormField,
  provider?: ProviderConfigView,
  mode: 'create' | 'edit' = 'create',
) {
  const scope = field.scope ?? 'credentials';
  if (mode === 'edit' && provider) {
    if (scope === 'settings') {
      return provider.settings?.[field.name] ?? field.defaultValue ?? '';
    }
    if (scope === 'metadata') {
      return provider.metadata?.[field.name] ?? field.defaultValue ?? '';
    }
    return field.defaultValue ?? '';
  }
  return field.defaultValue ?? '';
}

export default function ProviderConfigModal({
  opened,
  onClose,
  mode,
  drivers,
  driversLoading = false,
  provider,
  domain,
  onDomainChange,
  onSubmit,
}: ProviderConfigModalProps) {
  const [schema, setSchema] = useState<ProviderFormSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedService, setSelectedService] =
    useState<ServiceCatalogEntry | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [selectedDriver, setSelectedDriver] = useState<string>(
    provider?.driver ?? drivers[0]?.id ?? '',
  );

  const filteredServices = useMemo(
    () =>
      filterServiceCatalog({
        query: catalogQuery,
        domain: domain ?? 'all',
      }),
    [catalogQuery, domain],
  );

  const form = useForm<FormValues>({
    initialValues: {
      key: provider?.key ?? '',
      label: provider?.label ?? '',
      description: provider?.description ?? '',
      driver: provider?.driver ?? drivers[0]?.id ?? '',
      status: provider?.status !== 'disabled',
    },
    validate: {
      key: (v: FormValues[keyof FormValues]) =>
        !v || typeof v !== 'string' || !v.trim() ? 'Key is required' : null,
      label: (v: FormValues[keyof FormValues]) =>
        !v || typeof v !== 'string' || !v.trim() ? 'Label is required' : null,
    },
  });

  useEffect(() => {
    if (!opened) return;
    setSelectedDriver(provider?.driver ?? drivers[0]?.id ?? '');
    form.setValues({
      key: provider?.key ?? '',
      label: provider?.label ?? '',
      description: provider?.description ?? '',
      driver: provider?.driver ?? drivers[0]?.id ?? '',
      status: provider?.status !== 'disabled',
    });
    if (provider?.driver) {
      setSelectedService(
        resolveServiceCatalogEntry({
          serviceId:
            provider.metadata && typeof provider.metadata.serviceCatalogId === 'string'
              ? provider.metadata.serviceCatalogId
              : undefined,
          driver: provider.driver,
          domain: (provider.type ?? undefined) as ProviderDomain | undefined,
          key: provider.key,
          label: provider.label,
        }) ?? null,
      );
    } else {
      setSelectedService(null);
      setCatalogQuery('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, provider, drivers]);

  const handlePickService = (service: ServiceCatalogEntry) => {
    setSelectedService(service);
    // First domain advertised by the service is used to scope the backend driver load.
    const domainToUse: ProviderDomain = service.domains[0];
    if (domainToUse && domainToUse !== domain) {
      onDomainChange?.(domainToUse);
    }
    setSelectedDriver(service.driver);
    // Auto-suggest label/key if user hasn't typed anything yet
    if (!form.values.label) {
      form.setFieldValue('label', service.name);
    }
    if (!form.values.key) {
      const slug = service.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      form.setFieldValue('key', slug);
    }
  };

  useEffect(() => {
    if (!opened || !selectedDriver) {
      setSchema(null);
      return;
    }

    let aborted = false;

    async function loadSchema() {
      setSchemaError(null);
      setSchemaLoading(true);
      try {
        const response = await fetch(
          `/api/providers/drivers/${selectedDriver}/form`,
        );
        if (!response.ok) throw new Error('Failed to load provider form schema');
        const data = await response.json();
        if (!aborted) setSchema(data.schema);
      } catch (error) {
        if (!aborted) {
          console.error(error);
          setSchemaError(
            error instanceof Error ? error.message : 'Unable to load form',
          );
          setSchema(null);
        }
      } finally {
        if (!aborted) setSchemaLoading(false);
      }
    }

    void loadSchema();
    return () => {
      aborted = true;
    };
  }, [opened, selectedDriver]);

  useEffect(() => {
    if (!schema) return;
    const fieldValues: Record<string, FormValues[keyof FormValues]> = {};
    schema.sections.forEach((section) => {
      section.fields.forEach((field) => {
        fieldValues[field.name] = resolveInitialFieldValue(
          field,
          provider,
          mode,
        ) as FormValues[keyof FormValues];
      });
    });
    form.setValues((current) => ({
      ...current,
      ...fieldValues,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, provider, mode]);

  const selectedDriverDescriptor = drivers.find(
    (driver) => driver.id === selectedDriver,
  );

  const isCreate = mode === 'create';
  const validService = !isCreate || Boolean(selectedService);
  const validDriver = Boolean(selectedDriver);
  const validIdentity = Boolean(form.values.key && form.values.label);
  const validConfig = !schemaError && !schemaLoading;

  const checklist = [
    ...(isCreate
      ? [{ id: 0, label: 'Service selected', done: validService }]
      : []),
    { id: 2, label: 'Key and label set', done: validIdentity },
    {
      id: 3,
      label: schema ? 'Configuration loaded' : 'Loading configuration…',
      done: validConfig && schema !== null,
    },
  ];

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;

    if (!selectedDriver) {
      notifications.show({
        color: 'red',
        title: 'Driver missing',
        message: 'Please select a provider driver before saving.',
      });
      return;
    }

    const values = form.getValues();
    const buckets = partitionValues(schema, values);

    setSubmitting(true);
    try {
      const metadata = {
        ...(provider?.metadata ?? {}),
        ...buckets.metadata,
        ...(selectedService ? { serviceCatalogId: selectedService.id } : {}),
      };

      await onSubmit({
        providerId: provider?._id as string | undefined,
        driver: selectedDriver,
        values: {
          base: {
            key: values.key,
            label: values.label,
            description: values.description,
            status: values.status ? 'active' : 'disabled',
          },
          credentials: buckets.credentials,
          settings: buckets.settings,
          metadata,
        },
      });
      onClose();
      form.reset();
      setSchema(null);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Failed to save provider',
        message:
          error instanceof Error ? error.message : 'Unexpected error occurred',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const title = mode === 'create' ? 'Add provider' : 'Edit provider';
  const subtitle =
    mode === 'edit' && provider ? (
      <>
        Editing <strong style={{ color: 'var(--ds-text)' }}>{provider.label}</strong>
      </>
    ) : (
      'Connect a new tenant-wide provider. Drivers expose their own configuration form.'
    );

  const driverLabel =
    selectedDriverDescriptor?.display.label ?? selectedDriver ?? null;

  const summary = (
    <>
      <SummaryGroup title="Service">
        {selectedService ? (
          <>
            <div style={{ marginBottom: 12 }}>
              <ServiceCard service={selectedService} compact />
            </div>
            <SummaryKV label="Driver" value={driverLabel ?? '—'} mono />
            <SummaryKV
              label="Domain"
              value={DOMAIN_LABELS[selectedService.domains[0]] ?? selectedService.domains[0]}
            />
          </>
        ) : (
          <SummaryKV label="—" value="Pick a service" />
        )}
      </SummaryGroup>

      <SummaryGroup title="Identity">
        <SummaryKV
          label="Key"
          value={form.values.key || <span className="ds-faint">—</span>}
          mono
        />
        <SummaryKV
          label="Label"
          value={form.values.label || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Status"
          value={
            <span
              className={`ds-badge ${form.values.status ? 'ds-badge-ok' : 'ds-badge-warn'}`}
            >
              {form.values.status ? 'active' : 'disabled'}
            </span>
          }
        />
      </SummaryGroup>

      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const canSubmit =
    !driversLoading &&
    !schemaLoading &&
    !schemaError &&
    validService &&
    validDriver &&
    validIdentity;

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconPlug size={16} />}
      title={title}
      subtitle={subtitle}
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: mode === 'create' ? 'Create provider' : 'Save changes',
        loading: submitting,
        disabled: !canSubmit,
        onClick: () => void handleSubmit(),
      }}
    >
      {isCreate ? (
        <FormSection
          number={1}
          title="Service"
          description="Pick the service you want to connect. We'll auto-fill the right driver and form."
          done={Boolean(selectedService)}
        >
          <div
            className="ds-toolbar"
            style={{
              marginBottom: 12,
              padding: 0,
              border: 'none',
              background: 'transparent',
            }}
          >
            <div className="ds-toolbar-search" style={{ flex: 1, maxWidth: 380 }}>
              <input
                placeholder="Search services by name, alias, or tag…"
                value={catalogQuery}
                onChange={(e) => setCatalogQuery(e.target.value)}
                aria-label="Search services"
              />
            </div>
            <select
              className="ds-select"
              value={domain ?? 'all'}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'all') {
                  onDomainChange?.(SERVICE_CATALOG[0].domains[0]);
                  return;
                }
                onDomainChange?.(v as ProviderDomain);
              }}
              aria-label="Filter by domain"
              style={{ minWidth: 160 }}
            >
              {(['all', 'model', 'embedding', 'vector', 'file', 'datasource'] as const).map(
                (d) => (
                  <option key={d} value={d}>
                    {d === 'all' ? 'All domains' : DOMAIN_LABELS[d]}
                  </option>
                ),
              )}
            </select>
          </div>

          {filteredServices.length === 0 ? (
            <div className="ds-empty" style={{ padding: 24 }}>
              <span className="ds-muted" style={{ fontSize: 13 }}>
                No services match your filter.
              </span>
            </div>
          ) : (
            <div className="service-card-grid">
              {filteredServices.map((s) => (
                <ServiceCard
                  key={s.id}
                  service={s}
                  selected={selectedService?.id === s.id}
                  onClick={() => handlePickService(s)}
                />
              ))}
            </div>
          )}
        </FormSection>
      ) : null}

      <FormSection
        number={isCreate ? 2 : 1}
        title="Identity"
        description="How this provider is identified in the console and APIs."
        done={validIdentity}
      >
        <FormRow cols={2}>
          <FormField
            label="Key"
            required
            hint={
              mode === 'edit' ? 'Key is immutable.' : 'Used to reference the provider.'
            }
          >
            <TextInput
              placeholder="unique-key"
              disabled={mode === 'edit'}
              {...form.getInputProps('key')}
            />
          </FormField>
          <FormField label="Label" required>
            <TextInput placeholder="Display name" {...form.getInputProps('label')} />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              placeholder="Optional description"
              minRows={2}
              autosize
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
        <ToggleList>
          <ToggleRow
            label="Active"
            description="Inactive providers cannot be used by dependent modules."
            checked={Boolean(form.values.status)}
            onChange={(v) => form.setFieldValue('status', v)}
          />
        </ToggleList>
      </FormSection>

      {schemaLoading ? (
        <FormSection number={isCreate ? 3 : 2} title="Configuration">
          <Center py="md">
            <Loader size="sm" color="teal" />
          </Center>
        </FormSection>
      ) : null}

      {schemaError ? (
        <FormSection number={isCreate ? 3 : 2} title="Configuration">
          <Alert
            icon={<IconAlertCircle size={16} />}
            color="red"
            title="Configuration unavailable"
          >
            {schemaError}
          </Alert>
        </FormSection>
      ) : null}

      {schema && !schemaLoading && !schemaError ? (
        <ProviderFormRenderer
          schema={schema}
          form={form}
          sectionStart={isCreate ? 3 : 2}
        />
      ) : null}
    </FormShell>
  );
}
