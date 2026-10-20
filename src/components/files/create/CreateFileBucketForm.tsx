'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Alert, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconBucket, IconCheck } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import { useTranslations } from '@/lib/i18n';
import type { FileBucketView } from '@/lib/services/files';
import { canManageProviders, isProviderUsable } from '../list/providerModel';
import { StorageLocation } from '../shared';
import { useFilesAccess } from '../useFilesAccess';
import { useCreateBucket, useFileProviders } from '../useFilesQueries';
import {
  BUCKET_KEY_MAX,
  BUCKET_NAME_MAX,
  BUCKET_PREFIX_MAX,
  bucketKeyIssue,
  bucketNameIssue,
  bucketPrefixIssue,
  buildCreateBucketInput,
  classifyCreateFailure,
  effectiveBucketPrefix,
  normalizeKeyInput,
  slugifyBucketKey,
  storagePreview,
  type CreateFailure,
  type FailureField,
} from './bucketForm';
import { ProviderSection } from './ProviderSection';

export interface CreateFileBucketFormProps {
  /** Draw the full-screen form. Closing and opening it again starts from an empty form. */
  opened: boolean;
  onClose: () => void;
  /** The bucket the server created (already saved; the list is refreshed by `useCreateBucket`). */
  onCreated: (bucket: FileBucketView) => void;
}

/**
 * The "Create bucket" screen (a full-screen FormShell): the storage provider, the name and key, where inside the
 * provider the files go, and whether the bucket starts active.
 *
 * Not drawn for someone who can only read the Document Store (the button that opens it is not drawn either); the
 * server refuses a create from anybody else all the same.
 */
export function CreateFileBucketForm({ opened, onClose, onCreated }: CreateFileBucketFormProps) {
  const { canWrite } = useFilesAccess();
  if (!opened || !canWrite) return null;
  // Mounted only while open: every opening starts from an empty form.
  return <CreateBucketScreen onClose={onClose} onCreated={onCreated} />;
}

/** The field a failure is shown on, or `null` for the form as a whole. */
function failureField(failure: CreateFailure): FailureField | null {
  switch (failure.kind) {
    case 'duplicateKey':
      return 'key';
    case 'providerUnusable':
      return 'provider';
    case 'invalid':
      return failure.field;
    default:
      return null;
  }
}

function CreateBucketScreen({ onClose, onCreated }: Omit<CreateFileBucketFormProps, 'opened'>) {
  const t = useTranslations('files.create');
  const tCommon = useTranslations('files.common');
  const manageProviders = canManageProviders(useDashboardUser()?.role);

  const providersQuery = useFileProviders();
  const createBucket = useCreateBucket();
  const refetchProviders = providersQuery.refetch;

  const [providerKey, setProviderKey] = useState('');
  const [name, setName] = useState('');
  const [typedKey, setTypedKey] = useState('');
  const [description, setDescription] = useState('');
  const [prefix, setPrefix] = useState('');
  const [active, setActive] = useState(true);
  const [touched, setTouched] = useState({ name: false, key: false });
  const [attempted, setAttempted] = useState(false);
  const [failure, setFailure] = useState<CreateFailure | null>(null);

  // The key follows the name until the person types one; emptying the field hands it back to the name.
  const key = typedKey || slugifyBucketKey(name);

  const providers = useMemo(() => providersQuery.data ?? [], [providersQuery.data]);
  const provider = providers.find((candidate) => candidate.key === providerKey && isProviderUsable(candidate));

  // With a single provider to choose from there is nothing to decide: it is chosen once, when the list first arrives.
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !providersQuery.isSuccess) return;
    preselected.current = true;
    const usable = providersQuery.data.filter(isProviderUsable);
    if (usable.length === 1) setProviderKey(usable[0]!.key);
  }, [providersQuery.isSuccess, providersQuery.data]);

  // Back from the Providers area (a provider was added or switched on there): the cards are brought up to date.
  useEffect(() => {
    const refresh = () => {
      void refetchProviders();
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refetchProviders]);

  const nameFocused = useRef(false);
  const focusName = useCallback((element: HTMLInputElement | null) => {
    if (!element || nameFocused.current) return;
    nameFocused.current = true;
    element.focus();
  }, []);

  const nameIssue = bucketNameIssue(name);
  const keyIssue = bucketKeyIssue(key);
  const prefixIssue = bucketPrefixIssue(prefix);
  const folder = effectiveBucketPrefix(prefix, key);

  const providerReady = Boolean(provider);
  const identityReady = !nameIssue && !keyIssue;
  const prefixReady = !prefixIssue;
  const readyCount = [providerReady, identityReady, prefixReady].filter(Boolean).length;
  const canSubmit = readyCount === 3;

  // A field that is still empty is only called out once it was left (or the form was tried); a value that cannot
  // be right (a letter the key does not take, a path that climbs out of the provider) is called out as it is typed.
  const showName = touched.name || attempted;
  const showKey = touched.key || attempted;

  const clearFailure = (field: FailureField) => {
    setFailure((current) => (current && failureField(current) === field ? null : current));
  };

  const nameError = (() => {
    if (failure && failureField(failure) === 'name' && failure.kind === 'invalid') return failure.message;
    if (!nameIssue) return undefined;
    if (nameIssue === 'tooLong') return t('errors.nameTooLong', { max: BUCKET_NAME_MAX });
    return showName ? t('errors.nameRequired') : undefined;
  })();

  const keyError = (() => {
    if (failure?.kind === 'duplicateKey' && failure.key === key) return t('errors.keyTaken', { key });
    if (failure?.kind === 'invalid' && failure.field === 'key') return failure.message;
    if (!keyIssue) return undefined;
    // A name was given and nothing could be made of it as a key: say so now, the person has to type one.
    if (keyIssue === 'required') return showKey || name.trim() ? t('errors.keyRequired') : undefined;
    return keyIssue === 'invalid' ? t('errors.keyInvalid') : t('errors.keyTooLong', { max: BUCKET_KEY_MAX });
  })();

  const prefixError = (() => {
    if (failure?.kind === 'invalid' && failure.field === 'prefix') return failure.message;
    if (!prefixIssue) return undefined;
    return prefixIssue === 'invalid' ? t('errors.prefixInvalid') : t('errors.prefixTooLong', { max: BUCKET_PREFIX_MAX });
  })();

  const providerError = (() => {
    if (failure?.kind === 'providerUnusable') return t('errors.providerUnusable');
    if (failure?.kind === 'invalid' && failure.field === 'provider') return failure.message;
    if (attempted && !providerReady && providers.length > 0) return t('errors.providerRequired');
    return null;
  })();

  /** A refusal that is not about one field: told above the form. */
  const formError = (() => {
    if (!failure || failureField(failure) !== null) return null;
    switch (failure.kind) {
      case 'quota':
        return failure.message;
      case 'forbidden':
        return tCommon('errors.forbidden');
      case 'network':
        return tCommon('errors.network');
      case 'invalid':
        return failure.message;
      default:
        return failure.kind === 'other' && failure.message ? failure.message : t('errors.generic');
    }
  })();

  const submit = () => {
    setAttempted(true);
    setFailure(null);
    if (!canSubmit || !provider || createBucket.isPending) return;
    createBucket.mutate(
      buildCreateBucketInput({ providerKey: provider.key, name, key, description, prefix, active }),
      {
        onSuccess: (bucket) => {
          notifications.show({
            color: 'green',
            title: t('success.title'),
            message: t('success.message', { name: bucket.name }),
          });
          onCreated(bucket);
          onClose();
        },
        onError: (error) => {
          const next = classifyCreateFailure(error, key);
          setFailure(next);
          // The provider changed under the form (switched off, deleted): the cards are brought up to date.
          if (next.kind === 'providerUnusable') void refetchProviders();
        },
      },
    );
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const preview = storagePreview(provider, folder, t('location.fileKey'));

  const summary = (
    <>
      <SummaryGroup title={t('summary.bucketTitle')}>
        <SummaryKV label={t('summary.provider')} value={provider ? provider.label : <span className="ds-faint">—</span>} />
        <SummaryKV label={t('summary.key')} value={key || <span className="ds-faint">—</span>} mono />
        <SummaryKV label={t('summary.prefix')} value={folder || <span className="ds-faint">—</span>} mono />
        <SummaryKV
          label={t('summary.status')}
          value={active ? tCommon('bucketStatus.active') : tCommon('bucketStatus.disabled')}
        />
      </SummaryGroup>
      <SummaryGroup title={t('summary.readyTitle')}>
        <Checklist
          items={[
            { id: 'provider', label: t('summary.providerChosen'), done: providerReady },
            { id: 'identity', label: t('summary.nameAndKey'), done: identityReady },
            { id: 'prefix', label: t('summary.prefixValid'), done: prefixReady },
          ]}
        />
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open
      onClose={onClose}
      icon={<IconBucket size={16} />}
      title={t('title')}
      subtitle={t('subtitle')}
      summary={summary}
      footerStatus={t('summary.ready', { done: readyCount, total: 3 })}
      primaryAction={{
        label: t('actions.create'),
        icon: <IconCheck size={13} />,
        loading: createBucket.isPending,
        disabled: !canSubmit,
        onClick: submit,
      }}
    >
      {/* A form of its own so Enter in a field creates the bucket; the button in the footer does the same by click. */}
      <form onSubmit={onSubmit} noValidate aria-label={t('title')}>
        <button
          type="submit"
          tabIndex={-1}
          aria-hidden="true"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            margin: -1,
            padding: 0,
            border: 0,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
          }}
        >
          {t('actions.create')}
        </button>

        {formError ? (
          <Alert
            color="red"
            variant="light"
            icon={<IconAlertTriangle size={16} />}
            title={t('errors.title')}
            mb="lg"
          >
            {formError}
          </Alert>
        ) : null}

        <FormSection number={1} title={t('provider.title')} description={t('provider.description')} done={providerReady}>
          <ProviderSection
            query={providersQuery}
            value={providerKey}
            onChange={(next) => {
              setProviderKey(next);
              clearFailure('provider');
            }}
            canManageProviders={manageProviders}
            error={providerError}
          />
        </FormSection>

        <FormSection number={2} title={t('bucket.title')} description={t('bucket.description')} done={identityReady}>
          <div className="form-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' }}>
            <FormField label={t('bucket.nameLabel')} required>
              <TextInput
                ref={focusName}
                aria-label={t('bucket.nameLabel')}
                placeholder={t('bucket.namePlaceholder')}
                value={name}
                error={nameError}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  clearFailure('name');
                }}
                onBlur={() => setTouched((current) => ({ ...current, name: true }))}
              />
            </FormField>
            <FormField label={t('bucket.keyLabel')} required hint={t('bucket.keyHint')}>
              <TextInput
                aria-label={t('bucket.keyLabel')}
                placeholder={t('bucket.keyPlaceholder')}
                value={key}
                error={keyError}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                styles={{ input: { fontFamily: 'var(--font-mono)' } }}
                onChange={(event) => {
                  setTypedKey(normalizeKeyInput(event.currentTarget.value));
                  clearFailure('key');
                }}
                onBlur={() => setTouched((current) => ({ ...current, key: true }))}
              />
            </FormField>
          </div>
          <div className="form-row" style={{ gridTemplateColumns: '1fr' }}>
            <FormField
              label={
                <>
                  {t('bucket.descriptionLabel')}
                  <span className="ds-faint" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                    {' · '}
                    {t('optional')}
                  </span>
                </>
              }
            >
              <Textarea
                aria-label={t('bucket.descriptionLabel')}
                placeholder={t('bucket.descriptionPlaceholder')}
                minRows={2}
                autosize
                value={description}
                onChange={(event) => setDescription(event.currentTarget.value)}
              />
            </FormField>
          </div>
        </FormSection>

        <FormSection number={3} title={t('location.title')} description={t('location.description')} done={prefixReady}>
          <div className="form-row" style={{ gridTemplateColumns: '1fr' }}>
            <FormField
              label={
                <>
                  {t('location.prefixLabel')}
                  <span className="ds-faint" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                    {' · '}
                    {t('optional')}
                  </span>
                </>
              }
              hint={t('location.prefixHint')}
            >
              <TextInput
                aria-label={t('location.prefixLabel')}
                placeholder={key || t('bucket.keyPlaceholder')}
                value={prefix}
                error={prefixError}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                styles={{ input: { fontFamily: 'var(--font-mono)' } }}
                onChange={(event) => {
                  setPrefix(event.currentTarget.value);
                  clearFailure('prefix');
                }}
              />
            </FormField>
          </div>
          <div className="form-field">
            <div className="form-field-label">
              <span>{t('location.previewTitle')}</span>
            </div>
            <div
              className="ds-card ds-card-pad-sm"
              style={{ background: 'var(--ds-surface-1)' }}
              aria-live="polite"
            >
              {preview.kind === 'path' ? (
                <StorageLocation location={preview.example} copyable={false} />
              ) : preview.kind === 'localDisk' ? (
                <StorageLocation location={null} />
              ) : (
                <span className="ds-faint" style={{ fontSize: 13 }}>
                  {preview.kind === 'unknown' ? t('location.unknown') : t('location.choose')}
                </span>
              )}
            </div>
          </div>
        </FormSection>

        <FormSection number={4} title={t('status.title')} description={t('status.description')} done>
          <ToggleList>
            <ToggleRow
              label={t('status.activeLabel')}
              description={t('status.activeDescription')}
              checked={active}
              onChange={setActive}
            />
          </ToggleList>
        </FormSection>
      </form>
    </FormShell>
  );
}
