'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Center, Loader, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconCheck, IconPlayerPlay, IconPlug, IconX } from '@tabler/icons-react';
import type {
  ProviderDescriptor,
  ProviderFormField,
  ProviderFormSchema,
} from '@/lib/providers';
import type { ProviderDomain } from '@/lib/database';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';
import ProviderFormRenderer from './ProviderFormRenderer';
import ProviderTestSteps from './ProviderTestSteps';
import ProviderAssignStep, { ProjectPicker, useTenantProjects } from './ProviderAssignStep';
import { useTranslations } from '@/lib/i18n';
import {
  foundCount,
  formatLatency,
  testState,
  type ProviderTestResult,
} from './providerAccessModel';
import {
  missingRequiredFields,
  partitionProviderValues,
  ProviderRequestError,
  storedCredentialFields,
  visibleSections,
} from './providerFormModel';
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
  /** Projects picked in the Projects section (create mode). */
  projectIds: string[];
};

/** What a create `onSubmit` may hand back so the modal can offer the assign step. */
export type CreatedProviderSummary = { id: string; name: string; domain: string; key?: string };

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
  /** Create mode may resolve with the created provider; the modal then runs the assign step. */
  onSubmit: (
    options: ProviderConfigModalSubmitPayload,
  ) => Promise<void | CreatedProviderSummary>;
  /** Projects preselected in the Projects section (create mode). */
  initialProjectIds?: string[];
  /** Called once a provider was created (before the assign step, if any). */
  onCreated?: (provider: { id: string; name: string; domain: string }) => void;
  /** When true, never show the post-create assign step. */
  skipAssignStep?: boolean;
  /** Hide the Projects section (callers whose create call already fixes the project). */
  hideProjects?: boolean;
};

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

const INVALID_FIELD_SELECTOR = '.form-overlay [aria-invalid="true"], .form-overlay [data-invalid="true"]';

/** How often, and how far apart, the form is looked at again when the message is not drawn yet. */
const FOCUS_RETRIES = 20;
const FOCUS_RETRY_MS = 25;

/**
 * Brings the first field that shows a message into view: the form can be taller than the screen. A password box marks
 * itself with `data-invalid` only (its `aria-invalid` is left unset), so both marks are looked for. The message is
 * drawn by the render that follows the state update, which can come after the first look on a busy page: the form is
 * looked at again a few times before giving up.
 */
function focusFirstInvalidField(attempt = 0) {
  setTimeout(() => {
    const invalid = document.querySelector<HTMLElement>(INVALID_FIELD_SELECTOR);
    if (!invalid) {
      if (attempt < FOCUS_RETRIES) focusFirstInvalidField(attempt + 1);
      return;
    }
    invalid.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    invalid.focus?.({ preventScroll: true });
  }, attempt === 0 ? 0 : FOCUS_RETRY_MS);
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
  initialProjectIds,
  onCreated,
  skipAssignStep = false,
  hideProjects = false,
}: ProviderConfigModalProps) {
  const t = useTranslations('providerAccess');
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

  const [projectIds, setProjectIds] = useState<Set<string>>(new Set(initialProjectIds ?? []));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<CreatedProviderSummary | null>(null);

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
    setProjectIds(new Set(initialProjectIds ?? []));
    setTestResult(null);
    setTestError(null);
    setSelectedDriver(provider?.driver ?? '');
    form.setValues({
      key: provider?.key ?? '',
      label: provider?.label ?? '',
      description: provider?.description ?? '',
      driver: provider?.driver ?? '',
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
    // Intentionally NOT depending on `drivers`: picking a service triggers a
    // domain change that reloads `drivers`, and re-running this reset would wipe
    // the user's in-progress selection (driver, auto-filled key/label) — forcing
    // them to pick the service twice. Initialization only happens on open/provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, provider]);

  // A result belongs to the driver it was run for.
  useEffect(() => {
    setTestResult(null);
    setTestError(null);
  }, [selectedDriver]);

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
    // Messages of a form that is no longer on screen (another service, another provider) do not carry over.
    form.clearErrors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, provider, mode]);

  const selectedDriverDescriptor = drivers.find(
    (driver) => driver.id === selectedDriver,
  );

  const isCreate = mode === 'create';
  // The API never returns credentials, only which fields store one. While editing, a stored credential field opens
  // blank and a blank one keeps the stored value (the server merges it that way); one the record does not store
  // (the secret of a way to sign in it never used) has to be filled in.
  const storedFields = isCreate ? undefined : storedCredentialFields(schema, provider);
  // What the record holds: a setting that only shows the field's default is not something the edit changes.
  const storedValues = isCreate ? undefined : { settings: provider?.settings, metadata: provider?.metadata };
  // The saved provider this form edits: its test route merges what is typed here over what is stored.
  const savedProviderId = !isCreate && provider?._id ? String(provider._id) : null;
  // The fields that apply to the form as it stands, and how many sections they fill (`visibleWhen` hides the rest).
  const shownSections = visibleSections(schema, form.values);
  const allFieldNames = new Set(shownSections.flatMap((entry) => entry.fields.map((field) => field.name)));
  const showProjects = isCreate && !hideProjects;
  const { projects: tenantProjects, loading: projectsLoading, error: projectsError } =
    useTenantProjects(opened && showProjects);
  const effectiveDomain = (domain ?? selectedService?.domains[0] ?? null) as ProviderDomain | null;
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

  const handleTest = async () => {
    if (!selectedDriver || (!savedProviderId && !effectiveDomain)) {
      setTestError(t('test.needService'));
      return;
    }
    const buckets = partitionProviderValues(schema, form.getValues(), storedValues);
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      // A saved provider is tested through its own route: what is typed here is laid over what is stored (a blank
      // secret keeps the stored one), and nothing is saved. A new provider has nothing stored to fall back on.
      const res = savedProviderId
        ? await fetch(`/api/providers/${encodeURIComponent(savedProviderId)}/test`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ credentials: buckets.credentials, settings: buckets.settings }),
        })
        : await fetch('/api/providers/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: effectiveDomain,
            driver: selectedDriver,
            credentials: buckets.credentials,
            settings: buckets.settings,
          }),
        });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // A refused setting names its form field: mark it where it was typed.
        const field = typeof body?.field === 'string' ? body.field : null;
        if (field && allFieldNames.has(field) && typeof body?.error === 'string') {
          form.setFieldError(field, body.error);
        }
        throw new Error(body?.error || t('test.requestFailed'));
      }
      setTestResult(body as ProviderTestResult);
    } catch (error) {
      setTestError(error instanceof Error ? error.message : t('test.requestFailed'));
    } finally {
      setTesting(false);
    }
  };

  const finish = () => {
    setAssignTarget(null);
    onClose();
    form.reset();
    setSchema(null);
    setTestResult(null);
  };

  const handleSubmit = async () => {
    // Messages left from an earlier attempt describe fields that may not apply any more.
    form.clearErrors();
    const validation = form.validate();
    // Required fields that apply to the form as it stands (a hidden field is not asked for).
    const missing = missingRequiredFields(schema, form.getValues(), { storedCredentialFields: storedFields });
    if (validation.hasErrors || missing.length > 0) {
      form.setErrors({
        ...validation.errors,
        ...Object.fromEntries(missing.map((field) => [field.name, t('form.required')])),
      });
      focusFirstInvalidField();
      return;
    }

    if (!selectedDriver) {
      notifications.show({
        color: 'red',
        title: 'Driver missing',
        message: 'Please select a provider driver before saving.',
      });
      return;
    }

    const values = form.getValues();
    const buckets = partitionProviderValues(schema, values, storedValues);

    setSubmitting(true);
    try {
      const metadata = {
        ...(provider?.metadata ?? {}),
        ...buckets.metadata,
        ...(selectedService ? { serviceCatalogId: selectedService.id } : {}),
      };

      const created = await onSubmit({
        projectIds: [...projectIds],
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
      if (isCreate && created && typeof created === 'object' && 'id' in created) {
        onCreated?.({ id: created.id, name: created.name, domain: created.domain });
        if (projectIds.size === 0 && !skipAssignStep) {
          setAssignTarget({ ...created, key: created.key ?? values.key });
          return;
        }
      }
      finish();
    } catch (error) {
      console.error(error);
      // A refused setting names its form field: mark it where it was typed, as a refused test does.
      if (error instanceof ProviderRequestError && error.field && allFieldNames.has(error.field)) {
        form.setFieldError(error.field, error.message);
        focusFirstInvalidField();
      }
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

      {showProjects ? (
        <SummaryGroup title={t('projects.sectionTitle')}>
          <SummaryKV
            label={t('projects.sectionTitle')}
            value={t('projects.selected', { count: projectIds.size })}
          />
        </SummaryGroup>
      ) : null}

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

  const configEnd = (isCreate ? 3 : 2) + shownSections.length;
  const found = testResult ? foundCount(testResult.details) : undefined;
  const foundIsDeployments = Boolean(testResult?.details?.deployments);
  const state = testResult ? testState(testResult) : null;

  return (
    <>
    <FormShell
      open={opened && !assignTarget}
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
              {(
                [
                  'all',
                  'model',
                  'embedding',
                  'vector',
                  'file',
                  'datasource',
                  'stt',
                  'tts',
                  'ocr',
                  'websearch',
                ] as const
              ).map((d) => (
                <option key={d} value={d}>
                  {d === 'all' ? 'All domains' : DOMAIN_LABELS[d]}
                </option>
              ))}
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
          storedSecretPlaceholder={storedFields ? t('form.storedSecret') : undefined}
          storedCredentialFields={storedFields}
        />
      ) : null}

      <FormSection
        number={configEnd}
        title={t('test.sectionTitle')}
        description={
          savedProviderId
            ? `${t('test.sectionDescription')} ${t('test.editHint')}`
            : t('test.sectionDescription')
        }
      >
        <div className="ds-row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button
            variant="default"
            size="sm"
            leftSection={<IconPlayerPlay size={14} stroke={1.7} />}
            loading={testing}
            disabled={!selectedDriver || schemaLoading || Boolean(schemaError)}
            onClick={() => void handleTest()}
          >
            {testing ? t('test.running') : t('test.button')}
          </Button>
          {testResult && state ? (
            <div
              className="ds-row"
              style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
              role="status"
            >
              <span
                className={`ds-badge ${
                  state === 'ok' ? 'ds-badge-ok' : state === 'failed' ? 'ds-badge-err' : 'ds-badge-warn'
                }`}
              >
                {state === 'ok' ? (
                  <IconCheck size={11} stroke={2} />
                ) : state === 'failed' ? (
                  <IconX size={11} stroke={2} />
                ) : null}{' '}
                {t(`test.${state}`)}
              </span>
              {state !== 'unsupported' ? (
                <span className="ds-faint" style={{ fontSize: 12 }}>
                  {t('test.latency', { value: formatLatency(testResult.latencyMs) })}
                </span>
              ) : null}
              {found !== undefined ? (
                <span className="ds-faint" style={{ fontSize: 12 }}>
                  {t(foundIsDeployments ? 'test.foundDeployments' : 'test.foundModels', {
                    count: found,
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {testResult?.message ? (
          <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 8 }}>
            {testResult.message}
          </div>
        ) : null}
        <ProviderTestSteps steps={testResult?.details?.steps} />
        {testError ? (
          <Alert
            mt="sm"
            icon={<IconAlertCircle size={16} />}
            color="red"
            title={t('test.requestFailed')}
          >
            {testError}
          </Alert>
        ) : null}
      </FormSection>

      {showProjects ? (
        <FormSection
          number={configEnd + 1}
          title={t('projects.sectionTitle')}
          description={t('projects.sectionDescription')}
          done={projectIds.size > 0}
        >
          {projectsLoading ? (
            <Center py="md">
              <Loader size="sm" color="teal" />
            </Center>
          ) : projectsError ? (
            <Alert
              icon={<IconAlertCircle size={16} />}
              color="red"
              title={t('projects.loadFailed')}
            >
              {projectsError}
            </Alert>
          ) : (
            <>
              <ProjectPicker
                projects={tenantProjects}
                domain={effectiveDomain ?? 'model'}
                selected={projectIds}
                onChange={setProjectIds}
              />
              {projectIds.size === 0 ? (
                <div className="ds-faint" style={{ fontSize: 12, marginTop: 8 }}>
                  {t('projects.noneSelectedHint')}
                </div>
              ) : null}
            </>
          )}
        </FormSection>
      ) : null}
    </FormShell>
    {assignTarget ? (
      <ProviderAssignStep
        opened
        variant="created"
        provider={assignTarget}
        foundDeployments={testResult?.details?.deployments}
        onClose={finish}
      />
    ) : null}
    </>
  );
}
