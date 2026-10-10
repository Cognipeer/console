'use client';

/**
 * The directory-managed experience: an account that comes from LDAP or single
 * sign-on has its name, email and password kept in the directory, so those
 * inputs are read-only here (the server refuses the write as well, with
 * `directory_managed`; the lock is a courtesy that says why).
 */

import type { ReactNode } from 'react';
import { Alert, TextInput, Tooltip } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { translateOr, type Translate } from './format';

/** Display name of an account source: Local, LDAP, SSO (OIDC), SSO (SAML). */
export function providerLabel(t: Translate, provider: string | null | undefined): string {
  const key = provider && provider !== '' ? provider : 'local';
  return translateOr(t, 'iamDirectory', `badges.sources.${key}`, key);
}

/** Says which fields the directory owns. `provider` is the account's source (ldap, oidc, saml). */
export function ManagedBanner({ provider, fields }: { provider: string | null | undefined; fields?: ReactNode }) {
  const t = useTranslations('iamDirectory');
  return (
    <Alert color="blue" variant="light" icon={<IconLock size={16} />} title={t('managed.title')} data-testid="managed-banner">
      {t('managed.body', { provider: providerLabel(t, provider) })}
      {fields ? <> {fields}</> : null}
    </Alert>
  );
}

interface LockedFieldProps {
  label: ReactNode;
  value: string;
  provider: string | null | undefined;
  /** Rendered as the input; defaults to a plain text input. */
  type?: 'text' | 'email';
}

/** A read-only input with a tooltip: "Managed by <provider>; change it in your directory". */
export function LockedField({ label, value, provider, type = 'text' }: LockedFieldProps) {
  const t = useTranslations('iamDirectory');
  return (
    <Tooltip label={t('managed.fieldHint', { provider: providerLabel(t, provider) })} withArrow multiline w={260}>
      <div>
        <TextInput
          label={label}
          type={type}
          value={value}
          readOnly
          disabled
          leftSection={<IconLock size={14} />}
          data-testid="locked-field"
        />
      </div>
    </Tooltip>
  );
}
