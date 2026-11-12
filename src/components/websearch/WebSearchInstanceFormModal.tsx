'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Center, Loader, Select, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconPlus, IconWorldSearch } from '@tabler/icons-react';
import type { ProviderFormSchema } from '@/lib/providers/types';
import type { WebSearchInstanceView } from '@/lib/services/webSearch/webSearchInstanceView';
import { useTranslations } from '@/lib/i18n';
import { isApiError } from '@/lib/api/client';
import { useCreateWebSearchInstance, useUpdateWebSearchInstance } from '@/lib/api/queries/websearch';
import ProviderFormRenderer from '@/components/providers/ProviderFormRenderer';
import { allFields, providerRequestError, ProviderRequestError } from '@/components/providers/providerFormModel';
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
import { useInstanceOptionsForm } from './useInstanceOptionsForm';
import { instanceKeyFromName, instanceSettingsFromForm, type WebSearchProviderOption } from './webSearchModel';

export interface WebSearchInstanceFormModalProps {
  opened: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  /** The instance an edit changes. */
  instance?: WebSearchInstanceView | null;
  /** Create: the web search providers visible in the project. */
  providers?: WebSearchProviderOption[];
  providersLoading?: boolean;
  /** Create: the picked provider. The parent holds it, so that a provider added meanwhile comes back picked. */
  providerKey?: string | null;
  onProviderKeyChange?: (key: string | null) => void;
  /** Create: adds a provider (the parent opens the provider form, then this form again). */
  onNewProvider?: () => void;
  /** Owners and admins: offer an instance for all projects. */
  canSetTenantWide?: boolean;
  /** A change starts the form over (a new create, another instance); reopening after adding a provider keeps it. */
  resetKey?: string | number;
  onSaved: (instance: WebSearchInstanceView) => void;
}

type IdentityField = 'name' | 'key' | 'providerKey' | 'description';
const IDENTITY_FIELDS: readonly string[] = ['name', 'key', 'providerKey', 'description'] satisfies IdentityField[];

/**
 * Creates or edits a web search instance: the provider it searches through (picked at creation), its name and key,
 * and its search options (see `useInstanceOptionsForm`). The AI answer and the cache are set on the instance page.
 */
export default function WebSearchInstanceFormModal({
  opened,
  onClose,
  mode,
  instance,
  providers = [],
  providersLoading = false,
  providerKey = null,
  onProviderKeyChange,
  onNewProvider,
  canSetTenantWide = false,
  resetKey,
  onSaved,
}: WebSearchInstanceFormModalProps) {
  const t = useTranslations('webSearch.form');
  const tPlatform = useTranslations('webSearch.platform');
  const tScope = useTranslations('webSearch.scope');
  const isCreate = mode === 'create';

  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [active, setActive] = useState(true);
  const [tenantWide, setTenantWide] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<IdentityField, string>>>({});
  const [saving, setSaving] = useState(false);
  const createInstance = useCreateWebSearchInstance();
  const updateInstance = useUpdateWebSearchInstance();
  const options = useForm<Record<string, unknown>>({ initialValues: {} });

  const provider: WebSearchProviderOption | null = useMemo(() => {
    if (!isCreate) return instance?.provider ?? null;
    return providers.find((candidate) => candidate.key === providerKey) ?? null;
  }, [isCreate, instance, providers, providerKey]);
  const { form: optionsForm, failed: optionsFailed } = useInstanceOptionsForm(provider, opened);

  // Only `resetKey` starts the form over (see the prop).
  useEffect(() => {
    const editing = !isCreate && instance ? instance : null;
    setName(editing?.name ?? '');
    setKey(editing?.key ?? '');
    setKeyEdited(false);
    setDescription(editing?.description ?? '');
    setActive(editing ? editing.status === 'active' : true);
    setTenantWide(false);
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // The options start from what the instance stores (an edit) or the defaults; another form starts them over.
  useEffect(() => {
    if (!optionsForm) return;
    const stored = !isCreate ? instance?.settings ?? {} : {};
    const values: Record<string, unknown> = {};
    for (const field of allFields(optionsForm)) {
      values[field.name] = stored[field.name] ?? field.defaultValue ?? (field.type === 'select' ? null : '');
    }
    options.setInitialValues(values);
    options.setValues(values);
    options.clearErrors();
    // `options` is the form handle; `instance` is read when the form is started over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsForm, resetKey]);

  const optionsSection = useMemo<ProviderFormSchema | null>(() => {
    const fields = allFields(optionsForm);
    return fields.length > 0
      ? { sections: [{ title: t('optionsSection'), description: t('optionsDescription'), fields }] }
      : null;
  }, [optionsForm, t]);

  const changeName = (value: string) => {
    setName(value);
    if (isCreate && !keyEdited) setKey(instanceKeyFromName(value));
  };

  /** A refusal that names a field of this form is shown on that field. */
  const markRefusal = (error: ProviderRequestError) => {
    const field = error.field;
    if (!field) return;
    if (IDENTITY_FIELDS.includes(field)) {
      setErrors((current) => ({ ...current, [field]: error.message }));
    } else if (allFields(optionsForm).some((candidate) => candidate.name === field)) {
      options.setFieldError(field, error.message);
    }
  };

  const save = async () => {
    const missing: Partial<Record<IdentityField, string>> = {};
    if (!name.trim()) missing.name = t('nameRequired');
    if (isCreate && !key.trim()) missing.key = t('keyRequired');
    setErrors(missing);
    options.clearErrors();
    if (Object.keys(missing).length > 0 || !provider || !optionsForm) return;

    const settings = instanceSettingsFromForm(optionsForm, options.getValues(), isCreate ? undefined : instance?.settings);
    const status = active ? 'active' : 'disabled';
    setSaving(true);
    try {
      let saved: WebSearchInstanceView;
      try {
        saved = isCreate
          ? await createInstance.mutateAsync({
            key: key.trim(),
            name: name.trim(),
            description: description.trim() || undefined,
            providerKey: provider.key,
            status,
            settings,
            tenantWide: canSetTenantWide && tenantWide,
          })
          : await updateInstance.mutateAsync({
            key: instance!.key,
            body: { name: name.trim(), description: description.trim(), status, settings },
          });
      } catch (failure) {
        if (!isApiError(failure)) throw failure;
        const refusal = providerRequestError(failure.payload, t(isCreate ? 'createFailed' : 'saveFailed'));
        // A taken key is refused without naming a field: it is the key that was typed.
        throw isCreate && failure.status === 409 ? new ProviderRequestError(refusal.message, 'key') : refusal;
      }
      notifications.show({ color: 'teal', title: t(isCreate ? 'created' : 'saved'), message: saved.name });
      onSaved(saved);
    } catch (error) {
      if (error instanceof ProviderRequestError) markRefusal(error);
      notifications.show({
        color: 'red',
        title: t(isCreate ? 'createFailed' : 'saveFailed'),
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const providerOptions = providers.map((candidate) => {
    const notes = [
      candidate.platform ? tPlatform('badge') : null,
      candidate.status !== 'active' ? t('providerDisabled') : null,
    ].filter(Boolean);
    return {
      value: candidate.key,
      label: `${candidate.label} (${candidate.key})${notes.length ? ` · ${notes.join(' · ')}` : ''}`,
    };
  });

  const identityDone = Boolean(name.trim() && key.trim());
  const checklist = [
    { id: 'provider', label: t('checkProvider'), done: Boolean(provider) },
    { id: 'identity', label: t('checkIdentity'), done: identityDone },
  ];

  // The options section waits for its form; a provider without options says so.
  let optionsState: ReactNode = null;
  if (provider && optionsFailed) {
    optionsState = (
      <Alert icon={<IconAlertCircle size={16} />} color="red">
        {t('optionsFailed')}
      </Alert>
    );
  } else if (provider && !optionsForm) {
    optionsState = (
      <Center py="md" aria-label={t('optionsLoading')}>
        <Loader size="sm" color="teal" />
      </Center>
    );
  } else if (provider && !optionsSection) {
    optionsState = <span className="ds-faint" style={{ fontSize: 12 }}>{t('optionsNone')}</span>;
  }

  const platformBadge = <span className="ds-badge ds-badge-info">{tPlatform('badge')}</span>;
  const summary = (
    <>
      <SummaryGroup title={t('providerSection')}>
        <SummaryKV
          label={t('providerLabel')}
          value={provider ? <>{provider.label} {provider.platform ? platformBadge : null}</> : <span className="ds-faint">—</span>}
        />
        {provider ? <SummaryKV label={t('engine')} value={provider.driver} mono /> : null}
      </SummaryGroup>
      <SummaryGroup title={t('identitySection')}>
        <SummaryKV label={t('key')} value={key || <span className="ds-faint">—</span>} mono />
        <SummaryKV label={t('name')} value={name || <span className="ds-faint">—</span>} />
        {isCreate ? (
          <SummaryKV label={t('scope')} value={canSetTenantWide && tenantWide ? tScope('tenant') : tScope('project')} />
        ) : null}
      </SummaryGroup>
      <SummaryGroup>
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconWorldSearch size={16} />}
      title={t(isCreate ? 'titleCreate' : 'titleEdit')}
      subtitle={isCreate ? t('subtitleCreate') : t('subtitleEdit', { name: instance?.name ?? '' })}
      summary={summary}
      footerStatus={t('ready', { done: checklist.filter((item) => item.done).length, total: checklist.length })}
      primaryAction={{
        label: t(isCreate ? 'create' : 'save'),
        loading: saving,
        disabled: saving || !provider || !optionsForm,
        onClick: () => void save(),
      }}
    >
      <FormSection number={1} title={t('providerSection')} description={t('providerSectionDescription')} done={Boolean(provider)}>
        {isCreate ? (
          <FormRow cols={1}>
            <FormField
              label={t('providerLabel')}
              required
              hint={!providersLoading && providers.length === 0 ? t('providersNone') : undefined}
              action={onNewProvider ? (
                <Button variant="subtle" size="compact-xs" leftSection={<IconPlus size={12} />} onClick={onNewProvider}>
                  {t('newProvider')}
                </Button>
              ) : undefined}
            >
              <Select
                placeholder={t('providerPlaceholder')}
                data={providerOptions}
                value={providerKey}
                onChange={(value) => onProviderKeyChange?.(value)}
                searchable
                disabled={providersLoading}
                error={errors.providerKey}
                nothingFoundMessage={t('providersNone')}
              />
            </FormField>
          </FormRow>
        ) : (
          <div className="ds-row" style={{ gap: 8, alignItems: 'center', fontSize: 13 }}>
            <span>{provider?.label ?? instance?.providerKey}</span>
            <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{instance?.providerKey}</span>
            {provider ? <span className="ds-badge">{provider.driver}</span> : null}
            {provider?.platform ? platformBadge : null}
          </div>
        )}
      </FormSection>

      <FormSection number={2} title={t('identitySection')} description={t('identityDescription')} done={identityDone}>
        <FormRow cols={2}>
          <FormField label={t('name')} required>
            <TextInput
              placeholder={t('namePlaceholder')}
              value={name}
              onChange={(e) => changeName(e.currentTarget.value)}
              error={errors.name}
            />
          </FormField>
          <FormField label={t('key')} required hint={isCreate ? t('keyHint') : t('keyHintEdit')}>
            <TextInput
              placeholder="docs-search"
              value={key}
              disabled={!isCreate}
              onChange={(e) => {
                setKey(e.currentTarget.value);
                setKeyEdited(true);
              }}
              error={errors.key}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('description')} optional>
            <Textarea
              placeholder={t('descriptionPlaceholder')}
              minRows={2}
              autosize
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              error={errors.description}
            />
          </FormField>
        </FormRow>
        <ToggleList>
          <ToggleRow label={t('active')} description={t('activeDescription')} checked={active} onChange={setActive} />
          {isCreate && canSetTenantWide ? (
            <ToggleRow
              label={t('tenantWide')}
              description={t('tenantWideDescription')}
              checked={tenantWide}
              onChange={setTenantWide}
            />
          ) : null}
        </ToggleList>
      </FormSection>

      {optionsState ? (
        <FormSection number={3} title={t('optionsSection')} description={t('optionsDescription')}>
          {optionsState}
        </FormSection>
      ) : null}
      {!optionsState && optionsSection ? (
        <ProviderFormRenderer schema={optionsSection} form={options} sectionStart={3} />
      ) : null}
    </FormShell>
  );
}
