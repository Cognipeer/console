'use client';

import { useEffect, useMemo, useState } from 'react';
import { TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconMail, IconUser, IconUserEdit } from '@tabler/icons-react';
import FormShell, {
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { DirectoryApiError, directoryApi } from './directoryApi';
import { FormError } from './errors';
import { LockedField, ManagedBanner } from './managed';

export interface ProfileTarget {
  id: string;
  name: string;
  email: string;
  /** A service account has no sign-in address: the email is optional. */
  canLogin: boolean;
  /** Name and email live in a directory (LDAP, SSO): read-only here. */
  managed: boolean;
  provider: string | null;
}

interface EditProfileShellProps {
  open: boolean;
  person: ProfileTarget | null;
  onClose: () => void;
  /** Called after a successful save with the fields that changed. */
  onSaved: (changed: string[]) => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The fields of a profile form that differ from the stored ones (only these are sent). */
export function profilePatch(
  stored: { name: string; email: string },
  draft: { name: string; email: string },
): { name?: string; email?: string } {
  const patch: { name?: string; email?: string } = {};
  const name = draft.name.trim();
  const email = draft.email.trim();
  if (name !== stored.name) patch.name = name;
  if (email !== stored.email) patch.email = email;
  return patch;
}

/** Name and email of a person. Only the fields that changed are sent; a directory account is read-only. */
export default function EditProfileShell({ open, person, onClose, onSaved }: EditProfileShellProps) {
  const t = useTranslations('iamDirectory');
  const tCommon = useTranslations('common');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const personId = person?.id;
  useEffect(() => {
    if (!person) return;
    setName(person.name);
    setEmail(person.email);
    setError(null);
    setSaving(false);
    // Re-seed only when another person is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, open]);

  const patch = useMemo(
    () => (person ? profilePatch(person, { name, email }) : {}),
    [person, name, email],
  );
  const changed = Object.keys(patch);

  if (!person) return null;

  const nameValid = name.trim().length >= 2 && name.trim().length <= 120;
  const trimmedEmail = email.trim();
  const emailValid = person.canLogin
    ? EMAIL_PATTERN.test(trimmedEmail)
    : trimmedEmail === '' || EMAIL_PATTERN.test(trimmedEmail);
  const canSave = !person.managed && changed.length > 0 && nameValid && emailValid && !saving;
  const emailTaken = error instanceof DirectoryApiError && error.code === 'email_taken';

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const result = await directoryApi.patchUser(person.id, patch);
      notifications.show({ title: tCommon('success'), message: t('profile.saved'), color: 'green' });
      onSaved(result.changed.length > 0 ? result.changed : changed);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const summary = (
    <SummaryGroup title={t('profile.summary')}>
      <SummaryKV label={t('profile.name')} value={name.trim() || <span className="ds-faint">—</span>} />
      <SummaryKV label={t('profile.email')} value={trimmedEmail || <span className="ds-faint">—</span>} />
      <SummaryKV
        label={t('profile.changes')}
        value={changed.length === 0 ? t('profile.noChanges') : changed.map((c) => t(`profile.${c}`)).join(', ')}
      />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={open}
      onClose={onClose}
      icon={<IconUserEdit size={16} />}
      title={t('profile.title', { name: person.name || person.email })}
      subtitle={t('profile.subtitle')}
      summary={summary}
      disableEscape={saving}
      primaryAction={{
        label: t('profile.save'),
        loading: saving,
        disabled: !canSave,
        onClick: () => void save(),
      }}
      secondaryAction={{ label: t('common.cancel'), onClick: onClose, disabled: saving }}
    >
      {person.managed ? <ManagedBanner provider={person.provider} /> : null}
      <FormSection number={1} title={t('profile.section')} description={t('profile.sectionHint')} done={nameValid && emailValid}>
        <FormRow cols={2}>
          {person.managed ? (
            <LockedField label={t('profile.name')} value={person.name} provider={person.provider} />
          ) : (
            <FormField label={t('profile.name')} required>
              <TextInput
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                leftSection={<IconUser size={16} />}
                error={name !== '' && !nameValid ? t('profile.nameInvalid') : undefined}
                maxLength={120}
              />
            </FormField>
          )}
          {person.managed ? (
            <LockedField label={t('profile.email')} value={person.email} provider={person.provider} type="email" />
          ) : (
            <FormField label={t('profile.email')} required={person.canLogin} optional={!person.canLogin}>
              <TextInput
                type="email"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                leftSection={<IconMail size={16} />}
                error={
                  emailTaken
                    ? t('errors.email_taken')
                    : trimmedEmail !== '' && !EMAIL_PATTERN.test(trimmedEmail)
                      ? t('profile.emailInvalid')
                      : undefined
                }
              />
            </FormField>
          )}
        </FormRow>
      </FormSection>
      {error && !emailTaken ? <FormError error={error} t={t} /> : null}
    </FormShell>
  );
}
